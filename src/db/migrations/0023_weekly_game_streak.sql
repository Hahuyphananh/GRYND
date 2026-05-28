-- Add weekly_game_streak column to track game win streaks within the current week
-- This is separate from weekly_streak_current which tracks daily login streaks
ALTER TABLE user_stats
ADD COLUMN IF NOT EXISTS weekly_game_streak integer NOT NULL DEFAULT 0;

-- Reset any existing weekly stats to start fresh
UPDATE user_stats
SET weekly_game_streak = 0,
    weekly_level_gain = 0,
    weekly_best_streak = 0,
    updated_at = NOW();
