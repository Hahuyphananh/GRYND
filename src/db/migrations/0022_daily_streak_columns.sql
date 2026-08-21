-- Migration: Add daily streak tracking columns
-- Run this on Neon's SQL editor (https://console.neon.tech)

-- Add columns to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS daily_streak_current INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_streak_best INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_streak_current INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_streak_best INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS week_key VARCHAR(8),
  ADD COLUMN IF NOT EXISTS last_login_date DATE;

-- Add columns to user_stats table
ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS daily_streak_current INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_streak_best INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_streak_current INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_streak_best INTEGER NOT NULL DEFAULT 0;

-- Add selected_streak_type column to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS selected_streak_type VARCHAR(10) DEFAULT NULL;

-- Create streak_titles table
CREATE TABLE IF NOT EXISTS streak_titles (
  id SERIAL PRIMARY KEY,
  days INTEGER NOT NULL UNIQUE,
  title VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Seed streak titles
INSERT INTO streak_titles (days, title) VALUES
  (1, 'Daily Visitor'),
  (3, 'Loyal Player'),
  (5, 'Token Collector'),
  (7, 'Weekly Winner'),
  (10, 'Streak Starter'),
  (14, 'Lucky Regular'),
  (21, 'Dedicated Roller'),
  (30, 'Monthly Champion'),
  (45, 'Prize Chaser'),
  (60, 'Veteran'),
  (75, 'Lucky Legend'),
  (100, 'Streak Master'),
  (150, 'Vault Elite'),
  (200, 'Milestone Grinder'),
  (365, 'King')
ON CONFLICT (days) DO NOTHING;

-- Create index for leaderboard queries on user_stats
CREATE INDEX IF NOT EXISTS idx_user_stats_daily_streak_current
  ON user_stats (daily_streak_current DESC);

CREATE INDEX IF NOT EXISTS idx_user_stats_daily_streak_best
  ON user_stats (daily_streak_best DESC);

CREATE INDEX IF NOT EXISTS idx_user_stats_weekly_streak_current
  ON user_stats (weekly_streak_current DESC);

CREATE INDEX IF NOT EXISTS idx_user_stats_weekly_streak_best
  ON user_stats (weekly_streak_best DESC);
