-- 0107: Feature-flagged Quick Queue requests

CREATE TABLE IF NOT EXISTS quick_queue_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(255) NOT NULL,
  preferred_games jsonb NOT NULL,
  preferred_modes jsonb NOT NULL DEFAULT '[]'::jsonb,
  region varchar(80),
  player_count integer NOT NULL DEFAULT 2,
  max_wait_ms integer,
  status varchar(20) NOT NULL DEFAULT 'queued',
  queued_at timestamp NOT NULL DEFAULT NOW(),
  cancelled_at timestamp,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW(),
  CONSTRAINT quick_queue_player_count_valid CHECK (player_count > 0),
  CONSTRAINT quick_queue_max_wait_valid CHECK (max_wait_ms IS NULL OR max_wait_ms > 0)
);

CREATE INDEX IF NOT EXISTS quick_queue_requests_active_idx
  ON quick_queue_requests (status, queued_at);

CREATE INDEX IF NOT EXISTS quick_queue_requests_user_idx
  ON quick_queue_requests (user_id, status, created_at);
