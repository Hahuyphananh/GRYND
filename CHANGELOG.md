# Changelog

All notable changes to GRYND. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — Pre-launch hardening

### Added
- **Active players per game (backend)** — a per-game active-player presence foundation for a future "N playing" lobby badge: the dormant `user_game_presence` table is adopted and extended (migration `0159`), heartbeats land through `POST /api/presence/active-game` (idempotent upsert on `(user_id, game_key)`, 60s cadence, 3-minute activity window, so closed tabs age out on their own), and `GET /api/casino/active-players` returns Redis-cached aggregate counts only. No user data is ever returned. The games now report into it (next bullet); only the lobby badge itself is still to come.
- **Active players per game (game wiring)** — every casino game reports presence from the lifecycle signal it already had, through one shared hook (`useActiveGamePresence`): `<CreatorModeHost>` beats while `autoStart && !autoStop` and clears the moment `autoStop` fires (21 mounts), and the four pages that mount no host (Crash Arena tables, Pool Masters, Hex Duel, Odds) call the same hook next to their existing "a real session started" edge. Players still in a matchmaking takeover are not counted, spectators on a shared live match never are (`presenceEnabled`), a finished match clears immediately, and two tabs of one game still count once. Presence is best-effort — every request failure is swallowed, so a presence outage cannot touch gameplay, wagering, XP or matchmaking. Verify with `npm run test:presence` and `npm run verify:game-presence`.
- **Active players per game (lobby UI)** — every casino game card now shows how many players are inside that game right now (`● 12 playing`, `🔥 127 playing` for a busy game, `No players right now` when nobody is in it) in the footer of the existing `GameCard`, so the All Games grid and the For You strip share one card and one badge. One 20s poll of `GET /api/casino/active-players` covers the whole lobby, pauses while the tab is hidden, and cleans up on unmount; counts are mapped with the card's own game id and are never hardcoded. A failed read hides the badge rather than showing a misleading zero, and filters, sorting, search, links and recommendations are unaffected. The label is real text (never colour alone), lives outside the card's link so screen readers read it, and is localized in en / fr / es. Verify with `npm run verify:lobby-for-you` (six viewports, plus a control page with the badge removed).
- **Onboarding personalization** — a five-question game-preference questionnaire for new accounts (before the existing welcome tutorial) with a one-time, dismissible invitation for existing players, a deterministic recommendation engine (`src/lib/gameRecommendations.js` + a game/tag catalog in `src/lib/gameTags.js`), a personalized **FOR YOU** strip above All Games in the casino lobby, and a **Your GRYND Preferences** card in Settings that reads and re-opens the same questionnaire in edit mode. The welcome tutorial gained one warm follow-up line derived from the answers. Requires `npm run db:migrate` (migrations `0157`, `0158`).
- **Runtime maintenance mode / kill switch** — admin-dashboard toggle backed by a new `app_settings` table; middleware redirects visitors to a `/maintenance` page while admins can still reach the dashboard to bring the site back. Requires `npm run db:migrate` (migration `0080`).
- **Health endpoint** — `GET /api/health` checks Postgres (required) and Redis (optional) for uptime monitors.
- **Marketing funnel** — `sign_up_completed` event at the account-sync handoff, UTM/acquisition params persisted as person properties, and `first_game_started` recorded via a global PostHog `eventCaptured` hook (no per-game code changes).
- **Contact inbox notifications** — the contact form now emails the admin inbox on new submissions (best-effort; the message is still stored in the DB).
- **Load-test tooling** — `realtime-server/loadtest.js` floods the socket server with concurrent authenticated connections and reports success/latency/failure metrics.
- **Docs** — launch checklist, Neon backup/restore runbook, native build guide, App Store / Play privacy answers, privacy manifest.

### Changed
- **Domain** — all fallbacks and runtime env moved to `grynd.dedyn.io` via `NEXT_PUBLIC_BASE_URL` (single source of truth): sitemap, OG images, email templates, robots.txt, llms.txt, Capacitor configs.
- **Native app identity** — `com.example.app` / "create-project" replaced with `com.grynd.app` / "GRYND" across Capacitor config, Android manifest/gradle/strings/package, and iOS bundle id / display name.
- **Sentry consent-gated** — client capture (including session replay and PII) is blocked until the cookie-consent banner is accepted; server PII capture disabled by default.
- **Age verification** — the signup birthdate is now persisted to Clerk public metadata (previously discarded), matching the privacy policy and unblocking `useAgeVerification`.
- **README** — broken preview image replaced with the real banner asset.

### Fixed
- **Active players per game (QA pass)** — a Tower Arena player eliminated mid-match stays on the live page watching the survivors, and was being counted as "playing" for as long as they stayed; presence now opts out at elimination (Creator Mode still records the whole match), which brings it in line with the spectator rule on chess, four-in-a-row, poker, dots-and-boxes and hex-duel. The unmount clear is now gated on "this mount actually beat" rather than on the current opt-in flag, so a player who stops counting this way still clears their row the moment they leave. And the daily retention sweep no longer reimplements the presence DELETE as raw SQL — it calls the store's `pruneStalePresence()`, leaving one implementation in the module that owns the table.

### Security / privacy
- Account deletion is a true erasure: Clerk account removed server-side, `user.deleted` webhook cleanup, PvP match-history purge, moderation-record handling (reports filed by a user are deleted; reports against them are anonymized; audit logs retained).
- iOS `PrivacyInfo.xcprivacy` added; App Store + Play Data Safety answers documented.

## [0.1.0] — Initial platform build

- Skill-game platform (token-based, no real money) with solo + PvP game suite, leaderboards, titles, referral system, admin dashboard, and realtime multiplayer.
