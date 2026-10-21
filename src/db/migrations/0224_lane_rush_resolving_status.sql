-- 0224_lane_rush_resolving_status.sql
--
-- LANE RUSH — explicit "race resolving" lifecycle state.
--
-- The reworked game resolves a round in two committed steps:
--   1. when both plans are locked (or the 60s deadline expires) the row is
--      marked `resolving`;
--   2. a second transaction applies the server-generated race result and moves
--      the row back to `active` (next planning phase) or `finished`.
--
-- Persisting the marker makes resolution resumable: if the process dies
-- between the two transactions, the next status read sees `resolving` and
-- finishes the job. The result is applied exactly once because the marker is
-- consumed inside the same row-locked transaction that writes the scores.
--
-- Additive and idempotent. `ALTER TYPE ... ADD VALUE` is the same pattern the
-- repository already uses (see 0087_lane_rush_simultaneous.sql).

ALTER TYPE "lane_rush_duel_status" ADD VALUE IF NOT EXISTS 'resolving';
