# Production Realtime + Neon Optimization Task List

This file groups all high-priority production tasks into a single deployable plan.

## The topology

```
browser ──HTTPS──▶ Vercel  (Next.js app, API routes, authoritative game state)
   │                  │
   │                  └─HTTPS /emit + internal callbacks─▶ Render (Socket.IO)
   └──WSS / socket.io────────────────────────────────────────┘
```

Postgres (Neon) is reached **only** by Vercel. The realtime service holds no
database credentials and owns no game state: it authenticates sockets, tracks
room membership, relays events, and calls back into Vercel.

## Environment matrix

Two variables are consumed by *both* sides and must hold the **same** value.
Rows marked "browser" are public by design; everything else is server-only.

| VARIABLE | Used by (file) | Side | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SOCKET_URL` | `src/lib/socket.ts` (browser socket), `src/lib/speed-typing/realtime.ts` | **Vercel** (browser, build-time) | Public Render URL. Inlined at build time — changing it needs a redeploy. Only the trailing slash is normalised. |
| `REALTIME_INTERNAL_URL` | `src/lib/speed-typing/realtime.ts`, `src/lib/matchLifecycleRelay.ts`, `src/app/api/quick-queue/publish/route.ts` | **Vercel** | Server-to-server Render base URL for `/emit`. Falls back to `NEXT_PUBLIC_SOCKET_URL`; with neither set the relay no-ops (a missed push costs one poll). |
| `REALTIME_INTERNAL_SECRET` | `realtime-server/server.js` (`/emit`), `src/lib/speed-typing/realtime.ts`, `src/lib/adminNotify.ts`, relay routes | **BOTH** | Shared secret for Vercel→Render relay calls. Render answers **503** when it is unset and **401** on a mismatch. Vercel simply omits the header when unset. |
| `NEXTJS_INTERNAL_URL` | `realtime-server/server.js` (disconnect forfeits, admin verify, crash-arena cleanup, quick-queue) | **Render** | Vercel base URL for every Render→Vercel callback. Defaults to `http://localhost:3000` in code — an unset value in production **fails silently**: the service and its health check stay green while every callback is lost. |
| `CLIENT_URL` | `realtime-server/server.js` (CORS allowlist) | **Render** | Comma-separated web origins. The service **refuses to start** when it resolves to an empty list. Add preview domains alongside production. |
| `CLERK_SECRET_KEY` | `realtime-server/server.js` (socket auth), `src/app/api/speed-typing/disconnect-forfeit/route.ts`, `src/app/api/admin/socket-verify/route.ts` | **BOTH** | Same Clerk secret on both. On Render it verifies the socket's session token; on Vercel it re-verifies that token in the disconnect endpoints. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | client Clerk provider | **Vercel** (browser) | Public by design. |
| `DATABASE_URL` | `src/db/*`, `src/lib/rating.js`, `src/lib/trophyStore.js` | **Vercel** | Never needed on Render. |
| `PORT` | `realtime-server/server.js` | **Render** | Render assigns it to the service; the code falls back to `3001` for local development. See the caveat below before pinning it. |

Never commit a value for any row above. Every variable this split needs is
templated, value-free, in `.env.example` (Vercel) and `realtime-server/.env.example`
(Render).

## Realtime verification tasks

1. Set `NEXT_PUBLIC_SOCKET_URL` in **Vercel** to the public Render URL (e.g. `https://casino-app-2wnk.onrender.com`).
2. Set `CLIENT_URL` in **Render** to the exact Vercel production origin (e.g. `https://www.grynd.dedyn.io`; comma-separate preview origins if needed).
3. Set `NEXTJS_INTERNAL_URL` in **Render** to the Vercel origin. Without it, `/api/speed-typing/disconnect-forfeit` is called at `localhost` and a disconnected player is never forfeited.
4. Set `CLERK_SECRET_KEY` on render both **Render** and **Vercel**, and `REALTIME_INTERNAL_SECRET` to the **same** value on both.
5. Verify `GET /health` returns `allowedOrigins`, `clerkConfigured: true`, and `wsPath: /socket.io`.
6. Confirm the browser console shows a connected socket (`localStorage.debug = 'socket.io-client:*,engine.io-client:*'` then reload) — a CORS rejection appears as a `connect_error`.

### The `PORT` caveat (Render)

`render.yaml` currently pins `PORT: 3001`. That is the value production has been
verified against, so it is left in place. Render's router expects the process to
bind the port Render assigns, so if the service ever stops receiving traffic or
fails its health check after a Render change, **remove** the `PORT` key and let
`process.env.PORT || 3001` bind whatever Render assigns.

### Reconnect vs the disconnect grace window

The socket client retries 10 times with a 1s→4s capped backoff (≈35s nominal,
≈17.5s at the low end of Socket.IO's ±50% jitter, up to ≈52s at the high end).
The realtime server's forfeit grace window is 45s. The nominal case recovers
comfortably, but a worst-case jitter run can still be retrying when the timer
fires.

Two protections close that gap, and both are asserted by
`tests/speed-typing-deployment.test.mjs`:

* the timer **re-checks for a live socket** before forfeiting, and
* a `join_room` **cancels** the pending timer for that seat, and
* a failed/timed-out forfeit callback is **retried** (15s cadence, bounded), so a
  transient Vercel error does not become a lost match.

If false forfeits are ever observed in production, lengthen the grace window
before shortening the client's retry budget.

## DB connection string tasks

1. Standardize DB env usage in production routes.
2. Remove runtime dotenv loading in deployed API/server code.
3. Confirm production vars are present:
   - `DATABASE_URL`
   - `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING` (if any route uses `@vercel/postgres`)
4. Add one diagnostic endpoint that runs `SELECT 1` and reports which DB provider is active (without exposing secrets).

## Neon compute reduction tasks (priority order)

1. Replace hot polling loops with websocket-driven updates where possible.
2. Consolidate presence heartbeat writes and reduce write frequency.
3. Deduplicate repeated balance/token fetches with shared client state.
4. Add pagination and filtering defaults for heavy list endpoints (game history).
5. Reduce production console logging on frequently executed code paths.
6. Standardize singleton DB clients for serverless handlers.

## Secret hygiene

* `.gitignore` bans real env files at any depth (`**/.env`, `**/.env.*`) and
  permits only `*.example` placeholders.
* `realtime-server/.env` and `.env` were committed early in the project's history
  and later untracked. The values in that history do **not** match the values in
  use today (the historical Clerk entry is a short placeholder), so no live
  secret appears to have been exposed — but anyone rotating credentials should
  treat those paths as burned and re-issue rather than assume.
* `/api/debug-env` reports only booleans and a DB hostname, and returns 404 when
  `NODE_ENV === "production"`.

## Validation commands

- `curl -i https://casino-app-2wnk.onrender.com/health`
- In browser console:
  - `localStorage.debug = 'socket.io-client:*,engine.io-client:*'`
  - `location.reload()`
- `npm run test:speed-typing` — includes the deployment-invariant suite
