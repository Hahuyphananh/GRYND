-- Migration: Add player report moderation system
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "is_banned" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "ban_reason" text,
  ADD COLUMN IF NOT EXISTS "banned_at" timestamp;
DO $$ BEGIN CREATE TYPE "player_report_status" AS ENUM ('open', 'reviewed', 'banned', 'dismissed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "player_report_reason" AS ENUM ('toxic_player', 'hacker', 'inappropriate_name', 'inappropriate_profile_picture', 'other'); EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE TABLE IF NOT EXISTS "player_reports" (
  "id" serial PRIMARY KEY,
  "reporter_clerk_id" varchar(255) NOT NULL,
  "reported_clerk_id" varchar(255) NOT NULL,
  "game_key" varchar(80) NOT NULL,
  "game_id" varchar(120),
  "reason" "player_report_reason" NOT NULL,
  "details" text,
  "status" "player_report_status" DEFAULT 'open' NOT NULL,
  "admin_clerk_id" varchar(255),
  "admin_note" text,
  "resolved_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_player_reports_status" ON "player_reports" USING btree ("status", "created_at");
CREATE INDEX IF NOT EXISTS "idx_player_reports_reported" ON "player_reports" USING btree ("reported_clerk_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_player_reports_reporter" ON "player_reports" USING btree ("reporter_clerk_id", "created_at");
