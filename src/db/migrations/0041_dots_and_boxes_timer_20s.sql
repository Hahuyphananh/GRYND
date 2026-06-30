-- ── Dots & Boxes: extend default turn timer from 10s to 20s ──────────
-- Players reported the 10s window felt rushed for scanning the board
-- before committing an edge. Bumps the column default to 20s so
-- newly-created games start with the longer window. Existing in-flight
-- games keep their per-row timer_seconds (they were stamped at create
-- time); this migration ONLY changes the column default for future rows.
ALTER TABLE "dots_and_boxes_games"
  ALTER COLUMN "timer_seconds" SET DEFAULT 20;
