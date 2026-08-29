-- 0111: Explicit Quick Queue destination metadata

ALTER TABLE quick_queue_assignments
  ADD COLUMN IF NOT EXISTS destination_match_id varchar(255);

CREATE INDEX IF NOT EXISTS quick_queue_assignments_destination_idx
  ON quick_queue_assignments (game_key, destination_match_id);
