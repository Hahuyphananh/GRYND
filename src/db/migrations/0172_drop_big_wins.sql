-- 0172: Drop the obsolete `big_wins` table.
--
-- Big Wins Chat has been removed from GRYND entirely: the chat UI tab, the
-- realtime `big_wins` subscription, the `/api/chat/big-wins` producer route,
-- the `/api/jobs/big-wins-cleanup` cron, the big-win email, and every
-- `recordBigWinIfNeeded` call in game settlement are gone. The table was only
-- ever written by that producer and read by the chat / cleanup job, so it has
-- no other consumer and is now dead weight.
--
-- This is intentionally a forward migration rather than an edited history:
-- existing environments still hold the table and its rows, and the schema
-- (src/db/schema.ts) no longer declares it.
--
-- Idempotent: `IF EXISTS` makes it safe to run repeatedly and on databases
-- that never created the table.
--
-- NOTE: this removes ONLY the Big Wins record table. The token economy,
-- Battle Pass, XP, Prestige and cosmetics are unrelated and are untouched.

DROP TABLE IF EXISTS "big_wins";
