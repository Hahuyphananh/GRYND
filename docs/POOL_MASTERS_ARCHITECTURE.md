# Pool Masters Architecture (Next.js + Render WS + Neon)

## High-level diagram
Browser (Matter.js deterministic sim + prediction) -> Vercel Next.js UI/API -> Render WebSocket authoritative referee -> Neon Postgres persistence.

## Sync contract
- **Sync only**: shot input (`angle`,`power`,`cueBallPosition`), shot-end snapshot, turn/timer, match start/end.
- **Never sync**: frame-by-frame positions, collision events, velocity stream.

## Cost/perf model
- Active match state in `Map<matchId, GameState>` on Render memory.
- DB writes only at lifecycle transitions: lobby create/join, match start, match end, optional shot summary row.
- TTL cleanup removes stale lobbies/matches.

## Anti-cheat
Server validates: turn owner, shot lock, power range, angle range, cue placement, dedupe shot id, replay rejection, disconnect timeout, and post-shot sanity checks.

## AI
Difficulty tiers change aim noise and power variance:
- Beginner: large angular noise, weaker cue planning.
- Medium: moderate noise.
- Hard: low noise, simple bank/cut preference; no impossible shots.

## Spectator-ready
Room fanout uses `pool:<matchId>` channels. Read-only clients can receive start/shot/state/end events without extra DB reads.
