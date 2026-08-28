-- 0105: Durable canonical match lifecycle event outbox

CREATE TABLE IF NOT EXISTS match_lifecycle_events (
  event_id uuid PRIMARY KEY,
  match_id varchar(255) NOT NULL,
  event_type varchar(40) NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamp NOT NULL DEFAULT NOW(),
  published_at timestamp,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT NOW(),
  CONSTRAINT match_lifecycle_events_attempts_nonnegative CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS match_lifecycle_events_unpublished_idx
  ON match_lifecycle_events (published_at, created_at);

CREATE INDEX IF NOT EXISTS match_lifecycle_events_match_idx
  ON match_lifecycle_events (match_id, created_at);
