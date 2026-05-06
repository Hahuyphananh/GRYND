ALTER TABLE users
  ADD COLUMN IF NOT EXISTS xp integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_won bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS biggest_win integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS best_multiplier double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS best_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pvp_wins integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_wagered bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_won bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_profit bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_wins integer NOT NULL DEFAULT 0;

ALTER TABLE users ALTER COLUMN level SET DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_users_level ON users(level DESC);
CREATE INDEX IF NOT EXISTS idx_users_weekly_wagered ON users(weekly_wagered DESC);
CREATE INDEX IF NOT EXISTS idx_users_biggest_win ON users(biggest_win DESC);
CREATE INDEX IF NOT EXISTS idx_users_best_streak ON users(best_streak DESC);

CREATE TABLE IF NOT EXISTS big_wins (
  id uuid PRIMARY KEY,
  user_id text,
  username text,
  game text,
  bet_amount integer,
  win_amount integer,
  multiplier double precision,
  created_at timestamp DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_big_wins_created_at ON big_wins(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_big_wins_multiplier ON big_wins(multiplier DESC);
