-- Lane Rush Duel simultaneous play.
-- Existing turn-state rows remain readable for backwards compatibility;
-- new matches transition from ready to active and no longer use turns.

ALTER TYPE "lane_rush_duel_status" ADD VALUE IF NOT EXISTS 'active';
