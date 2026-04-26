ALTER TABLE users
  ADD COLUMN IF NOT EXISTS selected_special_title TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS special_titles (
  id SERIAL PRIMARY KEY,
  key VARCHAR(120) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  rarity VARCHAR(40) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_special_titles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_key VARCHAR(120) NOT NULL,
  unlocked_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_special_titles_user_title_idx ON user_special_titles(user_id, title_key);

CREATE TABLE IF NOT EXISTS user_secret_stats (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_messages_count INTEGER NOT NULL DEFAULT 0,
  goonbet_mentions INTEGER NOT NULL DEFAULT 0,
  all_in_phrase_mentions INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  win_streak INTEGER NOT NULL DEFAULT 0,
  loss_streak INTEGER NOT NULL DEFAULT 0,
  all_in_count INTEGER NOT NULL DEFAULT 0,
  all_in_loss_streak INTEGER NOT NULL DEFAULT 0,
  jackpots_won INTEGER NOT NULL DEFAULT 0,
  last_known_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  day_start_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  day_key VARCHAR(10),
  login_days INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO special_titles (key, name, description, rarity)
VALUES
  ('huy', 'Huy', 'Type "huy" in chat.', 'Rare'),
  ('talkative_goon', 'Talkative Goon', 'Send your first chat message.', 'Common'),
  ('chat_addict', 'Chat Addict', 'Send 100 chat messages.', 'Uncommon'),
  ('keyboard_warrior', 'Keyboard Warrior', 'Send 500 chat messages.', 'Epic'),
  ('loyal_goon', 'Loyal Goon', 'Type "goonbet" 10 times in chat.', 'Rare'),
  ('all_in_prophet', 'All-In Prophet', 'Type "all in" 25 times in chat.', 'Epic'),
  ('hot_streak', 'Hot Streak', 'Win 3 games in a row.', 'Uncommon'),
  ('untouchable', 'Untouchable', 'Win 5 games in a row.', 'Rare'),
  ('streak_god', 'Streak God', 'Win 10 games in a row.', 'Legendary'),
  ('lucky_rat', 'Lucky Rat', 'Win a jackpot game.', 'Legendary'),
  ('money_printer', 'Money Printer', 'Double balance in one day.', 'Legendary'),
  ('risk_taker', 'Risk Taker', 'Go all in 10 times.', 'Rare'),
  ('broke_again', 'Broke Again', 'Lose all your balance.', 'Rare'),
  ('certified_degenerate', 'Certified Degenerate', 'Lose 5 all-ins in a row.', 'Legendary'),
  ('regular', 'Regular', 'Claim login reward for 30 days.', 'Uncommon'),
  ('resident_goon', 'Resident Goon', 'Claim login reward for 100 days.', 'Epic'),
  ('recruiter', 'Recruiter', 'Invite one friend.', 'Rare'),
  ('salt_lord', 'Salt Lord', 'Type "rigged" after losing.', 'Epic'),
  ('no_life', 'No Life', 'Play 1000 games.', 'Legendary'),
  ('collector', 'Collector', 'Unlock 10 secret titles.', 'Mythic'),
  ('goon_ascended', 'GOON ASCENDED', 'Unlock all secret titles.', 'Mythic')
ON CONFLICT (key) DO NOTHING;
