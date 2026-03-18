const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const basra = require('./basra-server');
const basraRooms = {}; // separate room store for basra
// Fix TLS for Node.js v22
process.env.NODE_OPTIONS = process.env.NODE_OPTIONS || '';

// ══ COINS: settle bets at end of game ══
async function settleCoins(room) {
    console.log(`[settleCoins] called. bet=${room.bet}, settled=${room.coinsSettled}, order=${room.winnersOrder}`);
    if (room.coinsSettled || room.bet === 0) { console.log('[settleCoins] skipped.'); return; }
    room.coinsSettled = true;
    const bet = room.bet;

    // Only consider HUMAN players (non-bots) for coin settlement
    const order = room.winnersOrder.filter(i => !room.slots[i]?.isBot || room.slots[i]?.wasHuman);
    const n = order.length;
    if (n < 2) { console.log('[settleCoins] not enough human players'); return; }

    // Find human winner (1st) and human loser (last)
    // order[0] = best human, order[n-1] = worst human
    const changes = {};
    order.forEach(i => { changes[i] = 0; });

    // 2-player or 3-player: winner takes bet from loser
    changes[order[0]]   += bet;
    changes[order[n-1]] -= bet;

    // 4-player: 2nd takes half from 3rd
    if (n >= 4) {
        const half = Math.floor(bet / 2);
        changes[order[1]] += half;
        changes[order[2]] -= half;
    }

    console.log(`[settleCoins] human order=${order} n=${n} changes=${JSON.stringify(changes)}`);

    // Build results for ALL slots in winnersOrder (bots get delta=0)
    const results = [];
    for (const slotIdx of room.winnersOrder) {
        const slot = room.slots[slotIdx];
        const delta = changes[slotIdx] || 0;
        let finalCoins = null;
        if (slot.username && (!slot.isBot || slot.wasHuman)) {
            try {
                const u = await getUser(slot.username);
                if (u) {
                    finalCoins = Math.max(0, (u.coins || 0) + delta);
                    await saveUser(slot.username, { coins: finalCoins });
                    console.log(`[coins] ${slot.username}: ${u.coins} ${delta >= 0 ? '+' : ''}${delta} = ${finalCoins}`);
                }
            } catch(e) { console.error('[coins] error:', e.message); }
        }
        results.push({ name: slot.name, delta, coins: finalCoins, slotIdx });
    }
    console.log(`[coins] settled. bet=${bet}`);
    io.to(room.code).emit('coinsResult', results);
}


async function settleBasraCoins(room, winnerSlotIdx) {
    console.log(`[settleBasra] called bet=${room.bet} settled=${room.coinsSettled} winner=${winnerSlotIdx} usernames=${JSON.stringify(room.slots.map(s=>s.username))}`);
    if (room.coinsSettled || !room.bet || room.bet === 0) return;
    room.coinsSettled = true;
    const bet = room.bet;
    const results = [];

    // Determine deltas
    let deltas;
    if (room.teams) {
        // 4p team mode: find winning team
        const winnerTeam = room.teams.find(t => t.includes(winnerSlotIdx));
        deltas = room.slots.map((_, i) => winnerTeam && winnerTeam.includes(i) ? bet : -bet);
    } else {
        deltas = room.slots.map((_, i) => i === winnerSlotIdx ? bet : -bet);
    }

    for (let i = 0; i < room.slots.length; i++) {
        const slot = room.slots[i];
        const delta = deltas[i];
        let finalCoins = null;
        if (slot.username) {
            try {
                const u = await getUser(slot.username);
                if (u) {
                    finalCoins = Math.max(0, (u.coins || 0) + delta);
                    await saveUser(slot.username, { coins: finalCoins });
                    console.log(`[basra coins] ${slot.username}: ${delta>=0?'+':''}${delta} = ${finalCoins}`);
                }
            } catch(e) { console.error('[basra coins] error:', e.message); }
        }
        results.push({ name: slot.name, delta, coins: finalCoins, slotIdx: i });
    }
    room.slots.forEach(s => {
        if (s.socketId) io.to(s.socketId).emit('coinsResult', results);
    });
}

function buildDisplayName(first, last) {
    first = (first || '').trim();
    last  = (last  || '').trim();
    if (!first) return last || '';
    if (!last)  return first;
    const initial = [...last][0].toUpperCase();
    return `${first}.${initial}.`;
}

// ══════════════════════════════════════════════
//  MONGODB
// ══════════════════════════════════════════════
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://shithead_user:Mickar87@cluster0.kiznwpz.mongodb.net/?appName=Cluster0&tls=true&tlsAllowInvalidCertificates=false';
const mongoClient = new MongoClient(MONGO_URI, {
    tls: true,
    tlsAllowInvalidCertificates: false,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
});
let usersCol = null;

async function connectMongo(retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            await mongoClient.connect();
            const db = mongoClient.db('shithead');
            usersCol = db.collection('users');
            await usersCol.createIndex({ username: 1 }, { unique: true });
            console.log('[mongo] Connected to MongoDB Atlas ✅');
            return true;
        } catch(e) {
            console.error(`[mongo] Connection attempt ${i+1} failed: ${e.message}`);
            if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
        }
    }
    console.error('[mongo] All connection attempts failed!');
    return false;
}

async function getUser(username) {
    if (!usersCol) return null;
    return usersCol.findOne({ username });
}

async function saveUser(username, data) {
    if (!usersCol) { console.error('[saveUser] no DB connection!'); return; }
    const result = await usersCol.updateOne({ username }, { $set: data }, { upsert: true });
    console.log(`[saveUser] ${username} fields=${Object.keys(data).join(',')} matched=${result.matchedCount}`);
}

async function updateCoins(username, delta) {
    if (!usersCol) return null;
    const result = await usersCol.findOneAndUpdate(
        { username },
        { $inc: { coins: delta } },
        { returnDocument: 'after' }
    );
    // Ensure coins don't go below 0
    if (result && result.coins < 0) {
        await usersCol.updateOne({ username }, { $set: { coins: 0 } });
        result.coins = 0;
    }
    return result;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════
//  USERS — MongoDB persistent coin system
// ══════════════════════════════════════════════
const STARTING_COINS = 2000;
const DAILY_COINS = 200;

function hashPin(pin) {
    return crypto.createHash('sha256').update('shithead_salt_' + pin).digest('hex');
}

function makeToken() {
    return crypto.randomBytes(32).toString('hex');
}

// HTTP endpoints for auth
app.use(express.json());

app.post('/api/register', async (req, res) => {
    try {
        const { username, pin, firstName, lastName } = req.body;
        if (!username || !pin) return res.json({ ok: false, error: 'חסר שם משתמש או PIN' });
        const name = username.trim().toLowerCase();
        if (name.length < 2 || name.length > 16) return res.json({ ok: false, error: 'שם משתמש 2-16 תווים' });
        if (pin.length !== 4 || !/^[0-9]{4}$/.test(pin)) return res.json({ ok: false, error: 'PIN חייב להיות 4 ספרות' });
        const first = (firstName || '').trim();
        if (!first) return res.json({ ok: false, error: 'חסר שם פרטי' });
        const existing = await getUser(name);
        if (existing) return res.json({ ok: false, error: 'שם משתמש תפוס' });
        const token = makeToken();
        const last = (lastName || '').trim();
        await saveUser(name, { username: name, pinHash: hashPin(pin), coins: STARTING_COINS, lastDailyTs: null, token, firstName: first, lastName: last });
        const displayName = buildDisplayName(first, last);
        res.json({ ok: true, username: name, token, coins: STARTING_COINS, firstName: first, lastName: last, displayName });
    } catch(e) { res.json({ ok: false, error: 'שגיאת שרת' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, pin } = req.body;
        const name = username?.trim().toLowerCase();
        const u = await getUser(name);
        if (!u) return res.json({ ok: false, error: 'שם משתמש לא קיים' });
        if (u.pinHash !== hashPin(pin)) return res.json({ ok: false, error: 'PIN שגוי' });
        // Keep existing token if valid, only create new one if missing
        const token = u.token || makeToken();
        if (!u.token) await saveUser(name, { token });
        console.log(`[login] ${name} token=${u.token ? 'existing' : 'new'}`);
        const displayName = buildDisplayName(u.firstName||'', u.lastName||'');
        res.json({ ok: true, username: name, token, coins: u.coins, firstName: u.firstName||'', lastName: u.lastName||'', displayName });
    } catch(e) { res.json({ ok: false, error: 'שגיאת שרת' }); }
});

app.post('/api/verify', async (req, res) => {
    try {
        const { username, token } = req.body;
        const name = username?.trim().toLowerCase();
        const u = await getUser(name);
        console.log(`[verify] user=${name} found=${!!u} tokenMatch=${u?.token === token} dbToken=${u?.token?.slice(0,8)} reqToken=${token?.slice(0,8)}`);
        if (!u || u.token !== token) return res.json({ ok: false });
        await saveUser(name, { lastSeenTs: Date.now() });
        const displayName = buildDisplayName(u.firstName||'', u.lastName||'');
        res.json({ ok: true, username: name, coins: u.coins, firstName: u.firstName||'', lastName: u.lastName||'', displayName });
    } catch(e) { console.error('[verify error]', e); res.json({ ok: false }); }
});

app.post('/api/daily', async (req, res) => {
    try {
        const { username, token } = req.body;
        const name = username?.trim().toLowerCase();
        const u = await getUser(name);
        if (!u || u.token !== token) return res.json({ ok: false, error: 'לא מחובר' });
        const now = Date.now();
        const last = u.lastDailyTs || 0;
        const msLeft = (last + 24 * 60 * 60 * 1000) - now;
        if (msLeft > 0) return res.json({ ok: false, error: 'כבר קיבלת מטבעות', coins: u.coins, msLeft });
        const newCoins = (u.coins || 0) + DAILY_COINS;
        await saveUser(name, { coins: newCoins, lastDailyTs: now });
        res.json({ ok: true, coins: newCoins, gained: DAILY_COINS, msLeft: 24 * 60 * 60 * 1000 });
    } catch(e) { console.error('[daily]', e); res.json({ ok: false, error: 'שגיאת שרת' }); }
});

// Update profile (name + optional new PIN)
app.post('/api/update-profile', async (req, res) => {
    try {
        const { username, token, firstName, lastName, newPin } = req.body;
        const name = username?.trim().toLowerCase();
        const u = await getUser(name);
        if (!u || u.token !== token) return res.json({ ok: false, error: 'לא מחובר' });
        const first = (firstName || '').trim();
        if (!first) return res.json({ ok: false, error: 'שם פרטי חובה' });
        if (newPin && (newPin.length !== 4 || !/^[0-9]{4}$/.test(newPin)))
            return res.json({ ok: false, error: 'PIN חייב להיות 4 ספרות' });
        const updates = { firstName: first, lastName: (lastName || '').trim() };
        if (newPin) updates.pinHash = hashPin(newPin);
        await saveUser(name, updates);
        console.log(`[update-profile] ${name} updated name+${newPin ? 'pin' : 'no-pin'}`);
        res.json({ ok: true });
    } catch(e) { console.error('[update-profile]', e); res.json({ ok: false, error: 'שגיאת שרת' }); }
});

// Check daily status
app.post('/api/daily-status', async (req, res) => {
    try {
        const { username, token } = req.body;
        const name = username?.trim().toLowerCase();
        const u = await getUser(name);
        if (!u || u.token !== token) return res.json({ ok: false });
        const now = Date.now();
        const last = u.lastDailyTs || 0;
        const msLeft = Math.max(0, (last + 24 * 60 * 60 * 1000) - now);
        res.json({ ok: true, msLeft, coins: u.coins });
    } catch(e) { res.json({ ok: false }); }
});


// Health check
app.get('/api/health', (req, res) => {
    res.json({ ok: true, mongo: !!usersCol, time: new Date().toISOString() });
});

// Debug: check specific user raw data
app.get('/api/debug/user', async (req, res) => {
    const key = req.query.key;
    const username = req.query.u;
    if (key !== 'shithead_admin_2026') return res.status(403).json({ error: 'Forbidden' });
    try {
        const u = await getUser(username);
        if (!u) return res.json({ found: false });
        res.json({ found: true, username: u.username, coins: u.coins, hasToken: !!u.token, tokenStart: u.token?.slice(0,12), firstName: u.firstName, lastName: u.lastName });
    } catch(e) { res.json({ error: e.message }); }
});

// Admin: set coins for a user
app.get('/api/admin/set-coins', async (req, res) => {
    try {
        const { key, u, coins } = req.query;
        if (key !== 'shithead_admin_2026') return res.status(403).json({ error: 'Forbidden' });
        const amount = parseInt(coins);
        if (isNaN(amount) || amount < 0) return res.json({ error: 'Invalid coins value' });
        const user = await getUser(u);
        if (!user) return res.json({ error: `User "${u}" not found` });
        await saveUser(u, { coins: amount });
        res.json({ ok: true, username: u, coins: amount });
    } catch(e) { res.json({ error: e.message }); }
});

// Admin: delete user
app.get('/api/admin/delete-user', async (req, res) => {
    try {
        const { key, u } = req.query;
        if (key !== 'shithead_admin_2026') return res.status(403).json({ error: 'Forbidden' });
        const result = await usersCol.deleteOne({ username: u });
        res.json({ ok: result.deletedCount > 0, username: u });
    } catch(e) { res.json({ error: e.message }); }
});

// Admin: view all users (protected by secret key)
app.get('/api/admin/users', async (req, res) => {
    try {
        const key = req.query.key;
        if (key !== 'shithead_admin_2026') return res.status(403).json({ error: 'Forbidden' });
        const allUsers = await usersCol.find({}, { projection: { pinHash: 0, token: 0 } }).toArray();
        const sorted = allUsers.sort((a, b) => (b.coins || 0) - (a.coins || 0));

        // Build connected users set from all sources
        const connectedUsernames = new Set();
        // Shithead rooms: connected human slots
        Object.values(rooms).forEach(r => r.slots && r.slots.forEach(sl => {
            if (sl.username && sl.connected && !sl.isBot) connectedUsernames.add(sl.username);
        }));
        // Basra rooms: slots with live socketId
        Object.values(basraRooms).forEach(r => r.slots.forEach(sl => {
            if (sl.username && sl.socketId && io.sockets.sockets.has(sl.socketId)) {
                connectedUsernames.add(sl.username);
            }
        }));
        // Any socket with explicit username
        for (const [, sock] of io.sockets.sockets) {
            if (sock.data?.username) connectedUsernames.add(sock.data.username);
        }


        // Build room map: username -> room code
        const userRoomMap = {};
        Object.values(rooms).forEach(r => r.slots && r.slots.forEach(sl => {
            if (sl.username && sl.connected && !sl.isBot) userRoomMap[sl.username] = 'SH:' + r.code;
        }));
        Object.values(basraRooms).forEach(r => r.slots.forEach(sl => {
            if (sl.username && sl.socketId && io.sockets.sockets.has(sl.socketId)) userRoomMap[sl.username] = 'BS:' + r.code;
        }));

        const rows = sorted.map((u, i) => {
            const isOnline = connectedUsernames.has(u.username);
            const lastSeen = u.lastSeenTs ? new Date(u.lastSeenTs).toLocaleString('he-IL') : '—';
            const roomInfo = userRoomMap[u.username] || '—';
            return `
            <tr style="border-bottom:1px solid #333">
                <td style="padding:8px;text-align:center">${i+1}</td>
                <td style="padding:8px"><b>${u.username}</b></td>
                <td style="padding:8px">${u.firstName || ''} ${u.lastName || ''}</td>
                <td style="padding:8px;text-align:center">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${isOnline?'#22c55e':'#555'};margin-left:6px"></span>
                    ${isOnline ? '<span style="color:#22c55e">מחובר</span>' : '<span style="color:#555">לא מחובר</span>'}
                </td>
                <td style="padding:8px;text-align:center;font-family:monospace;font-size:12px;color:${roomInfo!=='—'?'#fbbf24':'#555'}">${roomInfo}</td>
                <td style="padding:8px;text-align:center">${lastSeen}</td>
                <td style="padding:8px;text-align:center">
                    <span style="display:flex;align-items:center;gap:4px;justify-content:center">
                        <input id="coins_${u.username}" type="number" value="${u.coins||0}" style="width:80px;padding:4px;background:#1a3a2a;border:1px solid #444;color:#fff;border-radius:4px;text-align:center">
                        <button onclick="setCoins('${u.username}')" style="padding:4px 10px;background:#16a34a;border:none;color:#fff;border-radius:4px;cursor:pointer">✓</button>
                    </span>
                </td>
                <td style="padding:8px;text-align:center">
                    <button onclick="deleteUser('${u.username}')" style="padding:4px 10px;background:#dc2626;border:none;color:#fff;border-radius:4px;cursor:pointer">🗑 מחק</button>
                </td>
            </tr>`;
        }).join('');

        res.send(`<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="utf-8"><title>Admin — משתמשים</title>
<style>
  body{font-family:sans-serif;background:#0a1a0d;color:#fff;padding:20px;margin:0}
  h2{color:gold;margin-bottom:16px}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th{background:#1a4a2a;padding:10px;text-align:right;position:sticky;top:0}
  tr:hover{background:rgba(255,255,255,0.05)}
  .stats{display:flex;gap:20px;margin-bottom:16px}
  .stat{background:#1a3a2a;padding:10px 16px;border-radius:8px;font-size:13px}
  .stat span{color:gold;font-size:18px;font-weight:700;display:block}
</style>
<script>
const KEY = '${key}';
async function setCoins(u) {
    const coins = document.getElementById('coins_' + u).value;
    const r = await fetch('/api/admin/set-coins?key=' + KEY + '&u=' + u + '&coins=' + coins);
    const d = await r.json();
    if (d.ok) { alert('✅ עודכן ל-' + coins + ' מטבעות'); }
    else alert('❌ ' + JSON.stringify(d));
}
async function deleteUser(u) {
    if (!confirm('למחוק את המשתמש ' + u + '?')) return;
    const r = await fetch('/api/admin/delete-user?key=' + KEY + '&u=' + u);
    const d = await r.json();
    if (d.ok) { location.reload(); }
    else alert('❌ ' + JSON.stringify(d));
}
</script>
</head>
<body>
<h2>🃏 SHITHEAD — ניהול משתמשים</h2>
<div class="stats">
  <div class="stat"><span>${sorted.length}</span>סה"כ משתמשים</div>
  <div class="stat"><span style="color:#22c55e">${connectedUsernames.size}</span>מחוברים כעת</div>
  <div class="stat"><span>${sorted.reduce((s,u)=>s+(u.coins||0),0).toLocaleString()} 🪙</span>סה"כ מטבעות</div>
</div>
<table>
<tr><th>#</th><th>שם משתמש</th><th>שם מלא</th><th>סטטוס</th><th>חדר</th><th>חיבור אחרון</th><th>מטבעות</th><th>פעולות</th></tr>
${rows}
</table>
</body></html>`);
    } catch(e) { res.json({ error: e.message }); }
});
// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
const rooms = {};
const disconnectTimers = {}; // roomCode → room object
const roomTimers = {}; // roomCode → interval

function clearRoomTimer(code) {
    if (roomTimers[code]) { clearInterval(roomTimers[code]); delete roomTimers[code]; }
}


function findStarter(slots) {
    const customSort = ['4','5','6','7','8','9','J','Q','K','A','2','3','10'];
    let minRank = 99;
    slots.forEach(p => p.hand.forEach(c => {
        const v = customSort.indexOf(c.slice(0,-1));
        if (v < minRank) minRank = v;
    }));
    const minRankStr = customSort[minRank];
    const candidates = slots.filter(p => p.hand.some(c => c.slice(0,-1) === minRankStr));
    if (candidates.length === 1) return candidates[0].id;
    const maxCount = Math.max(...candidates.map(p => p.hand.filter(c => c.slice(0,-1) === minRankStr).length));
    const withPair = candidates.filter(p => p.hand.filter(c => c.slice(0,-1) === minRankStr).length === maxCount);
    return withPair[Math.floor(Math.random() * withPair.length)].id;
}
function startSwapTimer(room) {
    const key = room.code + '_swap';
    clearRoomTimer(key);
    // Reset swap tracking fresh at start of each swap phase
    room.swapDoneCount = 0;
    room.slots.forEach(s => { s._swapDone = false; });
    let remaining = 40;
    broadcast(room, 'swapTick', { remaining });

    roomTimers[key] = setInterval(() => {
        remaining--;
        broadcast(room, 'swapTick', { remaining });
        if (remaining <= 0) {
            clearRoomTimer(key);
            // Auto-end swap for all players who haven't ended yet
            room.slots.forEach(s => { if (s.connected) s._swapDone = true; });
            const starter = findStarter(room.slots);
            room.isSwapPhase = false;
            room.gameStarted = true;
            room.swapDoneCount = 0;
            room.currentPlayer = starter;
            broadcast(room, 'swapTick', { remaining: 0 }); // hide timer on all clients
            broadcast(room, 'toast', `⏰ זמן ההחלפה נגמר! ${room.slots[starter].name} ראשון`);
            emitStateToAll(room);
            startTurnTimer(room);
        }
    }, 1000);
}

function startTurnTimer(room) {
    clearRoomTimer(room.code);
    if (!room.turnTimer || room.turnTimer === 0 || room.isSwapPhase || room.gameOver) return;

    let remaining = room.turnTimer;
    // Broadcast initial tick
    broadcast(room, 'timerTick', { remaining, currentPlayer: room.currentPlayer });

    roomTimers[room.code] = setInterval(() => {
        remaining--;
        broadcast(room, 'timerTick', { remaining, currentPlayer: room.currentPlayer });
        if (remaining <= 0) {
            clearRoomTimer(room.code);
            // Auto-take pile for current player
            const autoSlot = room.currentPlayer;
            const p = room.slots[autoSlot];
            if (p && !p.finished) {
                p.consecutiveTimeouts = (p.consecutiveTimeouts || 0) + 1;
                const customSort = ['4','5','6','7','8','9','J','Q','K','A','2','3','10'];

                // Disqualify after 2 consecutive timeouts
                if (p.consecutiveTimeouts >= 2) {
                    broadcast(room, 'toast', `⏰ ${p.name} לא שיחק — מוכרז כמפסיד`);
                    p.disqualified = true;
                    p.finished = true;
                    room.winnersOrder.push(autoSlot);

                    const active = room.slots.filter(s => !s.finished);
                    if (active.length <= 1) {
                        if (active.length === 1) {
                            active[0].finished = true;
                            room.winnersOrder.unshift(active[0].id);
                        }
                        room.gameOver = true;
                        clearRoomTimer(room.code);
                        broadcast(room, 'gameOver', room.winnersOrder.map(i => room.slots[i]?.name || '?'));
                        setTimeout(() => settleCoins(room).catch(e => console.error('[coins error]', e.message)), 300);
                    } else {
                        // Replace with bot
                        p.isBot = true;
                        p.finished = false;
                        room.winnersOrder.pop();
                        const origName = p.name;
                        p.name = `🤖 ${origName}`;
                        broadcast(room, 'toast', `🤖 מחשב ממשיך במקום ${origName}`);
                        emitStateToAll(room);
                        if (room.currentPlayer === autoSlot) {
                            setTimeout(() => { if (rooms[room.code]) doBotTurn(room); }, 800);
                        } else {
                            nextTurn(room);
                        }
                    }
                    return;
                }

                if (room.pile.length === 0 && p.hand.length > 0) {
                    const valid = p.hand.filter(c => canPlay(c, room.pile));
                    const pool = valid.length > 0 ? valid : p.hand;
                    pool.sort((a,b) => customSort.indexOf(a.slice(0,-1)) - customSort.indexOf(b.slice(0,-1)));
                    const card = pool[0];
                    p.hand = p.hand.filter(c => c !== card);
                    broadcast(room, 'toast', `⏰ זמן נגמר! ${p.name} שיחק ${card.slice(0,-1)} אוטומטית`);
                    executeMove(room, room.currentPlayer, [card]);
                } else {
                    broadcast(room, 'toast', `⏰ זמן נגמר! ${p.name} לוקח את הערימה`);
                    if (p.hand.length === 0 && p.faceUp.some(Boolean)) {
                        const best = p.faceUp.find(Boolean);
                        const idx = p.faceUp.indexOf(best);
                        if (idx !== -1) { p.hand.push(best); p.faceUp[idx] = null; }
                    }
                    p.hand.push(...room.pile);
                    room.pile = [];
                    nextTurn(room);
                }
            }
        }
    }, 1000);
}

function makeCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

const RANKS   = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS   = ['♠','♥','♦','♣'];
const SPECIAL = new Set(['2','3','10']);

function makeDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push(r + s);
    return d.sort(() => Math.random() - 0.5);
}

function getEffectiveTop(pile) {
    for (let i = pile.length - 1; i >= 0; i--) {
        if (pile[i].slice(0, -1) !== '3') return pile[i];
    }
    return null;
}

function canPlay(card, pile) {
    if (!card) return false;
    const r = card.slice(0, -1);
    if (['2', '3', '10'].includes(r)) return true;
    const top = getEffectiveTop(pile);
    if (!top) return true;
    const topR = top.slice(0, -1);
    if (topR === '2') return true;
    const v = RANKS.indexOf(r), tv = RANKS.indexOf(topR);
    return topR === '7' ? v <= tv : v >= tv;
}

function restartRoom(room) {
    const deck = makeDeck();
    room.slots = room.slots.map((s, i) => ({
        id: i,
        name: s.name,
        socketId: s.socketId,
        username: s.username || null,  // preserve username across restarts
        hand: deck.splice(0, 3),
        faceUp: deck.splice(0, 3),
        faceDown: deck.splice(0, 3),
        finished: false,
        connected: s.connected,
        consecutiveTimeouts: 0,
        _swapDone: false,
        isBot: false,
    }));
    room.drawPile = deck;
    room.pile = [];
    room.currentPlayer = 0;
    room.isSwapPhase = true;
    room.winnersOrder = [];
    room.leaversOrder = []; // first leaver = last place
    room.gameOver = false;
    room.coinsSettled = false;  // allow new settlement
    room.interruptWindow = false;
    room.lastPlayedRank = null;
    room.lastPlayerIdx = null;
    room.restartVotes = new Set();
    room.swapDoneCount = 0;
    clearRoomTimer(room.code);
    clearRoomTimer(room.code + '_swap');
    console.log(`[restartRoom] slots:`, room.slots.map(s=>({name:s.name,socketId:!!s.socketId,connected:s.connected,_swapDone:s._swapDone})));
}

function createRoom(hostSocketId, hostName, playerCount, bet=0) {
    const code = makeCode();
    const deck = makeDeck();
    const slots = Array.from({ length: playerCount }, (_, i) => ({
        id: i,
        name: null,
        socketId: null,
        username: null, // registered username (null = guest)
        hand: deck.splice(0, 3),
        faceUp: deck.splice(0, 3),
        faceDown: deck.splice(0, 3),
        finished: false,
        connected: false,
        consecutiveTimeouts: 0,
    }));
    rooms[code] = {
        code,
        playerCount,
        slots,
        drawPile: deck,
        pile: [],
        currentPlayer: 0,
        isSwapPhase: true,
        winnersOrder: [],
        leaversOrder: [],
        gameOver: false,
        started: false,
        hostSocketId,
        interruptWindow: false,
        lastPlayedRank: null,
        lastPlayerIdx: null,
        burnInterrupt: {},
        bet: bet || 0,        // coins per player
        coinsSettled: false,  // prevent double-settle
    };
    return code;
}
// ══ COINS: settle bets at end of game ══
// winnersOrder[0]=1st, [last]=loser




// ── Send state to a specific player (only their cards) ──
function emitStateToPlayer(room, slotIdx) {
    const slot = room.slots[slotIdx];
    if (!slot.socketId) return;

    const allJoined = room.slots.every(s => s.connected);
    const state = {
        myIdx: slotIdx,
        myHand: slot.hand,
        myFaceUp: slot.faceUp,
        myFaceDown: slot.faceDown,
        currentPlayer: room.currentPlayer,
        isSwapPhase: room.isSwapPhase,
        pile: room.pile,
        drawPileCount: room.drawPile.length,
        winnersOrder: room.winnersOrder,
        gameOver: room.gameOver,
        allJoined,
        isPublic: room.isPublic || false,
        turnTimer: room.turnTimer || 0,
        bet: room.bet || 0,
        interruptWindow: room.interruptWindow || false,
        lastPlayedRank: room.lastPlayedRank || null,
        lastPlayerIdx: room.lastPlayerIdx ?? null,
        burnInterruptCount: (() => {
            // How many cards of top rank does THIS player need to burn pile?
            if (!room.pile.length || room.isSwapPhase) return 0;
            const topRank = (() => { for(let i=room.pile.length-1;i>=0;i--) if(room.pile[i].slice(0,-1)!=='3') return room.pile[i].slice(0,-1); return null; })();
            if (!topRank) return 0;
            const streak = room.pile.filter(c=>c.slice(0,-1)===topRank).length; // streak from top
            // count consecutive from top
            let s=0; for(let i=room.pile.length-1;i>=0;i--){ if(room.pile[i].slice(0,-1)===topRank) s++; else break; }
            const needed = 4 - s;
            return needed > 0 ? needed : 0;
        })(),
        pileTopRank: (() => { if(!room.pile.length) return null; for(let i=room.pile.length-1;i>=0;i--) if(room.pile[i].slice(0,-1)!=='3') return room.pile[i].slice(0,-1); return null; })(),
        players: room.slots.map((s, i) => ({
            id: i,
            name: s.name,
            handCount: s.hand.length,
            faceUp: s.faceUp,
            faceDownCount: s.faceDown.filter(Boolean).length,
            finished: s.finished,
            connected: s.connected,
        })),
    };
    io.to(slot.socketId).emit('state', state);
}

function emitStateToAll(room) {
    room.slots.forEach((_, i) => emitStateToPlayer(room, i));
}

// ── Broadcast a toast/log to all in room ──
function broadcast(room, event, data) {
    room.slots.forEach(s => {
        if (s.socketId) io.to(s.socketId).emit(event, data);
    });
}

// ── Draw up to 3 cards ──
function drawUpToThree(room, idx) {
    const p = room.slots[idx];
    while (p.hand.length < 3 && room.drawPile.length > 0)
        p.hand.push(room.drawPile.shift());
}

// ── Check win ──
// ── Emit open lobby state ──
function emitOpenLobby(room) {
    const state = {
        players: room.slots.filter(s => s.connected).map((s,i) => ({ name: s.name, connected: true })),
        openRoom: true,
        gameStarted: room.gameStarted || false
    };
    broadcast(room, 'state', state);
}

function checkWin(room, idx) {
    const p = room.slots[idx];
    if (!p.finished &&
        p.hand.length === 0 &&
        p.faceUp.every(c => !c) &&
        p.faceDown.every(c => !c)) {
        p.finished = true;
        room.winnersOrder.push(idx);
        broadcast(room, 'toast', `🏁 ${p.name} סיים במקום ${room.winnersOrder.length}!`);
        if (room.winnersOrder.length >= room.playerCount - 1) {
            const last = room.slots.find(s => !s.finished);
            if (last) room.winnersOrder.push(last.id);
            room.gameOver = true;
            clearRoomTimer(room.code);
            console.log(`[gameOver] bet=${room.bet} order=${room.winnersOrder} slots=${JSON.stringify(room.slots.map(s=>({n:s.name,u:s.username})))}`);
            broadcast(room, 'gameOver', room.winnersOrder.map(i => room.slots[i].name));
            setTimeout(() => settleCoins(room).catch(e => console.error('[coins error]', e.message)), 300);
        }
    }
}

// ── Next turn ──
// ── Bot play logic ──
function doBotTurn(room) {
    if (room.gameOver || room.isSwapPhase) return;
    const idx = room.currentPlayer;
    const p = room.slots[idx];
    if (!p || !p.isBot || p.finished) return;

    const customSort = ['4','5','6','7','8','9','J','Q','K','A','2','3','10'];

    setTimeout(() => {
        if (room.gameOver || room.currentPlayer !== idx) return;

        // Play from hand
        if (p.hand.length > 0) {
            const valid = p.hand.filter(c => canPlay(c, room.pile));
            if (valid.length > 0) {
                valid.sort((a,b) => customSort.indexOf(a.slice(0,-1)) - customSort.indexOf(b.slice(0,-1)));
                const card = valid[0];
                p.hand = p.hand.filter(c => c !== card);
                executeMove(room, idx, [card]);
            } else {
                // Take pile
                p.hand.push(...room.pile);
                room.pile = [];
                broadcast(room, 'toast', `🤖 ${p.name} לוקח`);
                emitStateToAll(room);
                nextTurn(room);
            }
            return;
        }

        // Play from faceUp
        const faceUpCards = p.faceUp.filter(c => c);
        if (faceUpCards.length > 0 && room.drawPile.length === 0) {
            const valid = faceUpCards.filter(c => canPlay(c, room.pile));
            if (valid.length > 0) {
                valid.sort((a,b) => customSort.indexOf(a.slice(0,-1)) - customSort.indexOf(b.slice(0,-1)));
                const card = valid[0];
                const fi = p.faceUp.indexOf(card);
                p.faceUp[fi] = null;
                executeMove(room, idx, [card]);
            } else {
                p.hand.push(...room.pile, ...faceUpCards);
                p.faceUp = [null, null, null];
                room.pile = [];
                broadcast(room, 'toast', `🤖 ${p.name} לוקח`);
                emitStateToAll(room);
                nextTurn(room);
            }
            return;
        }

        // Flip faceDown
        const fdIdx = p.faceDown.findIndex(c => c);
        if (fdIdx >= 0 && p.hand.length === 0) {
            const card = p.faceDown[fdIdx];
            p.faceDown[fdIdx] = null;
            p.hand.push(card);
            if (canPlay(card, room.pile)) {
                p.hand = p.hand.filter(c => c !== card);
                executeMove(room, idx, [card]);
            } else {
                p.hand.push(...room.pile);
                room.pile = [];
                broadcast(room, 'toast', `🤖 ${p.name} הפך ${card.slice(0,-1)} — לוקח`);
                emitStateToAll(room);
                nextTurn(room);
            }
            return;
        }

        nextTurn(room);
    }, 1200);
}

function nextTurn(room, skips = 1) {
    if (room.gameOver) return;
    const n = room.playerCount;
    for (let i = 0; i < skips; i++) {
        let attempts = 0;
        do {
            room.currentPlayer = (room.currentPlayer + 1) % n;
            attempts++;
            if (attempts > n) break;
        } while (room.slots[room.currentPlayer].finished);
    }
    emitStateToAll(room);
    startTurnTimer(room);
    // If current player is a bot, trigger bot move
    const cur = room.slots[room.currentPlayer];
    if (cur && cur.isBot && !cur.finished && !room.gameOver) {
        doBotTurn(room);
    }
}

// ── Execute a move ──
function executeMove(room, playerIdx, cards) {
    const pile = room.pile;
    cards.forEach(c => pile.push(c));
    const r = cards[0].slice(0, -1);

    broadcast(room, 'cardPlayed', { playerIdx, cards });

    const isBurned = r === '10' ||
        (pile.length >= 4 && pile.slice(-4).every(c => c.slice(0, -1) === r));

    if (isBurned) {
        broadcast(room, 'burn', { playerIdx });
        room.pile = [];
        drawUpToThree(room, playerIdx);
        checkWin(room, playerIdx);
        if (!room.slots[playerIdx].finished) {
            emitStateToAll(room); // same player goes again
            startTurnTimer(room); // reset timer after burn
        } else {
            nextTurn(room);
        }
        return;
    }

    drawUpToThree(room, playerIdx);
    checkWin(room, playerIdx);
    if (room.slots[playerIdx].finished) { nextTurn(room); return; }

    const skips = r === '8' ? cards.length : 1;

    // Open interrupt window for all ranks except 10 (burn)
    // 8s can be interrupted with more 8s for extra skips
    if (r !== '10') {
        room.interruptWindow = true;
        room.lastPlayedRank = r;
        room.lastPlayerIdx = playerIdx;
    } else {
        room.interruptWindow = false;
        room.lastPlayedRank = null;
        room.lastPlayerIdx = null;
    }
    nextTurn(room, skips);
    // interruptWindow stays open until next player actually plays
}

// ══════════════════════════════════════════════
//  SOCKET EVENTS
// ══════════════════════════════════════════════
// ── Cleanup stale rooms every 5 minutes ──
setInterval(() => {
    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const EMPTY_10MIN = 10 * 60 * 1000;
    Object.keys(rooms).forEach(code => {
        const room = rooms[code];
        const age = now - (room.createdAt || 0);
        const connected = room.slots.filter(s => s.connected).length;
        // Delete if: older than 2hrs, OR empty for 10min, OR game over and no connected
        if (age > TWO_HOURS || (connected === 0 && age > EMPTY_10MIN) || (room.gameOver && connected === 0)) {
            clearRoomTimer(code);
            clearRoomTimer(code + '_swap');
            delete rooms[code];
            console.log(`Cleaned up stale room ${code}`);
        }
    });
}, 5 * 60 * 1000);

function handlePlayerLeave(socketData) {
    const { roomCode, slotIdx } = socketData;
    const room = rooms[roomCode];
    if (!room) return;
    const slot = room.slots[slotIdx];
    if (!slot) return;
    // Guard: if already processed this slot's leave, ignore
    if (room.leaversOrder.includes(slotIdx) && slot.isBot) return;
    // Guard: pure bots (never human) don't trigger leave logic
    if (slot.isBot && !slot.wasHuman) return;
    const name = slot.name;

    // Check game state BEFORE marking disconnected
    const inGame = room.gameStarted || room.isSwapPhase === false;
    const inLobby = !inGame && !room.gameOver;
    slot.connected = false;
    slot.socketId = null;
    if (room.restartVotes) room.restartVotes.delete(slotIdx);

    const connected = room.slots.filter(s => s.connected).length;

    if (inLobby) {
        if (connected === 0 || slotIdx === 0) {
            broadcast(room, 'roomClosed', { reason: slotIdx === 0 ? 'המארח יצא מהחדר' : 'החדר נסגר' });
            clearRoomTimer(roomCode);
            clearRoomTimer(roomCode + '_swap');
            delete rooms[roomCode];
            return;
        }
        broadcast(room, 'lobbyPlayerLeft', { name, newCount: connected });
        emitOpenLobby(room);
        return;
    }

    if (room.gameOver) {
        broadcast(room, 'playerLeft', { name, newPlayerCount: connected });
        return;
    }

    // Track leavers: first leaver = last place
    slot.finished = true;
    slot.disqualified = true;
    room.leaversOrder.push(slotIdx); // first leaver at index 0
    console.log(`[leave] ${name} (slot=${slotIdx}) left. leavers=${room.leaversOrder}`);
    broadcast(room, 'toast', `🚪 ${name} יצא מהמשחק`);

    // Human players still in game (not finished, not bots)
    const activeHumans = room.slots.filter(s => !s.finished && !s.isBot);
    // All non-finished players (humans + bots)
    const activeAll = room.slots.filter(s => !s.finished);

    if (activeHumans.length <= 1) {
        // Only 1 (or 0) human left — end game immediately
        const remaining = activeAll.slice();
        remaining.forEach(p => { p.finished = true; });

        // Build final order using ONLY humans:
        // - human winner (last standing human)
        // - then human leavers in reverse order (latest leaver = best loser place)
        // - leaversOrder contains both humans and bots — filter to humans only
        const humanWinner = remaining.find(p => !p.isBot);
        const humanLeavers = room.leaversOrder.filter(i => !room.slots[i].isBot || room.slots[i].wasHuman);
        // humanLeavers[0] = first human to leave = last place
        // humanLeavers[last] = latest human to leave = second to last
        room.winnersOrder = [
            ...(humanWinner ? [humanWinner.id] : []),
            ...[...humanLeavers].reverse()
        ];

        room.gameOver = true;
        clearRoomTimer(room.code);
        console.log(`[gameOver by leave] winnersOrder=${room.winnersOrder}`);
        broadcast(room, 'gameOver', room.winnersOrder.map(i => room.slots[i]?.name || '?'));
        setTimeout(() => settleCoins(room).catch(e => console.error('[coins error]', e.message)), 300);
    } else {
        // More than 1 human remains — replace leaver with bot
        // Keep leaversOrder entry — leaver's place is recorded
        // Bot is just a gameplay placeholder, finished=false so it can play
        slot.isBot = true;
        slot.wasHuman = true; // was a real player — include in coin settlement
        slot.finished = false;
        slot.name = `🤖 ${name}`;
        broadcast(room, 'toast', `🤖 מחשב ממשיך במקום ${name}`);
        emitStateToAll(room);
        if (room.currentPlayer === slotIdx) {
            setTimeout(() => { if (rooms[roomCode]) doBotTurn(room); }, 800);
        }
    }
}

io.on('connection', (socket) => {

    // ── Create room ──
    socket.on('createRoom', async ({ name, playerCount, turnTimer, isPublic, bet, username, token }) => {
        try {
            const betAmount = parseInt(bet) || 0;
            const uname = username?.trim().toLowerCase();
            let validUser = false;
            if (uname) {
                const u = await getUser(uname);
                if (u && u.token === token) {
                    validUser = true;
                    if (betAmount > 0 && u.coins < betAmount)
                        return socket.emit('error', 'אין מספיק מטבעות');
                } else if (betAmount > 0) {
                    return socket.emit('error', 'יש להתחבר כדי לשחק בהימורים');
                }
            } else if (betAmount > 0) {
                return socket.emit('error', 'יש להתחבר כדי לשחק בהימורים');
            }
            const code = createRoom(socket.id, name, playerCount, betAmount);
            rooms[code].turnTimer = turnTimer || 0;
            rooms[code].isPublic = !!isPublic;
            rooms[code].createdAt = Date.now();
            const room = rooms[code];
            room.slots[0].name = name;
            room.slots[0].socketId = socket.id;
            room.slots[0].connected = true;
            room.slots[0].username = validUser ? uname : null;
            socket.join(code);
            socket.data.roomCode = code;
            socket.data.slotIdx = 0;
            socket.emit('roomCreated', { code, slotIdx: 0, bet: betAmount });
            emitStateToPlayer(room, 0);
        } catch(e) { console.error('[createRoom]', e.message); }
    });

    // ── Open room (host decides when to start) ──
    socket.on('createOpenRoom', async ({ name, turnTimer, isPublic, bet, username, token }) => {
        const betAmount = parseInt(bet) || 0;
        const code = [...Array(4)].map(() => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random()*23)]).join('');
        const room = {
            code,
            slots: [{
                id: 0, name, socketId: socket.id, connected: true,
                username: null, // set after validation
                hand: [], faceUp: [], faceDown: [], finished: false,
                consecutiveTimeouts: 0
            }],
            playerCount: 1, // grows as players join
            drawPile: [], pile: [],
            currentPlayer: 0, isSwapPhase: null, // null = lobby, true/false = in game
            winnersOrder: [],
        leaversOrder: [], gameOver: false,
            interruptWindow: false, lastPlayedRank: null, lastPlayerIdx: null,
            turnTimer: turnTimer || 0,
            bet: betAmount,        // ✅ coins per player
            coinsSettled: false,
            openRoom: true,  // flag: host controls start
            isPublic: !!isPublic,
            createdAt: Date.now(),
            hostSocketId: socket.id,
            restartVotes: new Set()
        };
        rooms[code] = room;
        // Set username on host slot
        const openUname = username?.trim().toLowerCase();
        if (openUname) {
            const ou = await getUser(openUname);
            if (ou && ou.token === token) room.slots[0].username = openUname;
        }
        console.log(`[createOpenRoom] code=${code} bet=${betAmount} username=${room.slots[0].username}`);
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.slotIdx = 0;
        socket.emit('openRoomCreated', { code, slotIdx: 0, bet: betAmount });
        emitOpenLobby(room);
    });

    // ── Join open room ──
    socket.on('joinRoom', async ({ code, name, username, token }) => {
        const room = rooms[code];
        if (!room) { socket.emit('error', 'חדר לא נמצא'); return; }

        // Validate coins for bet rooms
        const betAmount = room.bet || 0;
        const uname = username?.trim().toLowerCase();
        let validUser = false;
        if (uname) {
            const u = await getUser(uname);
            if (u && u.token === token) {
                validUser = true;
                if (betAmount > 0 && u.coins < betAmount)
                    return socket.emit('error', `אין מספיק מטבעות (נדרש: ${betAmount})`);
            } else if (betAmount > 0) {
                return socket.emit('error', 'יש להתחבר כדי לשחק בהימורים');
            }
        } else if (betAmount > 0) {
            return socket.emit('error', 'יש להתחבר כדי לשחק בהימורים');
        }

        if (room.openRoom && !room.gameStarted) {
            if (room.slots.length >= 4) { socket.emit('error', 'החדר מלא (4 שחקנים)'); return; }
            const slotIdx = room.slots.length;
            room.slots.push({
                id: slotIdx, name, socketId: socket.id, connected: true,
                username: validUser ? uname : null,
                hand: [], faceUp: [], faceDown: [], finished: false,
                consecutiveTimeouts: 0
            });
            room.playerCount = room.slots.length;
            socket.join(code);
            socket.data.roomCode = code;
            socket.data.slotIdx = slotIdx;
            socket.emit('openRoomCreated', { code, slotIdx });
            emitOpenLobby(room);
            return;
        }
        // Fixed-size room join
        const slot = room.slots.find(s => !s.connected);
        if (!slot) { socket.emit('error', 'החדר מלא'); return; }
        slot.name = name;
        slot.socketId = socket.id;
        slot.connected = true;
        slot.username = validUser ? uname : null;
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.slotIdx = slot.id;
        console.log(`[joinRoom] code=${code} bet=${room.bet} username=${slot.username}`);
        socket.emit('roomJoined', { code, slotIdx: slot.id, bet: room.bet || 0 });
        emitStateToAll(room);
    });

    // ── Host starts open room ──
    socket.on('hostStart', () => {
        const { roomCode, slotIdx } = socket.data;
        const room = rooms[roomCode];
        if (!room || !room.openRoom || slotIdx !== 0) return;
        if (room.slots.filter(s => s.connected).length < 2) {
            socket.emit('error', 'צריך לפחות 2 שחקנים'); return;
        }
        // Initialize the game with current connected players
        room.gameStarted = true;
        room.openRoom = false; // behave like normal room now
        const deck = makeDeck();
        room.slots = room.slots.filter(s => s.connected);
        room.playerCount = room.slots.length;
        room.slots.forEach((s, i) => {
            s.id = i;
            // username preserved from join — do not overwrite
            s.hand = deck.splice(0, 3);
            s.faceUp = deck.splice(0, 3);
            s.faceDown = deck.splice(0, 3);
            s.finished = false;
        });
        room.drawPile = deck;
        room.pile = [];
        room.currentPlayer = 0;
        room.isSwapPhase = true;
        room.winnersOrder = [];
    room.leaversOrder = []; // first leaver = last place
        room.gameOver = false;
        broadcast(room, 'toast', '🎮 המארח התחיל את המשחק!');
        emitStateToAll(room);
        startSwapTimer(room);
    });

    // ── Join room ──
    // old joinRoom removed (handled above)
;

    // ── Swap cards (swap phase) ──
    socket.on('swap', ({ handIdx, tableIdx }) => {
        const { roomCode, slotIdx } = socket.data;
        const room = rooms[roomCode];
        if (!room || !room.isSwapPhase) return;
        const p = room.slots[slotIdx];
        [p.hand[handIdx], p.faceUp[tableIdx]] = [p.faceUp[tableIdx], p.hand[handIdx]];
        emitStateToPlayer(room, slotIdx);
    });

    // ── End swap ──
    socket.on('endSwap', () => {
        const { roomCode, slotIdx } = socket.data;
        const room = rooms[roomCode];
        if (!room || !room.isSwapPhase) return;
        // Prevent double-submit from same player this round
        if (room.slots[slotIdx]._swapDone) {
            console.log(`[endSwap] slot${slotIdx} BLOCKED (already done) swapDoneCount=${room.swapDoneCount}`);
            return;
        }
        room.slots[slotIdx]._swapDone = true;
        room.swapDoneCount = (room.swapDoneCount || 0) + 1;
        const needed = room.slots.filter(s => s.socketId).length;
        console.log(`[endSwap] slot${slotIdx} counted: ${room.swapDoneCount}/${needed}`);
        if (room.swapDoneCount >= needed) {
            clearRoomTimer(room.code + '_swap');
            broadcast(room, 'swapTick', { remaining: 0 });
            room.isSwapPhase = false;
            room.gameStarted = true;
            const starter = findStarter(room.slots);
            room.currentPlayer = starter;
            broadcast(room, 'toast', `המשחק התחיל! ${room.slots[starter].name} ראשון`);
            emitStateToAll(room);
            startTurnTimer(room);
        } else {
            const waiting = needed - room.swapDoneCount;
            broadcast(room, 'toast', `${room.slots[slotIdx].name} סיים החלפה. ממתין לעוד ${waiting}...`);
        }
    });

    // ── Play cards ──
    // Flip faceDown card to hand (anytime, any turn)
    socket.on('flipFaceDown', ({ cardIdx }) => {
        const { roomCode, slotIdx } = socket.data;
        const room = rooms[roomCode];
        if (!room || room.isSwapPhase || room.gameOver) return;
        const p = room.slots[slotIdx];
        // Only in faceDown phase (no hand, no faceUp)
        if (p.hand.length > 0 || p.faceUp.some(Boolean)) return;
        if (!p.faceDown[cardIdx]) return;
        // Move to hand
        p.hand.push(p.faceDown[cardIdx]);
        p.faceDown[cardIdx] = null;
        broadcast(room, 'toast', `${p.name} הפך קלף`);
        emitStateToAll(room);
    });

    socket.on('playCards', ({ cards, isInterrupt }) => {
        // Reset timeout counter on manual play
        if (rooms[socket.data?.roomCode]?.slots[socket.data?.slotIdx])
            rooms[socket.data.roomCode].slots[socket.data.slotIdx].consecutiveTimeouts = 0;
        const { roomCode, slotIdx } = socket.data;
        const room = rooms[roomCode];
        if (!room || room.isSwapPhase || room.gameOver) return;

        // Handle interrupt
        if (isInterrupt) {
            if (!room.interruptWindow) { socket.emit('error', 'חלון ההתפרצות נסגר'); return; }
            if (room.lastPlayerIdx !== slotIdx) { socket.emit('error', 'רק השחקן שרק שיחק יכול להתפרץ'); return; }
            const r = cards[0].slice(0, -1);
            if (r !== room.lastPlayedRank) { socket.emit('error', 'רק קלף זהה להתפרצות'); return; }
            const p = room.slots[slotIdx];
            // Remove cards from player's hand
            for (const c of cards) {
                const idx = p.hand.indexOf(c);
                if (idx === -1) { socket.emit('error', 'קלף לא ביד'); return; }
                p.hand.splice(idx, 1);
            }
            room.interruptWindow = false;
            // Add to pile and execute
            cards.forEach(c => room.pile.push(c));
            broadcast(room, 'toast', `⚡ ${p.name} התפרץ!`);
            broadcast(room, 'cardPlayed', { playerIdx: slotIdx, cards });
            // Check burn
            const topR = room.pile[room.pile.length-1].slice(0,-1);
            const isBurned = topR === '10' || (room.pile.length >= 4 && room.pile.slice(-4).every(c=>c.slice(0,-1)===topR));
            if (isBurned) {
                broadcast(room, 'burn', { playerIdx: slotIdx });
                room.pile = [];
                drawUpToThree(room, slotIdx);
                checkWin(room, slotIdx);
                emitStateToAll(room);
                startTurnTimer(room);
            } else {
                drawUpToThree(room, slotIdx);
                checkWin(room, slotIdx);
                if (room.slots[slotIdx].finished) { nextTurn(room); return; }
                // If interrupt was with 8, apply the additional skips
                if (topR === '8') {
                    // cards.length = number of 8s added in THIS interrupt
                    nextTurn(room, cards.length);
                }
                // Open interrupt window again so player can keep adding 8s
                room.interruptWindow = true;
                room.lastPlayedRank = topR;
                room.lastPlayerIdx = slotIdx;
                emitStateToAll(room);
                startTurnTimer(room);
            }
            return;
        }

        // Normal play — close interrupt window
        room.interruptWindow = false;

        // Check burn interrupt: non-current player completing 4-of-a-kind
        if (room.currentPlayer !== slotIdx) {
            if (!room.pile.length) { socket.emit('error', 'לא התורו שלך'); return; }
            // Find top rank (skip 3s)
            let topRank = null;
            for (let i = room.pile.length-1; i >= 0; i--) {
                if (room.pile[i].slice(0,-1) !== '3') { topRank = room.pile[i].slice(0,-1); break; }
            }
            if (!topRank) { socket.emit('error', 'לא התורו שלך'); return; }
            // Count streak
            let streak = 0;
            for (let i = room.pile.length-1; i >= 0; i--) {
                if (room.pile[i].slice(0,-1) === topRank) streak++; else break;
            }
            const needed = 4 - streak;
            if (needed <= 0) { socket.emit('error', 'לא התורו שלך'); return; }
            // Validate cards
            if (cards.length !== needed) { socket.emit('error', `צריך בדיוק ${needed} קלפי ${topRank} לשריפה`); return; }
            if (!cards.every(c => c.slice(0,-1) === topRank)) { socket.emit('error', 'קלפים לא מתאימים לשריפה'); return; }
            const p = room.slots[slotIdx];
            for (const c of cards) {
                const idx = p.hand.indexOf(c);
                if (idx === -1) { socket.emit('error', 'קלף לא ביד'); return; }
                p.hand.splice(idx, 1);
            }
            // Add to pile → burn
            cards.forEach(c => room.pile.push(c));
            broadcast(room, 'toast', `🔥 ${p.name} שרף את הערימה!`);
            broadcast(room, 'cardPlayed', { playerIdx: slotIdx, cards });
            broadcast(room, 'burn', { playerIdx: slotIdx });
            room.pile = [];
            drawUpToThree(room, slotIdx);
            checkWin(room, slotIdx);
            // Burn interrupter gets the turn
            room.currentPlayer = slotIdx;
            emitStateToAll(room);
            startTurnTimer(room);
            return;
        }

        const p = room.slots[slotIdx];

        // Validate and remove cards from player
        // Check mixed play: hand + faceUp cards of same rank when all hand cards are that rank
        const allSameRank = cards.every(c => c.slice(0,-1) === cards[0].slice(0,-1));
        const cardsFromHand = cards.filter(c => p.hand.includes(c));
        const cardsFromFaceUp = cards.filter(c => p.faceUp.includes(c));
        const isMixedPlay = allSameRank && cardsFromHand.length > 0 && cardsFromFaceUp.length > 0
            && cardsFromHand.length === p.hand.length; // must use ALL hand cards

        if (isMixedPlay) {
            if (!canPlay(cards[0], room.pile)) { socket.emit('error', 'קלף לא חוקי'); return; }
            for (const c of cardsFromHand) { p.hand.splice(p.hand.indexOf(c), 1); }
            for (const c of cardsFromFaceUp) { const fi = p.faceUp.indexOf(c); if (fi !== -1) p.faceUp[fi] = null; }
        } else if (p.hand.length > 0) {
            // Playing from hand
            for (const c of cards) {
                if (!canPlay(c, room.pile)) { socket.emit('error', 'קלף לא חוקי'); return; }
                const idx = p.hand.indexOf(c);
                if (idx === -1) { socket.emit('error', 'קלף לא ביד'); return; }
                p.hand.splice(idx, 1);
            }
        } else if (p.faceUp.some(Boolean)) {
            // Playing from faceUp
            for (const c of cards) {
                if (!canPlay(c, room.pile)) { socket.emit('error', 'קלף לא חוקי'); return; }
                const idx = p.faceUp.indexOf(c);
                if (idx === -1) { socket.emit('error', 'קלף לא בשולחן'); return; }
                p.faceUp[idx] = null;
            }
        } else {
            // Playing from faceDown (single card, already revealed client-side)
            const c = cards[0];
            const idx = p.faceDown.indexOf(c);
            if (idx === -1) { socket.emit('error', 'קלף לא נמצא'); return; }
            p.faceDown[idx] = null;
            if (!canPlay(c, room.pile)) {
                // Can't play — take faceDown card + pile together
                p.hand.push(c, ...room.pile);
                room.pile = [];
                broadcast(room, 'toast', `${p.name} הפך קלף לא חוקי — לקח את הערימה`);
                nextTurn(room);
                return;
            }
            // Play faceDown card normally — pass turn after
            executeMove(room, slotIdx, [c]);
            return;
        }

        executeMove(room, slotIdx, cards);
    });

    // ── Take pile ──
    socket.on('takePile', ({ faceUpCards, faceDownCard, faceDownIdx }) => {
        const { roomCode, slotIdx } = socket.data;
        const room = rooms[roomCode];
        if (!room || room.isSwapPhase || room.gameOver) return;
        if (room.currentPlayer !== slotIdx) return;
        room.slots[slotIdx].consecutiveTimeouts = 0;

        const p = room.slots[slotIdx];

        // faceDown phase: take revealed faceDown card + pile
        if (faceDownCard !== undefined) {
            const fi = faceDownIdx ?? p.faceDown.indexOf(faceDownCard);
            if (fi !== -1 && p.faceDown[fi]) {
                p.hand.push(p.faceDown[fi]);
                p.faceDown[fi] = null;
            }
            p.hand.push(...room.pile);
            room.pile = [];
            broadcast(room, 'toast', `${p.name} לקח את הערימה`);
            nextTurn(room);
            return;
        }

        // Block taking empty pile (not faceDown case)
        if (room.pile.length === 0) {
            socket.emit('error', 'הערימה ריקה — אי אפשר לקחת');
            return;
        }

        // faceUp phase: must take a faceUp card with pile — all must be same rank
        if (p.hand.length === 0 && p.faceUp.some(Boolean) && faceUpCards?.length) {
            const firstRank = faceUpCards[0]?.slice(0,-1);
            const validCards = faceUpCards.filter(c => p.faceUp.includes(c) && c.slice(0,-1) === firstRank);
            if (!validCards.length) { socket.emit('error', 'קלף לא תקין'); return; }
            validCards.forEach(c => {
                const idx = p.faceUp.indexOf(c);
                if (idx !== -1) { p.hand.push(c); p.faceUp[idx] = null; }
            });
        }
        p.hand.push(...room.pile);
        room.pile = [];
        broadcast(room, 'toast', `${p.name} לקח את הערימה`);
        nextTurn(room);
    });

    // ── Vote to restart ──
    socket.on('voteRestart', () => {
        const { roomCode, slotIdx } = socket.data;
        const room = rooms[roomCode];
        if (!room || !room.gameOver) return;
        if (!room.restartVotes) room.restartVotes = new Set();

        // All rooms: everyone must vote to restart
        room.restartVotes.add(slotIdx);
        const activePlayers = room.slots.filter(s => s.socketId);
        broadcast(room, 'playerWantsRestart', {
            readyCount: room.restartVotes.size,
            totalCount: activePlayers.length
        });
        if (room.restartVotes.size >= activePlayers.length) {
            room.restartVotes = new Set();
            restartRoom(room);
            broadcast(room, 'gameRestarted', {});
            setTimeout(() => {
                emitStateToAll(room);
                startSwapTimer(room);
            }, 300);
        }
    });

    // ── Leave room ──
    // ── Player voluntarily leaves ──
    socket.on('playerLeaving', () => handlePlayerLeave(socket.data));

    registerBasraHandlers(socket);

    socket.on('disconnect', () => {
        // Handle shithead disconnect
        if (socket.data?.roomCode) handlePlayerLeave(socket.data);

        // Handle basra disconnect — mark slot as disconnected after grace period
        const basraCode = socket.data?.basraRoom;
        if (basraCode && basraRooms[basraCode]) {
            const room = basraRooms[basraCode];
            const slotIdx = socket.data.basraSlot;
            const slot = room.slots?.[slotIdx];
            if (slot && slot.socketId === socket.id) {
                // Grace period: 15s to reconnect before marking disconnected
                setTimeout(() => {
                    if (slot.socketId === socket.id) {
                        slot.connected = false;
                        // Don't clear username — needed for reconnect
                        // But clear socketId so duplicate check won't block reconnect
                        slot.socketId = null;
                    }
                }, 15000);
            }
        }
    });

    socket.on('getOnlineStats', () => {
        const allRooms = Object.values(rooms);
        const inGame = allRooms.filter(r => r.gameStarted || (r.isSwapPhase === false && !r.gameOver))
            .reduce((sum, r) => sum + r.slots.filter(s => s.connected).length, 0);
        const online = io.engine.clientsCount;
        socket.emit('onlineStats', { online, inGame });
    });

    socket.on('getPublicRooms', () => {
        const timerLabel = t => t === 0 ? '♾' : `${t}s`;
        const allRooms = Object.values(rooms).filter(r => r.isPublic);
        const list = allRooms.map(r => {
            const connected = r.slots.filter(s => s.connected).length;
            const max = r.openRoom ? 4 : r.playerCount;
            // inProgress = game actually started
            const inProgress = r.gameStarted ||
                (!r.openRoom && r.isSwapPhase === false && !r.gameOver);
            const isFull = r.openRoom ? connected >= 4 : !r.slots.some(s => !s.connected);
            // available = waiting for players
            const isAvailable = !r.gameOver && !inProgress && !isFull;
            const hostSlot = r.slots[0];
            return {
                code: r.code,
                players: connected,
                max,
                timerLabel: timerLabel(r.turnTimer || 0),
                available: isAvailable,
                inProgress,
                isFull,
                bet: r.bet || 0,
                host: hostSlot?.name || ''
            };
        });
        socket.emit('publicRooms', list);
    });

    socket.on('reaction', ({ emoji }) => {
        const { roomCode, slotIdx } = socket.data;
        const room = rooms[roomCode];
        if (!room) return;
        const name = room.slots[slotIdx]?.name || 'שחקן';
        broadcast(room, 'reaction', { emoji, name });
    });

    socket.on('leaveRoom_legacy', () => {  // disabled
        const { roomCode, slotIdx } = socket.data;
        const room = rooms[roomCode];
        if (!room) return;
        const slot = room.slots[slotIdx];
        const name = slot?.name || 'שחקן';
        if (slot) { slot.connected = false; slot.socketId = null; }
        if (room.restartVotes) room.restartVotes.delete(slotIdx);

        const remaining = room.slots.filter(s => s.connected && !s.finished);

        // ── Mid-game leave logic ──
        if (!room.gameOver && slot && !slot.finished) {
            // Count active (non-finished, non-leaving) players
            const activeAfterLeave = room.slots.filter(s => s.connected && !s.finished && s !== slot);
            if (activeAfterLeave.length <= 1) {
                // Only 1 (or 0) active human players left → end game
                // Mark leaver as last (loser)
                if (!slot.finished) {
                    slot.finished = true;
                    room.winnersOrder.push(slotIdx);
                }
                // The remaining active player finishes just before leaver
                const lastActive = room.slots.find(s => s.connected && !s.finished);
                if (lastActive) {
                    lastActive.finished = true;
                    room.winnersOrder.unshift(lastActive.id); // goes one place ahead
                }
                room.gameOver = true;
                clearRoomTimer(roomCode);
                broadcast(room, 'toast', `🚪 ${name} יצא — המשחק הסתיים`);
                broadcast(room, 'gameOver', room.winnersOrder.map(i => room.slots[i]?.name || '?'));
                setTimeout(() => settleCoins(room).catch(e => console.error('[coins error]', e.message)), 300);
                return;
            } else {
                // 2+ active players remain → bot takes over
                slot.isBot = true;
                slot.name = `🤖 ${name}`;
                broadcast(room, 'toast', `🚪 ${name} יצא — 🤖 ממשיך במקומו`);
                emitStateToAll(room);
                if (room.currentPlayer === slotIdx) {
                    setTimeout(() => { if (rooms[roomCode]) nextTurn(room); }, 1000);
                }
                return;
            }
        }

        broadcast(room, 'playerLeft', { name, newPlayerCount: remaining.length });
        if (room.slots.filter(s => s.connected).length === 0) {
            clearRoomTimer(roomCode);
            clearRoomTimer(roomCode + '_swap');
            delete rooms[roomCode];
            return;
        }
        // If all remaining voted restart → start (need at least 2 players)
        if (room.gameOver && remaining.length >= 2 && room.restartVotes?.size >= remaining.length) {
            // Shrink room to remaining players, reassign slots
            const keepSlots = room.slots.filter(s => s.connected);
            keepSlots.forEach((s, i) => { s.id = i; });
            room.slots = keepSlots;
            room.playerCount = keepSlots.length;
            room.restartVotes = new Set();
            restartRoom(room);
            broadcast(room, 'gameRestarted', {});
            setTimeout(() => {
emitStateToAll(room);
                startSwapTimer(room);
            }, 300);
        } else {
            emitStateToAll(room);
        }
    });

    // ── Rejoin room ──
    socket.on('rejoinRoom', ({ code, name }) => {
        const room = rooms[code];
        if (!room) { socket.emit('error', 'חדר לא נמצא'); return; }
        const slot = room.slots.find(s => s.name === name);
        if (!slot) { socket.emit('error', 'שחקן לא נמצא'); return; }
        if (disconnectTimers[slot.socketId]) {
            clearTimeout(disconnectTimers[slot.socketId]);
            delete disconnectTimers[slot.socketId];
        }
        slot.socketId = socket.id;
        slot.connected = true;
        socket.data = { roomCode: code, slotIdx: slot.id };
        broadcast(room, 'toast', `✅ ${name} חזר למשחק`);
        emitStateToPlayer(room, slot.id);
        emitStateToAll(room);
    });

    // ── Disconnect ──
    socket.on('disconnect', () => {
        const { roomCode, slotIdx } = socket.data || {};
        if (!roomCode || slotIdx === undefined) return;
        const room = rooms[roomCode];
        if (!room) return;
        const slot = room.slots[slotIdx];
        if (!slot) return;
        disconnectTimers[socket.id] = setTimeout(() => {
            delete disconnectTimers[socket.id];
            if (room.slots[slotIdx]?.socketId !== socket.id) return;
            slot.connected = false;
            const remainingAfter = room.slots.filter(s => s.connected);
            broadcast(room, 'playerLeft', { name: slot.name || 'שחקן', newPlayerCount: remainingAfter.length });
            emitStateToAll(room);
            if (remainingAfter.length === 0) {
                clearRoomTimer(roomCode);
                clearRoomTimer(roomCode + '_swap');
                delete rooms[roomCode];
            }
        }, 12000);
    });
});

// ══════════════════════════════════════════════
//  BASRA SOCKET EVENTS
// ══════════════════════════════════════════════

function basraBroadcastExcept(room, excludeSocketId, event, data) {
    room.slots.forEach(s => {
        if (s.socketId && s.socketId !== excludeSocketId) {
            io.to(s.socketId).emit(event, data);
        }
    });
}

function basraBroadcast(room, event, data) {
    room.slots.forEach(s => {
        if (s.socketId) io.to(s.socketId).emit(event, data);
    });
}

function basraStateForPlayer(room, slotIdx) {
    const p = room.slots[slotIdx];
    const isMyTurn = room.currentPlayer === slotIdx;
    return {
        gameType: 'basra',
        roomCode: room.code,
        mySlotIdx: slotIdx,
        myHand: p.hand,
        tableCards: room.tableCards,
        deckCount: room.deck.length,
        currentPlayer: room.currentPlayer,
        isMyTurn,
        playerNames: room.slots.map(s => s.name),
        capturedCounts: room.slots.map(s => s.captured.length),
        handCounts: room.slots.map(s => s.hand.length),
        scores: room.slots.map(s => s.score || 0),
        basraCounts: room.slots.map(s => s.basras || 0),
        basraCards: room.slots.map(s => (s.basraCards || []).map(b => typeof b === 'string' ? b : b.card)),
        teams: room.teams || null,
        roundOver: room.roundOver,
        gameOver: room.gameOver,
        lastCapturer: room.lastCapturer,
        committedCard: room.committedCard || null,
        committedBy: room.committedBy,
        turnTimer: room.turnTimer || 0,
        timerStarted: !!room._timerStarted,
        timerRemaining: room._timerStarted ? Math.max(0, room.turnTimer - Math.floor((Date.now() - room._timerStarted) / 1000)) : 0,
    };
}

function basraEmitAll(room) {
    room.slots.forEach((s, i) => {
        if (s.socketId) io.to(s.socketId).emit('basraState', basraStateForPlayer(room, i));
    });
}

function basraMakeCode() {
    let code;
    do { code = Math.random().toString(36).substring(2,6).toUpperCase(); }
    while (basraRooms[code]);
    return code;
}

io.on('basraConnection', () => {}); // no-op, handled in main io.on

// We hook into the existing io.on('connection') — add extra handlers per socket
// This is called from within the main connection handler below via separate block

function basraClearBasraTimer(room) {
    if (room._timerTimeout) { clearTimeout(room._timerTimeout); room._timerTimeout = null; }
    if (room._timerInterval) { clearInterval(room._timerInterval); room._timerInterval = null; }
}

function basraAdvanceTurn(room) {
    // Check if all hands empty
    const allHandsEmpty = room.slots.every(sl => sl.hand.length === 0);
    if (allHandsEmpty) {
        if (room.deck.length > 0) {
            basra.dealNewHands(room);
            basraBroadcast(room, 'toast', 'חולקו קלפים חדשים');
        } else {
            if (room.tableCards.length > 0 && room.lastCapturer !== null) {
                room.slots[room.lastCapturer].captured.push(...room.tableCards);
                room.tableCards = [];
            }
            room.roundOver = true;
            const roundScores = basra.scoreRound(room);
            basraBroadcast(room, 'basraRoundOver', {
                scores: roundScores,
                totalScores: room.slots.map(s => s.score || 0),
                pendingMajority: room.pendingMajorityPoints,
                teams: room.teams || null,
            });
            const winThreshold = room.winScore || 120;
            if (room.teams) {
                // 4p team mode: use combined team score
                // Both team members have identical scores — just use first member's score
                const teamScores = room.teams.map(team => room.slots[team[0]].score || 0);
                const overThreshold = teamScores.filter(ts => ts > winThreshold);
                if (overThreshold.length > 0) {
                    const maxTeam = Math.max(...teamScores);
                    if (teamScores[0] !== teamScores[1]) {
                        room.gameOver = true;
                        const winTeamIdx = teamScores[0] > teamScores[1] ? 0 : 1;
                        basraBroadcast(room, 'basraGameOver', {
                            names: room.slots.map(s=>s.name),
                            scores: room.slots.map(s=>s.score||0),
                            teams: room.teams, teamScores
                        });
                        const winnerSlot = room.teams[winTeamIdx][0];
                        setTimeout(() => settleBasraCoins(room, winnerSlot).catch(e=>console.error('[basra coins]',e)), 300);
                    } else {
                        basraBroadcast(room, 'toast', '🔁 תיקו! משחק שובר שיוויון...');
                    }
                }
            } else {
                const overThreshold = room.slots.filter(sl => (sl.score || 0) > winThreshold);
                if (overThreshold.length > 0) {
                    const maxScore = Math.max(...room.slots.map(s => s.score || 0));
                    const tied = room.slots.filter(s => (s.score || 0) === maxScore);
                    if (tied.length === 1) {
                        room.gameOver = true;
                        const sorted = [...room.slots].sort((a,b) => (b.score||0)-(a.score||0));
                        const winnerSlotIdx = room.slots.indexOf(sorted[0]);
                        basraBroadcast(room, 'basraGameOver', { names: sorted.map(s=>s.name), scores: sorted.map(s=>s.score||0) });
                        setTimeout(() => settleBasraCoins(room, winnerSlotIdx).catch(e => console.error('[basra coins]', e.message)), 300);
                    } else {
                        basraBroadcast(room, 'toast', '🔁 תיקו! משחק שובר שיוויון...');
                    }
                }
            }
            basraEmitAll(room);
            return;
        }
    }
    // Advance turn
    room.currentPlayer = (room.currentPlayer + 1) % room.slots.length;
    basraEmitAll(room);
    // Start turn timer
    if (room.turnTimer > 0 && !room.gameOver && !room.roundOver) {
        basraClearBasraTimer(room);
        room._timerStarted = Date.now();
        room._timerRemaining = room.turnTimer;
        console.log(`[basra] starting timer interval, turnTimer=${room.turnTimer}`);
        room._timerInterval = setInterval(() => {
            room._timerRemaining--;
            console.log(`[basra] timerTick remaining=${room._timerRemaining}`);
            basraBroadcast(room, 'basraTimerTick', { remaining: room._timerRemaining, currentPlayer: room.currentPlayer });
            if (room._timerRemaining <= 0) { clearInterval(room._timerInterval); room._timerInterval = null; }
        }, 1000);
        room._timerTimeout = setTimeout(() => {
            room._timerTimeout = null; // clear self-reference immediately
            if (room._timerInterval) { clearInterval(room._timerInterval); room._timerInterval = null; }
            if (room.gameOver || room.roundOver) return;
            const p = room.slots[room.currentPlayer];
            // Allow timeout even if hand is empty — committed card may be waiting
            if (!p) return;
            if (p.hand.length === 0 && !room.committedCard) return;
            console.log(`[timeout] committedCard=${room.committedCard} committedBy=${room.committedBy} currentPlayer=${room.currentPlayer}`);

            // Track consecutive timeouts per player
            if (!room._consecutiveTimeouts) room._consecutiveTimeouts = {};
            room._consecutiveTimeouts[room.currentPlayer] = (room._consecutiveTimeouts[room.currentPlayer] || 0) + 1;

            if (room._consecutiveTimeouts[room.currentPlayer] >= 2) {
                // 2 consecutive timeouts — forfeit + coin settlement
                room.gameOver = true;
                basraClearBasraTimer(room);
                const forfeitIdx = room.currentPlayer;
                basraBroadcast(room, 'toast', `${p.name} פסל עצמו (פג הזמן פעמיים)`);
                basraBroadcast(room, 'basraGameOver', {
                    names: room.slots.map(s => s.name),
                    scores: room.slots.map(s => s.score || 0),
                    forfeitBy: forfeitIdx,
                    forfeitName: p.name,
                    teams: room.teams || null,
                    teamScores: room.teams ? room.teams.map(t => room.slots[t[0]].score || 0) : null,
                });
                basraEmitAll(room);
                const winner = room.slots.findIndex((_, i) => i !== forfeitIdx);
                setTimeout(() => settleBasraCoins(room, winner).catch(e => console.error('[coins]', e)), 300);
                return;
            }

            // If player already committed a card → throw it (no capture)
            if (room.committedCard && room.committedBy === room.currentPlayer) {
                const thrownCard = room.committedCard;
                room.tableCards.push(thrownCard);
                room.committedCard = null;
                room.committedBy = null;
                basraBroadcast(room, 'toast', `${p.name} זרק ${thrownCard} (פג הזמן - אזהרה!)`);
                basraAdvanceTurn(room);
            } else {
                const randomCard = p.hand[Math.floor(Math.random() * p.hand.length)];
                p.hand.splice(p.hand.indexOf(randomCard), 1);
                room.tableCards.push(randomCard);
                room.committedCard = null;
                room.committedBy = null;
                basraBroadcast(room, 'toast', `${p.name} זרק ${randomCard} (פג הזמן - אזהרה!)`);
                basraAdvanceTurn(room);
            }
        }, room.turnTimer * 1000);
    }
}


function registerBasraHandlers(socket) {

    socket.on('basraVerifyAccess', ({ accessCode }) => {
        socket.emit('basraAccessVerified', { ok: true }); // no access code required
    });

    socket.on('basraCreate', async ({ name, playerCount, isPublic, bet, turnTimer, winScore, accessCode, username, token }) => {
        const count = parseInt(playerCount) || 2;
        if (![2, 4].includes(count)) { socket.emit('basraError', 'שחקנים: 2 או 4'); return; }

        // Prevent same user from creating if already in a room
        if (username && token) {
            try {
                const u = await getUser(username);
                if (u && u.token === token) {
                    const alreadyIn = Object.values(basraRooms).some(r =>
                        r.slots.some(sl => sl.username === username && sl.socketId && sl.socketId !== socket.id)
                    );
                    if (alreadyIn) {
                        socket.emit('basraError', 'כבר מחובר ממקום אחר — התנתק קודם');
                        return;
                    }
                }
            } catch(e) {}
        }

        const code = basraMakeCode();
        const slots = Array.from({ length: count }, (_, i) => ({
            id: i, name: i === 0 ? name : `שחקן ${i+1}`,
            hand: [], captured: [], basras: 0, score: 0,
            socketId: i === 0 ? socket.id : null,
            connected: i === 0,
            username: i === 0 ? username : null,
            isBot: false,
        }));

        const room = basra.createBasraRoom(code, slots, bet || 0);
        room.winScore = winScore || 120;
        // Validate creator token
        let creatorUsername = null;
        if (username && token) {
            try { const u = await getUser(username); if (u && u.token === token) creatorUsername = username; } catch(e) {}
        }
        room.slots[0].username = creatorUsername;
        room.isPublic = !!isPublic;
        room.turnTimer = parseInt(turnTimer) || 0;
        console.log(`[basra] room created, turnTimer=${room.turnTimer}, raw=${turnTimer}`);
        room.gameStarted = false;
        room.committedCard = null;
        room.committedBy = null;
        basraRooms[code] = room;
        socket.data.basraRoom = code;
        socket.data.basraSlot = 0;
        socket.join('basra_' + code);

        socket.emit('basraJoined', { code, slotIdx: 0, playerCount: slots.length, bet: room.bet });
        io.to('basra_' + code).emit('basraLobbyUpdate', { players: room.slots.map(s=>({name:s.name,connected:s.connected})) });
        console.log(`[basra] Room ${code} created by ${name} (public:${isPublic}, bet:${bet})`);
    });

    socket.on('basraGetPublicRooms', () => {
        const open = Object.values(basraRooms).filter(r => r.isPublic && !r.gameStarted && !r.gameOver);
        socket.emit('basraPublicRooms', open.map(r => ({
            code: r.code,
            players: r.slots.filter(s=>s.connected).length,
            total: r.slots.length,
            bet: r.bet || 0,
            winScore: r.winScore || 120,
        })));
    });

    socket.on('basraJoin', async ({ code, name, accessCode, username, token }) => {
        const room = basraRooms[code?.toUpperCase()];
        if (!room) { socket.emit('basraError', 'חדר לא נמצא'); return; }
        if (room.gameStarted) { socket.emit('basraError', 'המשחק כבר התחיל'); return; }

        // Prevent same user from joining if already in another room
        if (username && token) {
            try {
                const u = await getUser(username);
                if (u && u.token === token) {
                    const alreadyIn = Object.values(basraRooms).some(r =>
                        r.code !== code?.toUpperCase() &&
                        r.slots.some(sl => sl.username === username && sl.socketId && sl.socketId !== socket.id)
                    );
                    if (alreadyIn) { socket.emit('basraError', 'כבר מחובר ממקום אחר — התנתק קודם'); return; }
                }
            } catch(e) {}
        }

        const freeSlot = room.slots.find(s => !s.connected);
        if (!freeSlot) { socket.emit('basraError', 'החדר מלא'); return; }

        freeSlot.name = name;
        freeSlot.socketId = socket.id;
        freeSlot.connected = true;
        // Validate joiner token
        let joinerUsername = null;
        if (username && token) {
            try { const u = await getUser(username); if (u && u.token === token) joinerUsername = username; } catch(e) {}
        }
        freeSlot.username = joinerUsername;

        socket.data.basraRoom = code.toUpperCase();
        socket.data.basraSlot = freeSlot.id;
        socket.join('basra_' + code.toUpperCase());

        socket.emit('basraJoined', { code: code.toUpperCase(), slotIdx: freeSlot.id, playerCount: room.slots.length, bet: room.bet || 0 });
        io.to('basra_' + code.toUpperCase()).emit('basraLobbyUpdate', { players: room.slots.map(s=>({name:s.name,connected:s.connected})) });
        const allConnected = room.slots.every(s => s.connected);
        if (allConnected) {
            room.gameStarted = true;
            // Teams for 4-player: shuffle players into seats, then 0+2 vs 1+3
            if (room.slots.length === 4 && !room.teams) {
                // Shuffle the slot data (name, socketId, username) randomly
                const indices = [0,1,2,3].sort(() => Math.random()-0.5);
                const snapshot = room.slots.map(s => ({
                    name: s.name, socketId: s.socketId, username: s.username,
                    connected: s.connected, id: s.id
                }));
                indices.forEach((srcIdx, dstIdx) => {
                    room.slots[dstIdx].name = snapshot[srcIdx].name;
                    room.slots[dstIdx].socketId = snapshot[srcIdx].socketId;
                    room.slots[dstIdx].username = snapshot[srcIdx].username;
                    room.slots[dstIdx].connected = snapshot[srcIdx].connected;
                    // Update socket's slot reference
                    if (snapshot[srcIdx].socketId) {
                        const sock = io.sockets.sockets.get(snapshot[srcIdx].socketId);
                        if (sock) sock.data.basraSlot = dstIdx;
                    }
                });
                room.teams = [[0, 2], [1, 3]];
                // Random starting player
                room.currentPlayer = Math.floor(Math.random() * 4);
                room.roundStarter = room.currentPlayer;
            }
            // Random starting player for 2p (4p already handled above)
            if (room.slots.length === 2) {
                room.currentPlayer = Math.floor(Math.random() * 2);
            }
            room.roundStarter = room.currentPlayer; // track for rotation
            basraBroadcast(room, 'basraStart', { playerNames: room.slots.map(s => s.name) });
            if (room.teams) {
                const t0 = room.teams[0].map(i => room.slots[i].name.split(' ')[0]).join(' + ');
                const t1 = room.teams[1].map(i => room.slots[i].name.split(' ')[0]).join(' + ');
                setTimeout(() => basraBroadcast(room, 'basraTeamsAnnounce', { teams: [[t0, room.teams[0]], [t1, room.teams[1]]], firstPlayer: room.slots[room.currentPlayer].name }), 500);
            }
            basraEmitAll(room);
            // Start first turn timer via basraAdvanceTurn logic
            if (room.turnTimer > 0) {
                basraClearBasraTimer(room);
                room._timerRemaining = room.turnTimer;
                room._timerInterval = setInterval(() => {
                    room._timerRemaining--;
                    basraBroadcast(room, 'basraTimerTick', { remaining: room._timerRemaining, currentPlayer: room.currentPlayer });
                    if (room._timerRemaining <= 0) { clearInterval(room._timerInterval); room._timerInterval = null; }
                }, 1000);
                room._timerTimeout = setTimeout(() => {
                    room._timerTimeout = null;
                    if (room._timerInterval) { clearInterval(room._timerInterval); room._timerInterval = null; }
                    if (room.gameOver || room.roundOver) return;
                    const p = room.slots[room.currentPlayer];
                    if (!p) return;
                    if (p.hand.length === 0 && !room.committedCard) return;
                    if (room.committedCard && room.committedBy === room.currentPlayer) {
                        const thrownCard = room.committedCard;
                        room.tableCards.push(thrownCard);
                        room.committedCard = null;
                        room.committedBy = null;
                        basraBroadcast(room, 'toast', `${p.name} זרק ${thrownCard} (פג הזמן)`);
                        basraAdvanceTurn(room);
                    } else {
                        const randomCard = p.hand[Math.floor(Math.random() * p.hand.length)];
                        p.hand.splice(p.hand.indexOf(randomCard), 1);
                        room.tableCards.push(randomCard);
                        room.committedCard = null;
                        room.committedBy = null;
                        basraBroadcast(room, 'toast', `${p.name} זרק ${randomCard} (פג הזמן)`);
                        basraAdvanceTurn(room);
                    }
                }, room.turnTimer * 1000);
            }
        }
        console.log(`[basra] ${name} joined room ${code}`);
    });

    // ── Phase 1: play card to table ──
    socket.on('basraCommitCard', ({ card }) => {
        const code = socket.data.basraRoom;
        const slotIdx = socket.data.basraSlot;
        const room = basraRooms[code];
        if (!room || room.gameOver || room.roundOver) return;
        if (room.currentPlayer !== slotIdx) { socket.emit('basraError', 'לא התורך'); return; }
        const p = room.slots[slotIdx];
        if (!p.hand.includes(card)) { socket.emit('basraError', 'קלף לא ביד'); return; }
        // Remove from hand, place on table as "committed"
        p.hand.splice(p.hand.indexOf(card), 1);
        room.committedCard = card;
        room.committedBy = slotIdx;
        // Don't clear timer — let it continue. If it fires, it will throw the committed card.
        basraEmitAll(room);
    });

    // ── Phase 2: confirm capture ──
    socket.on('basraCapturePreview', ({ captureIndices, groups }) => {
        const code = socket.data.basraRoom;
        if (!code || !basraRooms[code]) return;
        const room = basraRooms[code];
        // Broadcast to all OTHER players in room
        basraBroadcastExcept(room, socket.id, 'basraCapturePreview', { captureIndices, groups });
    });

    socket.on('basraPlay', ({ captureIndices }) => {
        const code = socket.data.basraRoom;
        const slotIdx = socket.data.basraSlot;
        const room = basraRooms[code];
        if (!room || room.gameOver || room.roundOver) return;
        if (room.committedBy !== slotIdx) { socket.emit('basraError', 'לא התורך'); return; }

        const card = room.committedCard;

        const result = basra.playCard(room, slotIdx, card, captureIndices || [], true);
        if (!result.ok) {
            // Keep committedCard so player can retry — it's still their turn
            socket.emit('basraError', result.error);
            basraEmitAll(room); // re-emit so client stays in capture phase
            return;
        }

        // Reset consecutive timeouts on successful play
        if (room._consecutiveTimeouts) room._consecutiveTimeouts[slotIdx] = 0;

        room.committedCard = null;
        room.committedBy = null;

        const p = room.slots[slotIdx];
        if (result.capturedCards.length > 0) {
            basraBroadcast(room, 'toast', result.basra ? `⚡ BASRA! ${p.name}` : `${p.name} תפס ${result.capturedCards.length} קלפים`);
            if (result.basra) basraBroadcast(room, 'basraEvent', { type: 'basra', player: slotIdx, name: p.name });
        }

        basraAdvanceTurn(room);
    });

    socket.on('basraNextRound', () => {
        const code = socket.data.basraRoom;
        const room = basraRooms[code];
        if (!room || !room.roundOver || room.gameOver) return;
        // Clear any running timer before starting new round
        basraClearBasraTimer(room);
        room._consecutiveTimeouts = {};
        basra.resetRound(room);
        basraBroadcast(room, 'toast', `סיבוב ${room.roundNum + 1} מתחיל!`);
        basraEmitAll(room);
        // Start timer for first player of new round
        if (room.turnTimer > 0 && !room.gameOver) {
            room._timerStarted = Date.now();
            room._timerRemaining = room.turnTimer;
            room._timerInterval = setInterval(() => {
                room._timerRemaining--;
                basraBroadcast(room, 'basraTimerTick', { remaining: room._timerRemaining, currentPlayer: room.currentPlayer });
                if (room._timerRemaining <= 0) { clearInterval(room._timerInterval); room._timerInterval = null; }
            }, 1000);
            room._timerTimeout = setTimeout(() => {
                room._timerTimeout = null;
                if (room._timerInterval) { clearInterval(room._timerInterval); room._timerInterval = null; }
                if (room.gameOver || room.roundOver) return;
                const p = room.slots[room.currentPlayer];
                if (!p) return;
                if (p.hand.length === 0 && !room.committedCard) return;
                if (room.committedCard && room.committedBy === room.currentPlayer) {
                    const thrown = room.committedCard;
                    room.tableCards.push(thrown);
                    room.committedCard = null; room.committedBy = null;
                    basraBroadcast(room, 'toast', `${p.name} זרק ${thrown} (פג הזמן)`);
                    basraAdvanceTurn(room);
                } else {
                    const randomCard = p.hand[Math.floor(Math.random() * p.hand.length)];
                    p.hand.splice(p.hand.indexOf(randomCard), 1);
                    room.tableCards.push(randomCard);
                    room.committedCard = null; room.committedBy = null;
                    basraBroadcast(room, 'toast', `${p.name} זרק ${randomCard} (פג הזמן)`);
                    basraAdvanceTurn(room);
                }
            }, room.turnTimer * 1000);
        }
    });

    socket.on('basraReconnect', ({ code, username }) => {
        const room = basraRooms[code?.toUpperCase()];
        if (!room) return;
        const slot = room.slots.find(s => s.username === username || s.name === username);
        if (!slot) return;
        slot.socketId = socket.id;
        slot.connected = true;
        socket.data.basraRoom = code.toUpperCase();
        socket.data.basraSlot = slot.id;
        socket.join('basra_' + code.toUpperCase());
        if (room.gameStarted) basraEmitAll(room);
    });

    socket.on('basraLeave', () => {
        const code = socket.data.basraRoom;
        if (code && basraRooms[code]) {
            const room = basraRooms[code];
            const slotIdx = socket.data.basraSlot;
            const slot = room.slots[slotIdx];
            if (slot) { slot.connected = false; slot.socketId = null; }

            // Creator (slot 0) leaving → close room entirely
            if (slotIdx === 0) {
                basraClearBasraTimer(room);
                room.gameOver = true;
                basraBroadcastExcept(room, socket.id, 'toast', `${slot?.name || 'היוצר'} סגר את החדר`);
                basraBroadcastExcept(room, socket.id, 'basraRoomClosed', {});
                delete basraRooms[code];
                socket.data.basraRoom = null;
                socket.data.basraSlot = null;
                return;
            }

            // If game already over, ensure remaining players see the result
            if (room.gameOver) {
                const sorted = [...room.slots].sort((a,b) => (b.score||0)-(a.score||0));
                basraBroadcastExcept(room, socket.id, 'basraGameOver', {
                    names: sorted.map(s=>s.name), scores: sorted.map(s=>s.score||0)
                });
            }
            // If game was in progress, declare forfeit
            if (room.gameStarted && !room.gameOver) {
                basraClearBasraTimer(room);
                room.gameOver = true;
                basraBroadcast(room, 'toast', `${slot?.name || 'שחקן'} עזב — הוכרז כמפסיד`);
                basraBroadcast(room, 'basraGameOver', {
                    names: room.slots.map(s => s.name),
                    scores: room.slots.map(s => s.score || 0),
                    forfeitBy: slotIdx,
                    forfeitName: slot?.name || 'שחקן',
                });
                basraEmitAll(room);
                const forfeitWinner = room.slots.findIndex((s,i) => i !== slotIdx);
                setTimeout(() => settleBasraCoins(room, forfeitWinner).catch(e => console.error('[basra coins]', e.message)), 300);
            } else {
                basraBroadcast(room, 'toast', `${slot?.name || 'שחקן'} עזב`);
            }
        }
        socket.data.basraRoom = null;
        socket.data.basraSlot = null;
    });

    socket.on('basraForfeit', () => {
        const code = socket.data.basraRoom;
        if (!code || !basraRooms[code]) return;
        const room = basraRooms[code];
        const slotIdx = socket.data.basraSlot;
        const slot = room.slots[slotIdx];
        if (!slot) return;

        basraClearBasraTimer(room);
        room.gameOver = true;

        // Find winner(s) — everyone else
        const winners = room.slots.filter((s, i) => i !== slotIdx);
        const loserName = slot.name;

        basraBroadcast(room, 'toast', `${loserName} עזב — המשחק הסתיים`);
        basraBroadcast(room, 'basraGameOver', {
            names: room.slots.map(s => s.name),
            scores: room.slots.map(s => s.score || 0),
            forfeitBy: slotIdx,
            forfeitName: loserName,
        });
        const fWinner = room.slots.findIndex((s,i) => i !== slotIdx);
        setTimeout(() => settleBasraCoins(room, fWinner).catch(e => console.error('[basra coins]', e.message)), 300);

        slot.connected = false;
        slot.socketId = null;
        socket.data.basraRoom = null;
        socket.data.basraSlot = null;
    });
}


const PORT = process.env.PORT || 3000;
// Start server only after MongoDB is ready
connectMongo().then(connected => {
    if (!connected) {
        console.error('[fatal] Could not connect to MongoDB. Exiting.');
        process.exit(1);
    }
    server.listen(PORT, () => {
        console.log(`🃏 Shithead server running on port ${PORT} ✅`);
    });
});
