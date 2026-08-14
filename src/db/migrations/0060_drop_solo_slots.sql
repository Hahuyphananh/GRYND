-- Migration 0060 — drop the dead solo-slots tables.
--
-- Slots is now exclusively the 1v1 PvP game (slots_pvp_matches /
-- slots_pvp_rounds from migration 0059); the solo slot machine was
-- already removed from the UI and API. Of the two leftover solo
-- tables:
--   * `slot_jackpots` was never read or written by any route — dead.
--   * `slot_games` only fed legacy leaderboard / "games today" counters
--     in get-user-stats + stats/live, which now source from the `users`
--     rows the PvP settlement bumps (mirroring the other PvP games).
-- Both are dropped; the PvP tables are untouched.
DROP TABLE IF EXISTS "slot_jackpots";
--> statement-breakpoint
DROP TABLE IF EXISTS "slot_games";
