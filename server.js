const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const basra = require('./basra-server');
const basraRooms = {}; 
process.env.NODE_OPTIONS = process.env.NODE_OPTIONS || '';

// ══ COINS: settle bets at end of game ══
async function settleCoins(room) {
    if (room.coinsSettled || room.bet === 0) return;
    room.coinsSettled = true;
    const bet = room.bet;
    const order = room.winnersOrder.filter(i => !room.slots[i]?.isBot || room.slots[i]?.wasHuman);
    const n = order.length;
    if (n < 2) return;
    const changes = {};
    order.forEach(i => { changes[i] = 0; });

    if (n === 2) {
        changes[order[0]] = bet;
        changes[order[1]] = -bet;
    } else {
        changes[order[0]] = bet;
        changes[order[n - 1]] = -bet;
    }

    for (const iStr in changes) {
        const idx = parseInt(iStr);
        const slot = room.slots[idx];
        if (!slot || !slot.dbId) continue;
        try {
            await usersColl.updateOne({ _id: slot.dbId }, { $inc: { coins: changes[idx] } });
            console.log(`[Coins] ${slot.name}: ${changes[idx]}`);
        } catch (e) { console.error('[Coins Error]', e.message); }
    }
}

// ══ MONGO CONNECTION ══
const mongoUri = process.env.MONGO_URI || "mongodb+srv://test:test@cluster.mongodb.net/myDb";
let db, usersColl;
async function connectMongo() {
    try {
        const client = await MongoClient.connect(mongoUri);
        db = client.db();
        usersColl = db.collection('users');
        console.log('Connected to MongoDB');
    } catch (e) { console.error('Mongo connection error:', e.message); }
}

// ══ EXPRESS ROUTES ══
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/daily-coins', async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.json({ success: false, message: 'Missing deviceId' });
    try {
        const user = await usersColl.findOne({ deviceId });
        if (!user) return res.json({ success: false, message: 'User not found' });
        const now = Date.now();
        const last = user.lastDaily || 0;
        if (now - last < 24 * 60 * 60 * 1000) {
            const wait = Math.ceil((24 * 60 * 60 * 1000 - (now - last)) / (60 * 60 * 1000));
            return res.json({ success: false, message: `חזור בעוד ${wait} שעות` });
        }
        await usersColl.updateOne({ deviceId }, { $inc: { coins: 500 }, $set: { lastDaily: now } });
        res.json({ success: true, coins: (user.coins || 0) + 500 });
    } catch (e) { res.json({ success: false, message: 'Error' }); }
});

// ══ SHITHEAD LOGIC ══
const rooms = {};

function makeDeck() {
    const suits = ['h', 'd', 'c', 's'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (const s of suits) for (const r of ranks) deck.push(r + s);
    return shuffle(deck);
}
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
function getRankValue(card) {
    const r = card.slice(0, -1);
    if (r === 'J') return 11; if (r === 'Q') return 12; if (r === 'K') return 13; if (r === 'A') return 14;
    return parseInt(r);
}
function canPlay(card, pile, lastRank) {
    const r = card.slice(0, -1);
    if (r === '2' || r === '10') return true;
    if (!lastRank) return true;
    if (lastRank === '7') return getRankValue(card) <= 7;
    return getRankValue(card) >= getRankValue(lastRank + 's');
}

// ══════════════════════════════════════════════
//  IMPROVED AI ENGINE
// ══════════════════════════════════════════════
function getAiRankValue(card) {
    const r = card.slice(0, -1);
    if (r === '2') return 15; if (r === '10') return 16;
    return getRankValue(card);
}

function getSmartBotMove(hand, pile, lastRank) {
    const valid = hand.filter(c => canPlay(c, pile, lastRank));
    if (valid.length === 0) return null;
    const powers = valid.filter(c => ['2', '10'].includes(c.slice(0, -1)));
    const normals = valid.filter(c => !['2', '10'].includes(c.slice(0, -1)));
    if (normals.length > 0) {
        normals.sort((a, b) => getAiRankValue(a) - getAiRankValue(b));
        const bestRank = normals[0].slice(0, -1);
        return normals.filter(c => c.slice(0, -1) === bestRank);
    }
    if (powers.length > 0) {
        const ten = powers.find(c => c.startsWith('10'));
        if (ten && pile.length > 3) return [ten];
        const two = powers.find(c => c.startsWith('2'));
        return [two || powers[0]];
    }
    return null;
}

async function doBotTurn(room) {
    const slot = room.slots[room.currentPlayer];
    if (!slot || !slot.isBot || room.gameOver || room.waitingForEight) return;
    let toPlay = null;
    if (slot.hand.length > 0) toPlay = getSmartBotMove(slot.hand, room.pile, room.lastPlayedRank);
    else if (slot.faceUp.length > 0) toPlay = getSmartBotMove(slot.faceUp, room.pile, room.lastPlayedRank);
    else if (slot.faceDown.length > 0) toPlay = [slot.faceDown[Math.floor(Math.random() * slot.faceDown.length)]];

    setTimeout(() => {
        if (!toPlay) handlePickUp(room, room.currentPlayer);
        else handlePlayCards(room, room.currentPlayer, toPlay);
    }, 1200);
}

// ══════════════════════════════════════════════
//  SOCKETS & GAME ACTIONS (REMAINING)
// ══════════════════════════════════════════════

// (כאן מגיעה שאר הלוגיקה של הסוקטים מהקובץ המקורי שלך...)
// הערה: מחקתי כאן חלקים פחות רלוונטיים כדי להשאיר מקום, 
// אבל וודא שב-server.js שלך אתה שומר על handlePlayCards ו-handlePickUp.

function handlePlayCards(room, pIdx, cards) {
    // לוגיקת המשחק המקורית שלך...
}

function handlePickUp(room, pIdx) {
    // לוגיקת איסוף הקופה המקורית שלך...
}

// ... המשך פונקציות Socket.io ...

const PORT = process.env.PORT || 3000;
connectMongo().then(() => {
    server.listen(PORT, () =>
