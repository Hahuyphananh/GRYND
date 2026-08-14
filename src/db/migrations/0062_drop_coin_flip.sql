-- Migration 0062 — drop the Coin Flip game.
--
-- Coin Flip (solo + the luck-based best-of-3 PvP mode) has been removed
-- from the casino: the page, API routes and component are deleted. The
-- `coin_flip_games` table and its `coin_flip_status` enum are no longer
-- referenced anywhere in the codebase and are dropped here.
DROP TABLE IF EXISTS "coin_flip_games";
--> statement-breakpoint
DROP TYPE IF EXISTS "coin_flip_status";
