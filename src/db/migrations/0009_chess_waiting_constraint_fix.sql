-- Fix multiplayer matchmaking constraints for human chess games.
-- 1) Remove the old unique constraint that blocks users by status globally
--    (e.g. prevents multiple in_progress games and causes insert/join issues).
ALTER TABLE "chess_games"
DROP CONSTRAINT IF EXISTS "one_waiting_game_per_user";

-- 2) Enforce only one HUMAN waiting game per host at a time.
--    AI games are excluded and in_progress/finished games are not constrained.
CREATE UNIQUE INDEX IF NOT EXISTS "chess_one_waiting_human_game_per_user_idx"
ON "chess_games" ("player_white_id")
WHERE "status" = 'waiting' AND "is_ai_game" = false;
