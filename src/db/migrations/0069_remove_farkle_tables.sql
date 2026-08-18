-- Migration 0069 — drop the Farkle game tables.
--
-- Farkle has been removed from the casino: the page, API routes, engine,
-- realtime handlers and sletchema definitions are deleted. The `farkle_rooms`,
-- `farkle_players` and `farkle_actions` tables (created in 0027) are no
-- longer referenced anywhere in the codebase and are dropped here.
DROP TABLE IF EXISTS farkle_actions;
--> statement-breakpoint
DROP TABLE IF EXISTS farkle_players;
--> statement-breakpoint
DROP TABLE IF EXISTS farkle_rooms;
