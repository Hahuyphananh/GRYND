-- Migration 0068 — roulette PvP skill layer: elimination market + opponent call.
--
-- Adds the columns backing three new mechanics:
--   1. Server elimination rounds — each round past round 1, a revealed set
--      of numbers is dead before betting opens (round 2: 13–24, round 3:
--      13–36). The spin is drawn from the LIVE pool only.
--   2. Elimination market — players pay 10 match points to remove one
--      number from the shared wheel for the current round (visible to both
--      players immediately). Removed numbers can never be spun or bet on.
--   3. "Call their bet" — when locking bets, each player may guess the
--      opponent's biggest wager; a correct guess steals 15 points.
--
-- All new columns are nullable jsonb so existing rows and any in-flight
-- match keep working untouched (treated as "no eliminations / no calls").

ALTER TABLE "roulette_pvp_matches"
  ADD COLUMN "server_eliminated" jsonb,
  ADD COLUMN "eliminations" jsonb,
  ADD COLUMN "calls" jsonb;

ALTER TABLE "roulette_pvp_rounds"
  ADD COLUMN "server_eliminated" jsonb,
  ADD COLUMN "eliminations" jsonb,
  ADD COLUMN "calls" jsonb,
  ADD COLUMN "call_results" jsonb;
