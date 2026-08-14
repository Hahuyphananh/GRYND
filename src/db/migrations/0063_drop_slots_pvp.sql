-- Migration 0063 — drop the entire Slots game.
--
-- Slots (the 1v1 "Fruit Fortune" PvP game) has been removed from the
-- casino: the lobby, match view, API routes, engine and theme assets
-- are all deleted. `slots_pvp_matches` / `slots_pvp_rounds` (migration
-- 0059) and the `slots_pvp_status` enum are dropped here. The dead
-- solo tables (`slot_games`, `slot_jackpots`) were already dropped in
-- migration 0060.
DROP TABLE IF EXISTS "slots_pvp_rounds";
--> statement-breakpoint
DROP TABLE IF EXISTS "slots_pvp_matches";
--> statement-breakpoint
DROP TYPE IF EXISTS "slots_pvp_status";
