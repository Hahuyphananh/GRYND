-- ── Plinko Duel PvP: explicit ready flags + ball-collision support ──
-- Per user request, both players must now click "Ready" before their
-- ball launches. The existing p{1,2}_current_inputs jsonb columns
-- still cache the inputs, but explicit p1_ready / p2_ready boolean
-- columns let the client surface per-seat "Ready ✓ / Waiting…"
-- indicators and let the server resolve the ball ONLY when both
-- flags are true (or the AFK timer fires).
--
-- Both columns default to FALSE so existing rows are valid without
-- backfill. Per-ball reset to FALSE lives in resolveBall() (server)
-- and the "ball_n incoming" UI reset (client).
--
-- Note: a previous version of this migration also tried to add a
-- partial index `plinko_pvp_ready_idx` on `plinko_pvp_matches ("match_id")`,
-- but `plinko_pvp_matches` has no `match_id` column — its primary key
-- is `id` (the `match_id` column lives on `plinko_pvp_rounds`, the
-- child table). PostgreSQL rejected the migration on Neon with
-- `ERROR: column "match_id" does not exist`. The partial index was
-- cosmetic (the existing `plinko_pvp_status_idx` /
-- `plinko_pvp_player{1,2}_idx` cover every actual lookup pattern in
-- `lib/plinko-pvp/serverStore.js`), so it's been dropped entirely.

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_ready" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "p2_ready" boolean NOT NULL DEFAULT false;
