# Project instructions

## Release workflow
- Every change is a new version: bump `vX.YYY` in `public/index.html` (`appVersionEl` and the `BASRA OFFLINE ENGINE` comment).
- Commit with a message starting with the version, e.g. `v4.383: <what changed>`.
- **Always push the new version to `origin main` right after committing** — no need to ask.

## Structure
- `server.js` — main server (Shithead + socket handlers), loads `basra-server.js`.
- `basra-server.js` — Basra online game logic and scoring.
- `public/index.html` — the whole client, including an offline Basra bot engine with its own copy of the scoring (`_bScoreRound`) — keep it in sync with `basra-server.js`.
- `basra-rules.md` — Basra rules reference.

## AI training data (MongoDB `shithead_training`, vs-computer games only)
- Every event has `game` ('shithead' | 'basra') and `v` (app version) — compare AI changes per version.
- Shithead: client `aiTrackEvent()` → `POST /api/ai/event` (card_play, pile_take, burn, swap_done, game_end).
- Basra: server-side only — `basra.playCard` is wrapped in server.js → `basra_move` (incl. `basraAvailable` = missed-basra detection), `basra_round`, `basra_game_end` (in `recordBasraStats`).
- Summary: `GET /api/ai/stats?key=…` · raw events: `GET /api/ai/export?key=…&game=basra&type=basra_move&v=v4.385&limit=1000&skip=0`
- Restore point before the v4.385 AI/stats overhaul: git tag `v4.384-stable`, folder `backups/v4.384`.

## Coins vs computer (house bank)
- Bet is taken when the game starts (`startBotBet`), settled once at the end (`finishBotBet`) — same payout rule as online (`botBetDelta`). Unfinished game = loss; open > 6h is marked abandoned.
- Ledger + house balance = MongoDB `bot_bets` (no separate balance field). Shown on the admin page (`buildHouseHtml`).
- Shithead (runs in browser): `POST /api/botbet/start` / `/api/botbet/finish`. Basra (runs on server): bet in `basraCreateVsAI`, settled in `recordBasraStats`; the finish endpoint refuses Basra bets.
- Restore point before this feature: `backups/v4.385`.
