-- ── Blackjack PvP: add peek usage counters ───────────────────────────
-- The new "peek" action lets a player preview the top of the shoe
-- (`match.deck[0]`) without drawing it once per round. We track the
-- per-round use count on the match row (validated by the server-side
-- `recordAction`). The mirror column on `blackjack_pvp_rounds`
-- preserves the per-round peek count on the resolved snapshot so
-- post-match replays can show "they peeked before swapping" if we ever
-- surface that detail. The peeked card itself is NOT persisted —
-- peekedCard lives only in the action response payload and the
-- caller's local UI state, so the shoe's ordering stays hidden from
-- anyone but the peeking player (server-side scrubbing mirrors the
-- existing opponent-hiding pattern for swap/freeze/vote counters).
--
-- Both columns default to 0 so existing rows are valid without
-- backfill. Per-round reset lives in
-- `src/lib/blackjack-pvp/serverStore.js` (the `between_rounds`
-- resolution branch + `advanceFromBetweenRounds`).

ALTER TABLE "blackjack_pvp_matches"
  ADD COLUMN IF NOT EXISTS "player1_used_peek" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "player2_used_peek" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "blackjack_pvp_rounds"
  ADD COLUMN IF NOT EXISTS "player1_used_peek" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "player2_used_peek" integer NOT NULL DEFAULT 0;
