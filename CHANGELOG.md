# Changelog

All notable changes to GRYND. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — Pre-launch hardening

### Added
- **Runtime maintenance mode / kill switch** — admin-dashboard toggle backed by a new `app_settings` table; middleware redirects visitors to a `/maintenance` page while admins can still reach the dashboard to bring the site back. Requires `npm run db:migrate` (migration `0080`).
- **Health endpoint** — `GET /api/health` checks Postgres (required) and Redis (optional) for uptime monitors.
- **Marketing funnel** — `sign_up_completed` event at the account-sync handoff, UTM/acquisition params persisted as person properties, and `first_game_started` recorded via a global PostHog `eventCaptured` hook (no per-game code changes).
- **Contact inbox notifications** — the contact form now emails the admin inbox on new submissions (best-effort; the message is still stored in the DB).
- **Load-test tooling** — `realtime-server/loadtest.js` floods the socket server with concurrent authenticated connections and reports success/latency/failure metrics.
- **Docs** — launch checklist, Neon backup/restore runbook, native build guide, App Store / Play privacy answers, privacy manifest.

### Changed
- **Domain** — all fallbacks and runtime env moved to `grynd.mywire.org` via `NEXT_PUBLIC_BASE_URL` (single source of truth): sitemap, OG images, email templates, robots.txt, llms.txt, Capacitor configs.
- **Native app identity** — `com.example.app` / "create-project" replaced with `com.grynd.app` / "GRYND" across Capacitor config, Android manifest/gradle/strings/package, and iOS bundle id / display name.
- **Sentry consent-gated** — client capture (including session replay and PII) is blocked until the cookie-consent banner is accepted; server PII capture disabled by default.
- **Age verification** — the signup birthdate is now persisted to Clerk public metadata (previously discarded), matching the privacy policy and unblocking `useAgeVerification`.
- **README** — broken preview image replaced with the real banner asset.

### Security / privacy
- Account deletion is a true erasure: Clerk account removed server-side, `user.deleted` webhook cleanup, PvP match-history purge, moderation-record handling (reports filed by a user are deleted; reports against them are anonymized; audit logs retained).
- iOS `PrivacyInfo.xcprivacy` added; App Store + Play Data Safety answers documented.

## [0.1.0] — Initial platform build

- Skill-game platform (token-based, no real money) with solo + PvP game suite, leaderboards, titles, referral system, admin dashboard, and realtime multiplayer.
