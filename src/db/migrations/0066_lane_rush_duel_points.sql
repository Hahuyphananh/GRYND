-- Migration 0066 — Lane Rush Duel points columns.
--
-- Adds p1_points / p2_points to lane_rush_duel_matches for the
-- points-based scoring rework (the final score in points per seat,
-- stamped at resolution). Migration 0065 already includes these
-- columns in its CREATE TABLE; this ALTER only exists for databases
-- where 0065 was applied before the points rework.

ALTER TABLE "lane_rush_duel_matches" ADD COLUMN "p1_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "lane_rush_duel_matches" ADD COLUMN "p2_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
