'use strict';
// ══════════════════════════════════════════════
//  BASRA GAME LOGIC (server-side module)
// ══════════════════════════════════════════════

const BASRA_ACCESS_CODE = null; // no access code required

function makeDeck() {
    const suits = ['h','d','c','s'];
    const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    const deck = [];
    for (const s of suits) for (const r of ranks) deck.push(r + s);
    return deck;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function cardRank(card) {
    return card.slice(0, -1);
}

function rankValue(rank) {
    if (rank === 'A') return 1;
    if (rank === 'J' || rank === 'Q' || rank === 'K') return null; // face cards: no numeric value
    return parseInt(rank);
}

function is7D(card) { return card === '7d'; }
function isJack(card) { return cardRank(card) === 'J'; }

// Find all subsets of tableCards that sum to targetVal
// Returns array of valid capture groups (each group is array of card strings)
function findCaptures(playedCard, tableCards) {
    const rank = cardRank(playedCard);

    // Jack: captures everything
    if (rank === 'J') {
        return tableCards.length > 0 ? [tableCards.slice()] : [];
    }

    // 7♦: captures everything
    if (is7D(playedCard)) {
        return tableCards.length > 0 ? [tableCards.slice()] : [];
    }

    // 7♦ trap: if table has ONLY 7♦, ANY card can capture it (even Q/K)
    if (tableCards.length === 1 && is7D(tableCards[0])) {
        return [[tableCards[0]]];
    }

    // Q can only capture Q, K can only capture K
    if (rank === 'Q' || rank === 'K') {
        const matches = tableCards.filter(c => cardRank(c) === rank);
        return matches.length > 0 ? [matches] : [];
    }

    const val = rankValue(rank);
    if (val === null) return [];

    // Find all subsets summing to val
    const result = [];
    const n = tableCards.length;

    for (let mask = 1; mask < (1 << n); mask++) {
        let sum = 0;
        const group = [];
        let valid = true;
        for (let i = 0; i < n; i++) {
            if (mask & (1 << i)) {
                const v = rankValue(cardRank(tableCards[i]));
                if (v === null) { valid = false; break; } // face card in group — can't sum
                sum += v;
                group.push(tableCards[i]);
            }
        }
        if (valid && sum === val) result.push(group);
    }

    // Also add pairs (same rank) that may have been covered by sum already
    // (they're already found as single-element groups summing to val, or multi-element)
    return result;
}

// Determine if a capture results in a Basra
function isBasra(playedCard, capturedCards, tableCards) {
    // Must clear entire table
    if (capturedCards.length !== tableCards.length) return false;
    if (tableCards.length === 0) return false;

    const rank = cardRank(playedCard);

    // Jack: basra only if table has ONLY J cards, or ONLY 7♦
    if (rank === 'J') {
        if (tableCards.length === 0) return false;
        const allJacks = tableCards.every(c => cardRank(c) === 'J');
        const only7d = tableCards.length === 1 && is7D(tableCards[0]);
        return allJacks || only7d;
    }

    // 7♦: acts as any card to make basra
    // - Single card on table (any rank incl Q/K/J) → basra always (J = 20pts)
    // - Multiple numeric cards: partition into equal-sum groups → basra
    // - Multiple cards with face cards mixed → no basra
    if (is7D(playedCard)) {
        if (tableCards.length === 0) return false;
        if (tableCards.length === 1) return true; // single card → basra always
        // All same Q or all same K → basra
        const allSameFace = tableCards.every(c => cardRank(c) === cardRank(tableCards[0])) &&
            ['Q','K'].includes(cardRank(tableCards[0]));
        if (allSameFace) return true;
        // Any J on table → basra (J basra = 20pts)
        if (tableCards.some(c => cardRank(c) === 'J')) return true;
        const faceRanks = ['J','Q','K'];
        const rv = r => r==='A' ? 1 : (faceRanks.includes(r) ? null : parseInt(r));
        const vals = tableCards.map(c => rv(cardRank(c)));
        if (vals.some(v => v === null)) return false;
        for (let val = 1; val <= 10; val++) {
            const remaining = [...vals];
            let ok = true;
            while (remaining.length > 0) {
                const n = remaining.length;
                let found = false;
                for (let mask = 1; mask < (1<<n); mask++) {
                    let sum = 0; const idxs = [];
                    for (let i = 0; i < n; i++) { if (mask & (1<<i)) { sum += remaining[i]; idxs.push(i); } }
                    if (sum === val) { idxs.reverse().forEach(i => remaining.splice(i, 1)); found = true; break; }
                }
                if (!found) { ok = false; break; }
            }
            if (ok) return true;
        }
        return false;
    }

    // If table had only 7♦ (the "trap") and played card captured it → basra
    if (tableCards.length === 1 && is7D(tableCards[0])) return true;

    // Numeric card: basra if it clears the table
    return true;
}

function createBasraRoom(code, slots, bet = 0) {
    const deck = shuffle(makeDeck());

    // Deal 4 to table — include J and 7♦ (shown during deal, then replaced after)
    let tableCards = [];
    for (let i = 0; i < 4; i++) {
        tableCards.push(deck.shift());
    }
    const specialReplacements = tableCards
        .filter(c => cardRank(c) === 'J' || is7D(c));

    // Deal 4 to each player
    // Deal 4 to each player
    slots.forEach(s => {
        s.hand = [];
        s.captured = [];
        s.basras = 0;
        s.basraCards = [];
        s.jackBasras = 0;
        s.score = 0; // cumulative game score
    });

    for (let i = 0; i < 4; i++) {
        slots.forEach(s => s.hand.push(deck.shift()));
    }

    // Teams assigned externally after all players join
    let teams = null;

    return {
        code,
        gameType: 'basra',
        specialReplacements, // cards that were shown then sent to end of deck
        slots,
        deck,
        tableCards,
        currentPlayer: 0,
        lastCapturer: null,
        roundOver: false,
        gameOver: false,
        bet,
        coinsSettled: false,
        leaversOrder: [],
        winnersOrder: [],
        pendingMajorityPoints: 0,
        roundNum: 0,
        teams, // null for 2p, [[0,2],[1,3]] for 4p
    };
}

function dealNewHands(room) {
    if (room.deck.length === 0) return false;
    room.slots.forEach(s => {
        const count = Math.min(4, room.deck.length);
        for (let i = 0; i < count; i++) {
            if (room.deck.length > 0) s.hand.push(room.deck.shift());
        }
    });
    return true;
}

// Play a card from hand. selectedCapture = array of table card indices to capture.
// Returns { ok, basra, capturedCards, error }
function playCard(room, slotIdx, cardStr, selectedCapture, alreadyRemoved) {
    const p = room.slots[slotIdx];
    if (!alreadyRemoved) {
        const cardIdx = p.hand.indexOf(cardStr);
        if (cardIdx === -1) return { ok: false, error: 'קלף לא ביד' };
        p.hand.splice(cardIdx, 1);
    }

    const rank = cardRank(cardStr);
    const tableCards = room.tableCards;

    // Validate capture selection
    let captureGroup = null;
    if (selectedCapture && selectedCapture.length > 0) {
        // Verify these cards are on table
        captureGroup = selectedCapture.map(idx => tableCards[idx]).filter(Boolean);
        if (captureGroup.length !== selectedCapture.length) return { ok: false, error: 'קלף לא על השולחן' };

        // For Jack and 7♦, capture all
        if (isJack(cardStr) || is7D(cardStr)) {
            captureGroup = tableCards.slice();
        } else if (rank === 'Q' || rank === 'K') {
            captureGroup = tableCards.filter(c => cardRank(c) === rank);
            if (captureGroup.length === 0) return { ok: false, error: 'אין קלף תואם לתפוס' };
        } else {
            // Validate: selected cards must be covered by non-overlapping valid capture groups.
            // e.g. playing 9 against [9,6,2,A]: selecting all 4 is valid because {9} + {6,2,A} = 9
            const cardVal = rankValue(rank);
            if (cardVal === null) return { ok: false, error: 'תפיסה לא חוקית' };

            // Get all valid groups (subsets of tableCards summing/matching to cardVal)
            const allGroups = findCaptures(cardStr, tableCards); // array of card-string arrays
            // Convert selectedCapture (indices) to card strings for matching
            const selectedCards = captureGroup.slice(); // already mapped above

            // Greedy cover: try to cover all selectedCards with non-overlapping valid groups
            const remaining = [...selectedCards];
            for (const group of allGroups) {
                if (remaining.length === 0) break;
                // Check if this group is a subset of remaining
                const groupSet = new Set(group);
                const canUse = group.every(gc => {
                    const idx = remaining.indexOf(gc);
                    return idx !== -1;
                });
                if (canUse) {
                    // Remove used cards from remaining
                    for (const gc of group) {
                        const idx = remaining.indexOf(gc);
                        if (idx !== -1) remaining.splice(idx, 1);
                    }
                }
            }
            if (remaining.length > 0) return { ok: false, error: 'תפיסה לא חוקית' };
        }
    } else if (isJack(cardStr) || is7D(cardStr)) {
        // Auto-capture all for Jack and 7♦
        captureGroup = tableCards.slice();
    } else {
        // selectedCapture was empty [] — player chose to throw (no capture)
        captureGroup = [];
    }

    // Card already removed from hand (done in commit phase)

    let basraScored = false;
    let capturedCards = [];

    if (captureGroup && captureGroup.length > 0) {
        // Remove captured cards from table
        capturedCards = captureGroup.slice();
        room.tableCards = tableCards.filter(c => !captureGroup.includes(c));

        // Add played card + captured to player's capture pile
        p.captured.push(cardStr, ...capturedCards);
        room.lastCapturer = slotIdx;

        // Check basra
        if (room.tableCards.length === 0) {
            basraScored = isBasra(cardStr, capturedCards, tableCards);
            if (basraScored) {
                p.basras++;
                if (!p.basraCards) p.basraCards = [];
                // If J is involved (played card is J, or captured cards include J) → jack basra (20pts)
                const jackInvolved = cardRank(cardStr) === 'J' || capturedCards.some(cc => cardRank(cc) === 'J') || (is7D(cardStr) && tableCards.some(cc => cardRank(cc) === 'J'));
                const basraCard = jackInvolved ? (cardRank(cardStr) === 'J' ? cardStr : capturedCards.find(cc => cardRank(cc) === 'J')) : cardStr;
                p.basraCards.push({ card: basraCard, jack: jackInvolved });
                if (jackInvolved) p.jackBasras = (p.jackBasras || 0) + 1;
            }
        }
    } else {
        // Card goes to table
        room.tableCards.push(cardStr);
    }

    return { ok: true, basra: basraScored, capturedCards };
}

// Score a round
function scoreRound(room) {
    const scores = room.slots.map((s, i) => ({
        slotIdx: i,
        name: s.name,
        cards: s.captured.length,
        basras: s.basras || 0,
        jackBasras: s.jackBasras || 0,
        majorityPoints: 0,
        points: 0,
        teamIdx: null,
    }));

    if (room.teams) {
        // 4-player team mode: combine ALL stats per team → single team score
        const teamStats = room.teams.map((team, ti) => {
            const teamCards = team.reduce((sum, idx) => sum + scores[idx].cards, 0);
            const teamBasras = team.reduce((sum, idx) => sum + (room.slots[idx].basras||0), 0);
            const teamJackBasras = team.reduce((sum, idx) => sum + (room.slots[idx].jackBasras||0), 0);
            team.forEach(idx => {
                scores[idx].teamIdx = ti;
                scores[idx].teamCards = teamCards;
                scores[idx].teamBasras = teamBasras;
                scores[idx].teamJackBasras = teamJackBasras;
            });
            return { teamCards, teamBasras, teamJackBasras };
        });

        // Majority: compare combined team card counts
        const maxTeamCards = Math.max(...teamStats.map(t => t.teamCards));
        const winningTeamIdx = teamStats.findIndex(t => t.teamCards === maxTeamCards);
        const tiedMajority = teamStats.filter(t => t.teamCards === maxTeamCards).length > 1;

        room.teams.forEach((team, ti) => {
            const st = teamStats[ti];
            // Combined team points = majority + basras
            let teamPts = 0;
            let majorityPts = 0;
            if (!tiedMajority && ti === winningTeamIdx) {
                majorityPts = 30 + room.pendingMajorityPoints;
                teamPts += majorityPts;
            }
            const regularBasras = st.teamBasras - st.teamJackBasras;
            teamPts += regularBasras * 10 + st.teamJackBasras * 20;
            // Both team members get identical points
            team.forEach(idx => {
                scores[idx].points = teamPts;
                scores[idx].majorityPoints = majorityPts;
            });
        });
        if (!tiedMajority) {
            room.pendingMajorityPoints = 0;
        } else {
            room.pendingMajorityPoints += 30;
        }

    } else {
        // 2-player mode
        const maxCards = Math.max(...scores.map(p => p.cards));
        const leaders = scores.filter(p => p.cards === maxCards);
        if (leaders.length === 1) {
            const pts = 30 + room.pendingMajorityPoints;
            leaders[0].points += pts;
            leaders[0].majorityPoints = pts;
            room.pendingMajorityPoints = 0;
        } else {
            room.pendingMajorityPoints += 30;
        }
        for (const s of room.slots) {
            const idx = room.slots.indexOf(s);
            scores[idx].points += ((s.basras||0)-(s.jackBasras||0))*10 + (s.jackBasras||0)*20;
        }
    }

    // Apply to cumulative scores
    if (room.teams) {
        // Both team members share the same points
        room.teams.forEach(team => {
            team.forEach(idx => {
                room.slots[idx].score = (room.slots[idx].score || 0) + scores[idx].points;
            });
        });
    } else {
        scores.forEach((sc, i) => {
            room.slots[i].score = (room.slots[i].score || 0) + sc.points;
        });
    }

    return scores;
}

function resetRound(room) {
    const deck = shuffle(makeDeck());

    // TEST: Force J and 7d in table
    let tableCards = [];
    const _7dIdx2 = deck.indexOf('7d');
    if (_7dIdx2 !== -1) tableCards.push(deck.splice(_7dIdx2, 1)[0]);
    const _jIdx2 = deck.findIndex(c => c.slice(0,-1) === 'J');
    if (_jIdx2 !== -1) tableCards.push(deck.splice(_jIdx2, 1)[0]);
    while (tableCards.length < 4) tableCards.push(deck.shift());
    room.specialReplacements = tableCards.filter(c => cardRank(c) === 'J' || is7D(c));

    room.deck = deck;
    room.tableCards = tableCards;
    room.lastCapturer = null;
    room.roundOver = false;
    room.roundNum++;

    // Rotate: next round starts with player after whoever STARTED the previous round
    const n = room.slots.length;
    const prevStarter = room.roundStarter !== undefined ? room.roundStarter : 0;
    room.currentPlayer = (prevStarter + 1) % n;
    room.roundStarter = room.currentPlayer;

    room.slots.forEach(s => {
        s.hand = [];
        s.captured = [];
        s.basras = 0;
        s.basraCards = [];
        s.jackBasras = 0;
    });

    for (let i = 0; i < 4; i++) {
        room.slots.forEach(s => s.hand.push(deck.shift()));
    }
}

module.exports = {
    BASRA_ACCESS_CODE,
    createBasraRoom,
    dealNewHands,
    playCard,
    findCaptures,
    isBasra,
    scoreRound,
    resetRound,
    cardRank,
    rankValue,
    is7D,
    isJack,
};
