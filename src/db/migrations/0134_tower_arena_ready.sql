-- Tower Arena: per-player `ready` flag for the pre-game ready gate.
-- Every player must click READY (AI seats are always ready) before the
-- 10-second start countdown begins and the match transitions to active.
BEGIN;

ALTER TABLE "tower_arena_players"
  ADD COLUMN IF NOT EXISTS "ready" boolean NOT NULL DEFAULT false;

COMMIT;
