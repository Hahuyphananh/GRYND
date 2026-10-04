# GRYND Launch Checklist

Consolidated pre-launch checklist. Everything code-side that could be fixed
has been; the remaining items need **your hands** (env vars, deploy settings,
dashboard actions) or are **should-fix** polish.

## ✅ Done (code-side)

- **Domain** — all fallbacks point at `www.grynd.dedyn.io`; runtime uses
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

2. **Set env vars on the real hosts** (Vercel project + Render service).
   The full per-side matrix is in `docs/PROD_REALTIME_AND_NEON_TASKS.md`;
   value-free templates are `.env.example` and `realtime-server/.env.example`.
   The four that break things SILENTLY when missed:
   - Vercel: `NEXT_PUBLIC_BASE_URL=https://www.grynd.dedyn.io` (a retired
     host here — e.g. `grynd.mywire.org` — is now ignored by
     `src/lib/siteUrl.ts` rather than silently breaking every `og:image`, but
     set it correctly anyway; it is inlined at build time, so it needs a
     redeploy to change),
     `NEXT_PUBLIC_SOCKET_URL=https://casino-app-2wnk.onrender.com`,
     `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
     `REALTIME_INTERNAL_URL`, `REALTIME_INTERNAL_SECRET`.
   - Render (realtime server): `CLIENT_URL` must include
     `https://www.grynd.dedyn.io` **or realtime connections from the new
     domain will be CORS-rejected**; `CLERK_SECRET_KEY`;
     `REALTIME_INTERNAL_SECRET` (the SAME value as Vercel, or every realtime
     push is 401'd); and `NEXTJS_INTERNAL_URL= https://www.grynd.dedyn.io`,
     without which every Render→Vercel callback — including the Speed Typing
     disconnect forfeit — is sent to `localhost` and lost.
   - Verify with `curl -i https://<render-host>/health`: `clerkConfigured`
     must be `true` and `allowedOrigins` must contain the live Vercel origin.

3. **Run the socket load test** against the deployed realtime server with a
   real session token:
   ```bash
   SOCKET_URL=https://<render-host> SESSION_TOKEN=eyJ... CONCURRENCY=300 node realtime-server/loadtest.js
   ```
   Get the token from a signed-in browser: DevTools → Console →
   `localStorage.getItem("__session")`.

4. **Run the restore drill once** (see `docs/neon-backup-restore-runbook.md`)
   and schedule a `pg_dump` off-site backup if you want one.

5. **Point an uptime monitor** at `https://www.grynd.dedyn.io/api/health`
   (UptimeRobot/Pingdom/StatusCake) and the realtime `/health`.

6. **Verify the Vercel cron** (`/api/jobs/weekly-reset`, Mondays 00:00 UTC)
   actually fires — a silent cron failure kills the weekly leaderboard
   reset. Check Vercel Cron logs after the first run.

7. **Old domains cleanup** — the old `grynd.mywire.org` / `casino-app-sandy.vercel.app`
   hosts are fully replaced by `www.grynd.dedyn.io` (web) and
   `casino-app-2wnk.onrender.com` (realtime); delete stale doc references
   once confirmed live.

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
