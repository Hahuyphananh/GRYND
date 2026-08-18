-- Migration 0070 — drop the sports betting tables.
--
-- Sports betting has been removed from the platform: the /sport pages, API
-- routes (sports/*, place-sports-bet, get-events, odds/fetch, legacy
-- place-bet + bets/settle), components, ODDS_API_KEY integration and schema
-- definitions are deleted. The `events`, `sports` and `sports_bets` tables
-- (created in 0000, columns extended in 0025) are no longer referenced
-- anywhere in the codebase and are dropped here.
DROP TABLE IF EXISTS "sports_bets";
--> statement-breakpoint
DROP TABLE IF EXISTS "events";
--> statement-breakpoint
DROP TABLE IF EXISTS "sports";
