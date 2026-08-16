-- Migration 0067 — drop the dead GoonBet Clicker table.
--
-- Clicker has been removed from the casino: the page, API routes
-- (cashout/start/sync), component, lib and image are deleted. The
-- `clicker_games` table (from migration 0025) is no longer referenced
-- anywhere in the codebase — get-bet-history and user-stats now source
-- from the `users` rows the other games bump. It is dropped here.
DROP TABLE IF EXISTS "clicker_games";
