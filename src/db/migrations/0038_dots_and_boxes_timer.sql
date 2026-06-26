-- ── Dots & Boxes: add turn timer columns ─────────────────────────
ALTER TABLE "dots_and_boxes_games"
  ADD COLUMN IF NOT EXISTS "move_deadline_at" timestamp,
  ADD COLUMN IF NOT EXISTS "timer_seconds" integer NOT NULL DEFAULT 10;
