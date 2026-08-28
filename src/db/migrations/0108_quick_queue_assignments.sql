-- 0108: Quick Queue candidate assignments (no game launch yet)

CREATE TABLE IF NOT EXISTS quick_queue_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_ids jsonb NOT NULL,
  game_key varchar(80) NOT NULL,
  mode varchar(80) NOT NULL,
  player_count integer NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ready',
  assigned_at timestamp NOT NULL DEFAULT NOW(),
  launched_at timestamp,
  created_at timestamp NOT NULL DEFAULT NOW(),
  CONSTRAINT quick_queue_assignments_player_count_valid CHECK (player_count > 0)
);

CREATE INDEX IF NOT EXISTS quick_queue_assignments_status_idx
  ON quick_queue_assignments (status, assigned_at);
