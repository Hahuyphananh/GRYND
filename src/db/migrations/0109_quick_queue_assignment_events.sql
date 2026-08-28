-- 0109: Durable Quick Queue assignment events

CREATE TABLE IF NOT EXISTS quick_queue_assignment_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES quick_queue_assignments(id) ON DELETE CASCADE,
  request_ids jsonb NOT NULL,
  event_type varchar(40) NOT NULL DEFAULT 'quick_queue:ready',
  payload jsonb NOT NULL,
  published_at timestamp,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS quick_queue_assignment_events_unpublished_idx
  ON quick_queue_assignment_events (published_at, created_at);

CREATE INDEX IF NOT EXISTS quick_queue_assignment_events_assignment_idx
  ON quick_queue_assignment_events (assignment_id, created_at);
