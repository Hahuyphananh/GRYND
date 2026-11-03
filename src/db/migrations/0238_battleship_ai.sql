-- 0238_battleship_ai.sql
--
-- BATTLESHIP — free practice versus the built-in bot.
--
-- ── TWO COLUMNS, NO NEW TABLE ────────────────────────────────────────────
--
-- A practice match is the SAME match row, with the bot in seat 2:
--
--   is_ai         marks the row as practice. Nothing on the ranked path reads
--                 it, and — the important direction — the matchmaker only ever
--                 seats a second HUMAN into a row whose player2 is NULL, which
--                 an AI row never is. So a practice match cannot be joined, and
--                 it cannot appear in the lobby list.
--   ai_difficulty the canonical `easy | normal | hard` tier (src/lib/aiDifficulty),
--                 read by the bot when it chooses its attack. NULL on PvP rows.
--
-- The bot's fleet lives in `battleship_fleets` seat `player2` like any other
-- fleet, which means the Phase 4 privacy rule already applies: the store reads
-- it only inside the server, and the per-seat projection has no opponent-fleet
-- field. The bot's pre-committed attack is an ordinary `battleship_attacks` row
-- with `result NULL`, so the human never sees the coordinate before the round
-- resolves.
--
-- PRACTICE IS UNRATED BY CONSTRUCTION: Battleship has no settlement path at all
-- (no rating, trophy or payout call in this module), so an `is_ai` row cannot
-- change Elo, award a trophy or count as a ranked victory even by mistake.

ALTER TABLE "battleship_matches"
  ADD COLUMN IF NOT EXISTS "is_ai" boolean DEFAULT false NOT NULL;
ALTER TABLE "battleship_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(8);

COMMENT ON COLUMN "battleship_matches"."is_ai" IS
  'Free practice vs the built-in bot; always unrated and never matchmade';
COMMENT ON COLUMN "battleship_matches"."ai_difficulty" IS
  'Canonical easy | normal | hard tier; NULL on PvP rows';
