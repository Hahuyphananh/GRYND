-- ── Dots & Boxes PvP game table ───────────────────────────────────────────
-- Follows the same conventions as connect_four_games / hex_duel_games.
-- Gameplay state (grid, lines, boxes, scores) lives in `game_state` jsonb.
CREATE TABLE IF NOT EXISTS "dots_and_boxes_games" (
  "id" serial PRIMARY KEY,
  "host_clerk_id" varchar(255) NOT NULL,
  "guest_clerk_id" varchar(255),
  "bet_amount" numeric(10, 2) NOT NULL,
  "status" varchar(30) NOT NULL DEFAULT 'waiting',
  "game_state" jsonb DEFAULT '{}'::jsonb,
  "winner_clerk_id" varchar(255),
  "result" varchar(30),
  "payout" numeric(10, 2),
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dots_and_boxes_status_idx"
  ON "dots_and_boxes_games" ("status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dots_and_boxes_host_idx"
  ON "dots_and_boxes_games" ("host_clerk_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dots_and_boxes_guest_idx"
  ON "dots_and_boxes_games" ("guest_clerk_id");
