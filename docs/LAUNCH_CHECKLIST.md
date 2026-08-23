# GRYND Launch Checklist

Consolidated pre-launch checklist. Everything code-side that could be fixed
has been; the remaining items need **your hands** (env vars, deploy settings,
dashboard actions) or are **should-fix** polish.

## ✅ Done (code-side)

- **Domain** — all fallbacks point at `grynd.mywire.org`; runtime uses
  `NEXT_PUBLIC_BASE_URL` (single source of truth in `.env.local` / Vercel)
- **Health check** — `/api/health` (Postgres + Redis) + realtime server
  `/health`
- **Maintenance mode / kill switch** — admin-dashboard toggle, DB-backed
  flag, middleware gate, `/maintenance` page
- **Account erasure** — Clerk deletion, `user.deleted` webhook, full PvP
  history purge, moderation-record handling
- **Privacy** — iOS `PrivacyInfo.xcprivacy`, App Store + Play Data Safety
  answer docs, Sentry consent-gated
- **DOB/age** — birthdate persisted to Clerk metadata; age gate enforced in
  middleware
- **Load-test tooling** — `realtime-server/loadtest.js` ready to run
- **Backup runbook** — `docs/neon-backup-restore-runbook.md`

## 🔴 Needs your hands before launch

1. **Apply the schema migration** (the kill switch won't work until then):
   ```bash
   npm run db:migrate
   ```
   Run against the production `DATABASE_URL`. If you deploy via Vercel,
   add a build step or run it manually — there is **no auto-migration** in
   the deploy pipeline today.

2. **Set env vars on the real hosts** (Vercel project + Render service):
   - Vercel: `NEXT_PUBLIC_BASE_URL=https://grynd.mywire.org`,
     `NEXT_PUBLIC_SOCKET_URL=<render-host>` (check current value),
     `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, etc.
   - Render (realtime server): `CLIENT_URL` must include
     `https://grynd.mywire.org` **or realtime connections from the new
     domain will be CORS-rejected**, and `CLERK_SECRET_KEY`.

3. **Run the socket load test** against the deployed realtime server with a
   real session token:
   ```bash
   SOCKET_URL=https://<render-host> SESSION_TOKEN=eyJ... CONCURRENCY=300 node realtime-server/loadtest.js
   ```
   Get the token from a signed-in browser: DevTools → Console →
   `localStorage.getItem("__session")`.

4. **Run the restore drill once** (see `docs/neon-backup-restore-runbook.md`)
   and schedule a `pg_dump` off-site backup if you want one.

5. **Point an uptime monitor** at `https://grynd.mywire.org/api/health`
   (UptimeRobot/Pingdom/StatusCake) and the realtime `/health`.

6. **Verify the Vercel cron** (`/api/jobs/weekly-reset`, Mondays 00:00 UTC)
   actually fires — a silent cron failure kills the weekly leaderboard
   reset. Check Vercel Cron logs after the first run.

7. **Old domains cleanup** — `docs/PROD_REALTIME_AND_NEON_TASKS.md` still
   references `casino-app-2wnk.onrender.com`; update or delete stale doc
   references after confirming the live socket host.

## 🟠 Should-fix before launch

| # | Item | Why |
|---|---|---|
| 1 | **Marketing analytics funnel** | PostHog has game events but no acquisition-source tracking or signup→first-game conversion funnel. Add before spending on ads |
| 2 | **Contact inbox monitoring** | The contact page is the only support channel named in your legal pages — confirm someone reads it |
| 3 | **Manual age-gate test** | The middleware `<18` redirect exists; manually verify the under-18 path end to end (sign up with a DOB < 18) |
| 4 | **Native-app build verification** | The Capacitor app now points at the live domain; a signed APK/IPA build has never been produced. Also: remote-URL apps break if you change domains — consider a bundled `webDir` build for durability |
| 5 | **CHANGELOG / release discipline** | Start a CHANGELOG.md at launch |

## 🟡 Watch after launch

- **Monitoring**: Sentry alerts for new errors; `/api/health` pager-style
  alerting
- **Performance**: watch Neon compute + Redis usage as player count grows
- **Weekly cron**: verify leaderboard reset each Monday for the first month
