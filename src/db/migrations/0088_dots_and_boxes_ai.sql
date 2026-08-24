-- Free Dots & Boxes practice matches use the normal board engine but never wager, pay out, or affect PvP stats.
ALTER TABLE "dots_and_boxes_games"
  ADD COLUMN IF NOT EXISTS "is_ai_game" boolean NOT NULL DEFAULT false;
