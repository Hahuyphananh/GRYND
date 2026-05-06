ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS current_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS best_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS xp integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_wagered bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_won bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_wins integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_losses integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_level_gain integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_best_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_biggest_win bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_win_rate numeric(5,2) NOT NULL DEFAULT 0;

INSERT INTO user_stats (
  user_id,
  total_wagered,
  total_won,
  biggest_win,
  current_streak,
  best_streak,
  level,
  xp,
  weekly_wagered,
  weekly_won,
  weekly_wins,
  weekly_biggest_win,
  weekly_best_streak
)
SELECT
  u.id,
  COALESCE(u.total_wagered, 0),
  COALESCE(u.total_won, 0),
  COALESCE(u.biggest_win, 0),
  COALESCE(u.current_streak, 0),
  COALESCE(u.best_streak, 0),
  COALESCE(u.level, 1),
  COALESCE(u.xp, 0),
  COALESCE(u.weekly_wagered, 0),
  COALESCE(u.weekly_won, 0),
  COALESCE(u.weekly_wins, 0),
  COALESCE(u.weekly_won, 0),
  COALESCE(u.best_streak, 0)
FROM users u
ON CONFLICT (user_id) DO UPDATE SET
  total_wagered = GREATEST(COALESCE(user_stats.total_wagered, 0), EXCLUDED.total_wagered),
  total_won = GREATEST(COALESCE(user_stats.total_won, 0), EXCLUDED.total_won),
  biggest_win = GREATEST(COALESCE(user_stats.biggest_win, 0), EXCLUDED.biggest_win),
  current_streak = GREATEST(COALESCE(user_stats.current_streak, 0), EXCLUDED.current_streak),
  best_streak = GREATEST(COALESCE(user_stats.best_streak, 0), EXCLUDED.best_streak),
  level = GREATEST(COALESCE(user_stats.level, 1), EXCLUDED.level),
  xp = GREATEST(COALESCE(user_stats.xp, 0), EXCLUDED.xp),
  weekly_wagered = GREATEST(COALESCE(user_stats.weekly_wagered, 0), EXCLUDED.weekly_wagered),
  weekly_won = GREATEST(COALESCE(user_stats.weekly_won, 0), EXCLUDED.weekly_won),
  weekly_wins = GREATEST(COALESCE(user_stats.weekly_wins, 0), EXCLUDED.weekly_wins),
  weekly_biggest_win = GREATEST(COALESCE(user_stats.weekly_biggest_win, 0), EXCLUDED.weekly_biggest_win),
  weekly_best_streak = GREATEST(COALESCE(user_stats.weekly_best_streak, 0), EXCLUDED.weekly_best_streak),
  updated_at = NOW();

CREATE INDEX IF NOT EXISTS idx_user_stats_total_won ON user_stats(total_won DESC, wins DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS idx_user_stats_level ON user_stats(level DESC, xp DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS idx_user_stats_total_wagered ON user_stats(total_wagered DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS idx_user_stats_biggest_win ON user_stats(biggest_win DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS idx_user_stats_best_streak ON user_stats(best_streak DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS idx_user_stats_weekly_level_gain ON user_stats(weekly_level_gain DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS idx_user_stats_weekly_wagered ON user_stats(weekly_wagered DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS idx_user_stats_weekly_biggest_win ON user_stats(weekly_biggest_win DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS idx_user_stats_weekly_best_streak ON user_stats(weekly_best_streak DESC, user_id ASC);
