-- 0145: retention ended_at for chess_games + rps_pvp_games
--
-- The nightly retention sweep (GET /api/jobs/retention, "0 4 * * *") purges
-- terminal match rows WHERE status IN ('finished','cancelled',...) AND
-- ended_at < cutoff. chess_games and rps_pvp_games had NO ended_at column,
-- so those DELETEs threw every night and the catch logged + moved on —
-- chess (the biggest match table) was never purged and storage grew
-- unboundedly.
--
-- Fix: add ended_at, backfill existing terminal rows (finished/cancelled/
-- expired are terminal everywhere in these tables; created_at is a safe
-- approximation for retention), and index (status, ended_at) so the daily
-- delete is an index range scan instead of a full-table scan.

ALTER TABLE "chess_games" ADD COLUMN "ended_at" timestamp;
ALTER TABLE "rps_pvp_games" ADD COLUMN "ended_at" timestamp;

UPDATE "chess_games"
   SET "ended_at" = "created_at"
 WHERE "status" IN ('finished', 'cancelled', 'expired')
   AND "ended_at" IS NULL;

UPDATE "rps_pvp_games"
   SET "ended_at" = "created_at"
 WHERE "status" IN ('finished', 'cancelled')
   AND "ended_at" IS NULL;

CREATE INDEX IF NOT EXISTS "chess_games_status_ended_idx"
  ON "chess_games" ("status", "ended_at");
CREATE INDEX IF NOT EXISTS "rps_pvp_games_status_ended_idx"
  ON "rps_pvp_games" ("status", "ended_at");