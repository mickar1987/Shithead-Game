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
