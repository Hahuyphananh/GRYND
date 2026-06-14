-- Migration: Ensure weekly_streak_current column exists on user_stats
-- and that it gets reset along with other weekly counters.
-- This column was added in 0022 but the weekly-reset job (cron) was
-- not resetting it — fixed in the route handler.

-- Safety: ensure the column exists (ADD COLUMN IF NOT EXISTS)
ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS weekly_streak_current INTEGER NOT NULL DEFAULT 0;

-- Reset any stale weekly streak values so the leaderboard starts clean
UPDATE user_stats
SET weekly_streak_current = 0,
    updated_at = NOW();
