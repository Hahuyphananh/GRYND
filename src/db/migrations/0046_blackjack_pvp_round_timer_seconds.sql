-- ── Blackjack PvP: add round_timer_seconds column ────────────────────
-- The Prompt 9 schema refactor declared `round_timer_seconds` on
-- `blackjack_pvp_matches` (Drizzle: `blackjackPvpMatches
-- .roundTimerSeconds` → DB column `round_timer_seconds`). The
-- column is the per-row pacing knob the server's `roundDeadlineMs`
-- helper reads from when computing the round `round_deadline`
-- timestamp; it falls back to a server-side default if missing.
--
-- Migrations 0042-0045 cover every other Prompt 9 rename + add, but
-- `round_timer_seconds` was never added. The INSERT in
-- `createWaitingMatch` (`src/lib/blackjack-pvp/serverStore.js`)
-- writes through this column on every Play-button click, so without
-- it `POST /api/blackjack-pvp/create-or-join` triggers a 500 with
-- SQLSTATE 42703 `column "round_timer_seconds" of relation
-- "blackjack_pvp_matches" does not exist`. This migration adds the
-- column with a safe NOT-NULL default so existing rows are valid
-- without any backfill.
--
-- Default value `20` matches `ROUND_TIMER_SECONDS` (per-round
-- decision window in seconds, defined in
-- `src/lib/blackjack-pvp/constants.js`) and the original column
-- default declared in the Drizzle schema
-- (`src/db/schema.ts` → `blackjackPvpMatches.roundTimerSeconds`).

ALTER TABLE "blackjack_pvp_matches"
  ADD COLUMN IF NOT EXISTS "round_timer_seconds" integer NOT NULL DEFAULT 20;
