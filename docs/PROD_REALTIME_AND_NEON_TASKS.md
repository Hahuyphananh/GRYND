# Production Realtime + Neon Optimization Task List

This file groups all high-priority production tasks into a single deployable plan.

## Realtime verification tasks

1. Set `NEXT_PUBLIC_SOCKET_URL` in Vercel to `https://casino-app-2wnk.onrender.com`.
2. Set `CLIENT_URL` in Render to your exact Vercel production URL (comma-separate preview URLs if needed).
3. Ensure `CLERK_SECRET_KEY` is set on Render realtime service.
4. Verify `GET /health` returns `allowedOrigins`, `clerkConfigured: true`, and `wsPath: /socket.io`.

## Sports 500 invalid connection string tasks

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
4. Add pagination and filtering defaults for heavy list endpoints (sports bets/history).
5. Reduce production console logging on frequently executed code paths.
6. Standardize singleton DB clients for serverless handlers.

## Validation commands

- `curl -i https://casino-app-2wnk.onrender.com/health`
- In browser console:
  - `localStorage.debug = 'socket.io-client:*,engine.io-client:*'`
  - `location.reload()`

