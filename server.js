const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

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
    let remaining = 40;
    broadcast(room, 'swapTick', { remaining });

    roomTimers[key] = setInterval(() => {
        remaining--;
        broadcast(room, 'swapTick', { remaining });
        if (remaining <= 0) {
            clearRoomTimer(key);
            // Auto-end swap for all players who haven't ended yet
            room.slots.forEach(s => { s._swapDone = true; });
            const starter = findStarter(room.slots);
            room.isSwapPhase = false;
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

                // Disqualify after 2 consecutive timeouts = treat as leave
                if (p.consecutiveTimeouts >= 2) {
                    broadcast(room, 'toast', `⏰ ${p.name} לא שיחק — מוכרז כיוצא`);
                    p.disqualified = true;
                    handlePlayerLeave({ roomCode: room.code, slotIdx: autoSlot });
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
        hand: deck.splice(0, 3),
        faceUp: deck.splice(0, 3),
        faceDown: deck.splice(0, 3),
        finished: false,
        connected: s.connected,
        consecutiveTimeouts: 0,
    }));
    room.drawPile = deck;
    room.pile = [];
    room.currentPlayer = 0;
    room.isSwapPhase = true;
    room.winnersOrder = [];
    room.gameOver = false;
    room.interruptWindow = false;
    room.lastPlayedRank = null;
    room.lastPlayerIdx = null;
    room.restartVotes = new Set();
    clearRoomTimer(room.code);
    clearRoomTimer(room.code + '_swap');
}

function createRoom(hostSocketId, hostName, playerCount) {
    const code = makeCode();
    const deck = makeDeck();
    const slots = Array.from({ length: playerCount }, (_, i) => ({
        id: i,
        name: null,
        socketId: null,
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
        gameOver: false,
        started: false,
        hostSocketId,
        interruptWindow: false,
        lastPlayedRank: null,
        lastPlayerIdx: null,
        burnInterrupt: {},  // slotIdx -> count needed to burn
    };
    return code;
}

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
            broadcast(room, 'gameOver', room.winnersOrder.map(i => room.slots[i].name));
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

    const skips = r === '8' ? cards.length + 1 : 1;

    // Open interrupt window — only for normal cards (not 8/10/burn)
    // Last player can add same rank before next player acts
    room.interruptWindow = true;
    room.lastPlayedRank = r;
    room.lastPlayerIdx = playerIdx;
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

io.on('connection', (socket) => {

    // ── Create room ──
    socket.on('createRoom', ({ name, playerCount, turnTimer, isPublic }) => {
        const code = createRoom(socket.id, name, playerCount);
        rooms[code].turnTimer = turnTimer || 0;
        rooms[code].isPublic = !!isPublic;
        rooms[code].createdAt = Date.now();
        const room = rooms[code];
        room.slots[0].name = name;
        room.slots[0].socketId = socket.id;
        room.slots[0].connected = true;
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.slotIdx = 0;
        socket.emit('roomCreated', { code, slotIdx: 0 });
        emitStateToPlayer(room, 0);
    });

    // ── Open room (host decides when to start) ──
    socket.on('createOpenRoom', ({ name, turnTimer, isPublic }) => {
        const code = [...Array(4)].map(() => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random()*23)]).join('');
        const room = {
            code,
            slots: [{
                id: 0, name, socketId: socket.id, connected: true,
                hand: [], faceUp: [], faceDown: [], finished: false,
                consecutiveTimeouts: 0
            }],
            playerCount: 1, // grows as players join
            drawPile: [], pile: [],
            currentPlayer: 0, isSwapPhase: null, // null = lobby, true/false = in game
            winnersOrder: [], gameOver: false,
            interruptWindow: false, lastPlayedRank: null, lastPlayerIdx: null,
            turnTimer: turnTimer || 0,
            openRoom: true,  // flag: host controls start
            isPublic: !!isPublic,
            createdAt: Date.now(),
            hostSocketId: socket.id,
            restartVotes: new Set()
        };
        rooms[code] = room;
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.slotIdx = 0;
        socket.emit('openRoomCreated', { code, slotIdx: 0 });
        emitOpenLobby(room);
    });

    // ── Join open room ──
    socket.on('joinRoom', ({ code, name }) => {
        const room = rooms[code];
        if (!room) { socket.emit('error', 'חדר לא נמצא'); return; }
        if (room.openRoom && !room.gameStarted) {
            if (room.slots.length >= 4) { socket.emit('error', 'החדר מלא (4 שחקנים)'); return; }
            const slotIdx = room.slots.length;
            room.slots.push({
                id: slotIdx, name, socketId: socket.id, connected: true,
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
        slot.name = name; slot.socketId = socket.id; slot.connected = true;
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.slotIdx = slot.id;
        socket.emit('roomJoined', { code, slotIdx: slot.id });
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
        // Mark this player as done swapping
        room.slots[slotIdx]._swapDone = true;
        const allDone = room.slots.every(s => s._swapDone);
        if (allDone) {
            clearRoomTimer(room.code + '_swap');
            broadcast(room, 'swapTick', { remaining: 0 }); // hide timer on all clients
            room.isSwapPhase = false;
            // Find starter: lowest card with tie-break
            const starter = findStarter(room.slots);
            room.currentPlayer = starter;
            broadcast(room, 'toast', `המשחק התחיל! ${room.slots[starter].name} ראשון`);
            emitStateToAll(room);
            startTurnTimer(room);
        } else {
            const waiting = room.slots.filter(s => !s._swapDone).length;
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
                // After interrupt, same "next player" continues
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

        // faceUp phase: must take a faceUp card with pile
        if (p.hand.length === 0 && p.faceUp.some(Boolean) && faceUpCards?.length) {
            faceUpCards.forEach(c => {
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

        // Public rooms: host reopens lobby — others can join, then host starts
        if (room.isPublic && slotIdx === 0) {
            room.gameOver = false;
            room.gameStarted = false;
            room.openRoom = true;
            room.isSwapPhase = null;
            room.winnersOrder = [];
            room.restartVotes = new Set();
            room.pile = [];
            room.drawPile = [];
            // Keep connected players, clear card data
            room.slots.forEach(s => {
                s.hand = []; s.faceUp = [null,null,null]; s.faceDown = [null,null,null];
                s.finished = false; s.isBot = false;
                if (s.name && s.name.startsWith('🤖 ')) s.name = s.name.slice(3);
            });
            room.playerCount = room.slots.filter(s => s.connected).length;
            broadcast(room, 'toast', '🔄 המארח פתח לובי חדש!');
            broadcast(room, 'lobbyReopened', { code: room.code });
            emitOpenLobby(room);
            return;
        }

        // Non-public rooms: all-vote system
        room.restartVotes.add(slotIdx);
        const connected = room.slots.filter(s => s.connected);
        broadcast(room, 'playerWantsRestart', {
            readyCount: room.restartVotes.size,
            totalCount: connected.length
        });
        if (room.restartVotes.size >= connected.length) {
            room.restartVotes = new Set();
            restartRoom(room);
            broadcast(room, 'gameRestarted', {});
            setTimeout(() => { emitStateToAll(room); startSwapTimer(room); }, 300);
        }
    });

    // ── Leave room ──
    // ── Player voluntarily leaves ──
    function handlePlayerLeave(socketData) {
        const { roomCode, slotIdx } = socketData;
        const room = rooms[roomCode];
        if (!room) return;
        const slot = room.slots[slotIdx];
        if (!slot) return;
        const name = slot.name;
        slot.connected = false;
        slot.socketId = null;
        if (room.restartVotes) room.restartVotes.delete(slotIdx);

        const connected = room.slots.filter(s => s.connected).length;

        // If in lobby (not yet playing)
        const inLobby = !room.gameStarted && (room.isSwapPhase === null || room.isSwapPhase === true || room.openRoom);
        if (inLobby) {
            if (connected === 0 || slotIdx === 0) {
                // Host left or room empty → close and notify all
                broadcast(room, 'roomClosed', { reason: slotIdx === 0 ? 'המארח יצא מהחדר' : 'החדר נסגר' });
                clearRoomTimer(roomCode);
                clearRoomTimer(roomCode + '_swap');
                delete rooms[roomCode];
                return;
            }
            // Guest left — update lobby for remaining players
            broadcast(room, 'lobbyPlayerLeft', { name, newCount: connected });
            emitOpenLobby(room);
            return;
        }

        if (room.gameOver) {
            // Post-game — just remove
            broadcast(room, 'playerLeft', { name, newPlayerCount: connected });
            return;
        }

        // Mark as loser (last place)
        slot.finished = true;
        slot.disqualified = true;
        room.winnersOrder.push(slotIdx);
        broadcast(room, 'toast', `🚪 ${name} יצא מהמשחק`);

        // Count still-active players
        const active = room.slots.filter(s => !s.finished);

        if (active.length <= 1) {
            // Game over — last active player wins
            if (active.length === 1) {
                active[0].finished = true;
                room.winnersOrder.unshift(active[0].id);
            }
            room.gameOver = true;
            clearRoomTimer(room.code);
            broadcast(room, 'gameOver', room.winnersOrder.map(i => room.slots[i]?.name || '?'));
        } else {
            // Bot takes over
            slot.isBot = true;
            slot.finished = false; // un-finish so bot can keep playing
            room.winnersOrder.pop();  // remove from winners — will finish naturally
            slot.name = `🤖 ${name}`;
            broadcast(room, 'toast', `🤖 מחשב ממשיך במקום ${name}`);
            emitStateToAll(room);
            if (room.currentPlayer === slotIdx) {
                setTimeout(() => { if (rooms[roomCode]) doBotTurn(room); }, 800);
            }
        }
    }

    socket.on('playerLeaving', () => handlePlayerLeave(socket.data));

    socket.on('disconnect', () => {
        // Also handle unexpected disconnect same way
        if (socket.data?.roomCode) handlePlayerLeave(socket.data);
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
            return {
                code: r.code,
                players: connected,
                max,
                timerLabel: timerLabel(r.turnTimer || 0),
                available: isAvailable,
                inProgress,
                isFull
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
            setTimeout(() => { emitStateToAll(room); startSwapTimer(room); }, 300);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🃏 Shithead server running on port ${PORT}`));
