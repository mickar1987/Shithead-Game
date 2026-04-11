const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const basra = require('./basra-server');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════
//  LOGIC: SHITHEAD IMPROVED AI ENGINE (V2.0)
// ══════════════════════════════════════════════

/**
 * מחזיר ערך מספרי לקלף לצורך השוואה אסטרטגית.
 * 2 ו-10 מקבלים ערך גבוה כי הם קלפים חזקים ששומרים לסוף.
 */
function getRankValue(card) {
    const r = card.slice(0, -1);
    if (r === '2') return 15;
    if (r === '10') return 16;
    if (r === 'A') return 14;
    if (r === 'K') return 13;
    if (r === 'Q') return 12;
    if (r === 'J') return 11;
    return parseInt(r);
}

/**
 * בודק אם חוקי לשחק קלף מסוים על הקופה הקיימת
 */
function canPlay(card, pile, lastPlayedRank) {
    const r = card.slice(0, -1);
    if (r === '2' || r === '10') return true;
    if (!lastPlayedRank) return true;

    const val = getRankValue(card);
    // המרת הדרגה האחרונה לערך להשוואה
    const lastVal = getRankValue(lastPlayedRank + 's'); 

    if (lastPlayedRank === '7') return val <= 7;
    return val >= lastVal;
}

/**
 * המוח של הבוט: בוחר את המהלך הכי חכם
 */
function getSmartBotMove(hand, pile, lastRank) {
    const validCards = hand.filter(c => canPlay(c, pile, lastRank));
    if (validCards.length === 0) return null;

    // הפרדה בין קלפים רגילים לקלפי כוח
    const powerCards = validCards.filter(c => ['2', '10'].includes(c.slice(0, -1)));
    const normalCards = validCards.filter(c => !['2', '10'].includes(c.slice(0, -1)));

    // 1. אסטרטגיה: להיפטר מקלפים רגילים נמוכים קודם כל
    if (normalCards.length > 0) {
        normalCards.sort((a, b) => getRankValue(a) - getRankValue(b));
        const lowestRank = normalCards[0].slice(0, -1);
        // המחשב ישחק את כל הקלפים מאותו סוג שיש לו (למשל זוג 4)
        return normalCards.filter(c => c.slice(0, -1) === lowestRank);
    }

    // 2. שימוש בקלפי כוח רק כשאין ברירה אחרת
    if (powerCards.length > 0) {
        // אם הקופה גדולה (מעל 3 קלפים), המחשב ישרוף אותה עם 10
        const ten = powerCards.find(c => c.startsWith('10'));
        if (ten && pile.length > 3) return [ten];
        
        // אחרת ישתמש ב-2 (או ב-10 אם זה מה שנשאר)
        const two = powerCards.find(c => c.startsWith('2'));
        return [two || powerCards[0]];
    }

    return null;
}

/**
 * פונקציית התור של המחשב - משופרת
 */
async function doBotTurn(room) {
    const slot = room.slots[room.currentPlayer];
    if (!slot || !slot.isBot || room.gameOver || room.waitingForEight) return;

    let cardsToPlay = null;

    // סדר עדיפויות: יד -> קלפים גלויים -> קלפים מכוסים
    if (slot.hand.length > 0) {
        cardsToPlay = getSmartBotMove(slot.hand, room.pile, room.lastPlayedRank);
    } else if (slot.faceUp.length > 0) {
        cardsToPlay = getSmartBotMove(slot.faceUp, room.pile, room.lastPlayedRank);
    } else if (slot.faceDown.length > 0) {
        // בקלפים מכוסים המחשב מהמר על קלף אקראי
        const idx = Math.floor(Math.random() * slot.faceDown.length);
        cardsToPlay = [slot.faceDown[idx]];
    }

    // השהייה קלה כדי לדמות חשיבה אנושית
    setTimeout(() => {
        if (!cardsToPlay) {
            handlePickUp(room, room.currentPlayer);
        } else {
            handlePlayCards(room, room.currentPlayer, cardsToPlay);
        }
    }, 1200);
}

// ══════════════════════════════════════════════
//  REST OF SERVER LOGIC (המשך הקוד המקורי שלך)
// ══════════════════════════════════════════════

// כאן יש להמשיך עם שאר הפונקציות המקוריות: 
// handlePlayCards, handlePickUp, sockets, וחיבור ל-DB.
// (מטעמי אורך, וודא שאתה שומר על הפונקציות האלו מהקוד המקורי שלך)

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
