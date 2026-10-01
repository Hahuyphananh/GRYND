-- Migration 0195 — free "play vs AI" support for Tic-Tac-Toe and Solitaire Duel.
--
-- Both games gain a server-authoritative practice bot. The columns mirror the
-- ones Mini Golf / Speed Typing / Dots-and-Boxes already carry:
--
--   is_ai          marks a practice match so settlement skips ratings, trophies
--                  and win counters entirely (a bot must never move a real
--                  player's Elo).
--   ai_difficulty  the tier picked in the lobby ('easy' | 'normal' | 'hard');
--                  NULL falls back to the documented default at read time.
--
-- Speed Typing already has both columns (migration 0190/0191). Tic-Tac-Toe and
-- Solitaire Duel did not ship a bot, so they are added here. Additive and
-- idempotent, exactly like every other column-adding migration.

ALTER TABLE "tic_tac_toe_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "solitaire_duel_matches"
  ADD COLUMN IF NOT EXISTS "is_ai" boolean NOT NULL DEFAULT false;

ALTER TABLE "solitaire_duel_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);
