-- 0104: Canonical platform-wide match lifecycle
-- Independent table allows game-specific flows to migrate incrementally.

CREATE TABLE IF NOT EXISTS match_lifecycle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id varchar(255) NOT NULL UNIQUE,
  game_key varchar(80) NOT NULL,
  mode varchar(80) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'queued',
  queued_at timestamp NOT NULL DEFAULT NOW(),
  started_at timestamp,
  ended_at timestamp,
  cancel_reason varchar(40),
  player_count integer NOT NULL DEFAULT 0,
  queue_wait_ms integer,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW(),
  CONSTRAINT match_lifecycle_player_count_nonnegative CHECK (player_count >= 0),
  CONSTRAINT match_lifecycle_queue_wait_nonnegative CHECK (queue_wait_ms IS NULL OR queue_wait_ms >= 0),
  CONSTRAINT match_lifecycle_time_order CHECK (
    (started_at IS NULL OR started_at >= queued_at) AND
    (ended_at IS NULL OR ended_at >= queued_at) AND
    (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
  )
);

CREATE INDEX IF NOT EXISTS match_lifecycle_status_queue_idx
  ON match_lifecycle (status, queued_at);

CREATE INDEX IF NOT EXISTS match_lifecycle_game_mode_idx
  ON match_lifecycle (game_key, mode, status);
