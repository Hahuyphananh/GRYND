-- ── Mines PvP — self-contained replay state ─────────────────────────
-- The simultaneous model persists ONE rounds row per match. Migration 0201
-- already snapshotted both seats' boards (with their mine values) and the
-- final scores; this adds each seat's complete final state so a replay can
-- render everything without re-walking the live match row:
--   * revealed tiles, active flags and confirmed (correct) flags
--   * safe reveals, mines hit, correct/incorrect flag counts
--   * completion flag + completion timestamp
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS), so it can be re-run
-- and pasted into the Supabase SQL editor. No existing column is dropped
-- and no existing data is touched; legacy rows simply default to '{}'.
--
-- These columns carry NO live-match authority: the finished-match replay
-- reads them after settlement. Active-match status endpoints continue to
-- hide unrevealed mines (see src/lib/mines-pvp/matchView.js).

ALTER TABLE "mines_pvp_rounds"
  ADD COLUMN IF NOT EXISTS "p1_final_state" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

ALTER TABLE "mines_pvp_rounds"
  ADD COLUMN IF NOT EXISTS "p2_final_state" jsonb NOT NULL DEFAULT '{}'::jsonb;
