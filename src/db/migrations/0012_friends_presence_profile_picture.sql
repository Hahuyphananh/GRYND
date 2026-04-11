ALTER TABLE users
ADD COLUMN IF NOT EXISTS profile_picture TEXT;

CREATE TABLE IF NOT EXISTS friend_relations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT friend_relations_pair_unique UNIQUE (user_id, friend_id),
  CONSTRAINT friend_relations_no_self CHECK (user_id <> friend_id)
);

CREATE INDEX IF NOT EXISTS friend_relations_user_idx ON friend_relations(user_id);
CREATE INDEX IF NOT EXISTS friend_relations_friend_idx ON friend_relations(friend_id);

CREATE TABLE IF NOT EXISTS user_game_presence (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_key VARCHAR(80) NOT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT user_game_presence_user_game_unique UNIQUE (user_id, game_key)
);

CREATE INDEX IF NOT EXISTS user_game_presence_game_idx ON user_game_presence(game_key, last_seen_at DESC);

ALTER TABLE user_game_presence
ADD COLUMN IF NOT EXISTS game_id INTEGER;

CREATE TABLE IF NOT EXISTS spectator_presence (
  id SERIAL PRIMARY KEY,
  spectator_clerk_id VARCHAR(255) NOT NULL,
  target_clerk_id VARCHAR(255) NOT NULL,
  game_key VARCHAR(80) NOT NULL,
  game_id INTEGER NOT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT spectator_presence_unique UNIQUE (spectator_clerk_id, target_clerk_id, game_key, game_id)
);

CREATE INDEX IF NOT EXISTS spectator_presence_target_idx ON spectator_presence(target_clerk_id, game_key, game_id, last_seen_at DESC);
