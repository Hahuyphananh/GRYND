BEGIN;
DROP TABLE IF EXISTS tank_stats CASCADE;
DROP TABLE IF EXISTS tank_matches CASCADE;

CREATE TABLE IF NOT EXISTS dice_lobbies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id varchar(255) NOT NULL,
  opponent_user_id varchar(255),
  wager int NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'waiting',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dice_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_id uuid REFERENCES dice_lobbies(id) ON DELETE CASCADE,
  player1_id varchar(255) NOT NULL,
  player2_id varchar(255) NOT NULL,
  winner_id varchar(255),
  wager int NOT NULL,
  prize_paid int NOT NULL DEFAULT 0,
  house_fee int NOT NULL DEFAULT 0,
  hp1 int NOT NULL DEFAULT 20,
  hp2 int NOT NULL DEFAULT 20,
  turn_user_id varchar(255) NOT NULL,
  round int NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE TABLE IF NOT EXISTS dice_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES dice_matches(id) ON DELETE CASCADE,
  user_id varchar(255) NOT NULL,
  round int NOT NULL,
  action_type varchar(30) NOT NULL,
  roll_1 int,
  roll_2 int,
  damage_dealt int NOT NULL DEFAULT 0,
  self_damage int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dice_player_stats (
  user_id varchar(255) PRIMARY KEY,
  wins int NOT NULL DEFAULT 0,
  losses int NOT NULL DEFAULT 0,
  games_played int NOT NULL DEFAULT 0,
  total_wagered bigint NOT NULL DEFAULT 0,
  total_won bigint NOT NULL DEFAULT 0,
  highest_win int NOT NULL DEFAULT 0,
  current_streak int NOT NULL DEFAULT 0,
  best_streak int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS dice_lobbies_status_idx ON dice_lobbies(status, created_at DESC);
CREATE INDEX IF NOT EXISTS dice_matches_status_idx ON dice_matches(status, created_at DESC);
CREATE INDEX IF NOT EXISTS dice_turns_match_round_idx ON dice_turns(match_id, round DESC);
COMMIT;
