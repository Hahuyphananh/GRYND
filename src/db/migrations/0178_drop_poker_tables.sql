-- 0178: Drop the retired Poker game (poker_games, poker_player_positions).
--
-- Poker is removed from the platform: its routes, page, client, pot-settlement
-- math, lobby entry, translations, sitemap entry, rating/trophy registry entry
-- and docs are all gone. Removing the game from the trophy registry is what
-- keeps the competitive space honest — poker hands were client-authoritative
-- and a cash game has no match verdict, so it could never be settled by the
-- server-authoritative writers (see src/lib/trophyStore.js).
--
-- This migration finishes the removal at the storage layer: the two tables that
-- only ever held poker state are dropped, so no orphaned game history is left
-- behind and no future query can accidentally read a game the platform no
-- longer serves.
--
-- Both tables are dropped together — poker_player_positions is keyed by
-- game_id and has no meaning without poker_games. There is no other table that
-- references them.
--
-- Idempotent: IF EXISTS makes a re-run a no-op.

DROP TABLE IF EXISTS "poker_player_positions";
--> statement-breakpoint
DROP TABLE IF EXISTS "poker_games";
