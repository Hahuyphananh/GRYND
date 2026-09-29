-- 0189: Drop the retired Roulette, Plinko, Blackjack and Crash Arena games.
--
-- All four games are removed from the platform: their pages, API routes,
-- client stores, components, lobby entries, quick-queue adapters, rating /
-- trophy registry entries, translations, sitemap entries, assets and docs
-- are gone (see src/lib/gameTags.js, src/lib/rating.js and src/lib/quickQueue.ts
-- for the surviving catalogs).
--
-- This migration finishes the removal at the storage layer. Every table below
-- only ever held state for one of the removed games, so dropping them leaves
-- no orphaned history behind and no future query can read a game the platform
-- no longer serves:
--
--   Solo (legacy) history:  roulette_games, crash_games, blackjack_games, plinko_games
--   Crash Arena (Crash Poker): crash_arena_entries -> rounds -> players -> transactions -> tables
--   Roulette PvP:           roulette_pvp_rounds -> roulette_pvp_matches
--   Blackjack PvP:          blackjack_pvp_rounds -> blackjack_pvp_matches
--   Plinko Duel:            plinko_pvp_rounds -> plinko_pvp_matches
--
-- Child tables are dropped first (or rely on CASCADE) so the FK graph never
-- blocks the drop. The pg enums those tables owned are dropped afterwards.
--
-- Idempotent: IF EXISTS makes a re-run a no-op.

DROP TABLE IF EXISTS "crash_arena_entries";
--> statement-breakpoint
DROP TABLE IF EXISTS "crash_arena_rounds";
--> statement-breakpoint
DROP TABLE IF EXISTS "crash_arena_transactions";
--> statement-breakpoint
DROP TABLE IF EXISTS "crash_arena_players";
--> statement-breakpoint
DROP TABLE IF EXISTS "crash_arena_tables";
--> statement-breakpoint
DROP TABLE IF EXISTS "roulette_pvp_rounds";
--> statement-breakpoint
DROP TABLE IF EXISTS "roulette_pvp_matches";
--> statement-breakpoint
DROP TABLE IF EXISTS "blackjack_pvp_rounds";
--> statement-breakpoint
DROP TABLE IF EXISTS "blackjack_pvp_matches";
--> statement-breakpoint
DROP TABLE IF EXISTS "plinko_pvp_rounds";
--> statement-breakpoint
DROP TABLE IF EXISTS "plinko_pvp_matches";
--> statement-breakpoint
DROP TABLE IF EXISTS "roulette_games";
--> statement-breakpoint
DROP TABLE IF EXISTS "crash_games";
--> statement-breakpoint
DROP TABLE IF EXISTS "blackjack_games";
--> statement-breakpoint
DROP TABLE IF EXISTS "plinko_games";
--> statement-breakpoint
DROP TYPE IF EXISTS "crash_arena_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "crash_arena_transaction_type";
--> statement-breakpoint
DROP TYPE IF EXISTS "roulette_pvp_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "blackjack_pvp_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "blackjack_pvp_player_state";
--> statement-breakpoint
DROP TYPE IF EXISTS "plinko_pvp_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "plinko_pvp_ball_outcome";
