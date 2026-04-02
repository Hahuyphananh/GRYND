ALTER TABLE "chess_games"
ADD COLUMN IF NOT EXISTS "timer_mode" varchar(20) NOT NULL DEFAULT 'blitz',
ADD COLUMN IF NOT EXISTS "initial_time_seconds" integer NOT NULL DEFAULT 300,
ADD COLUMN IF NOT EXISTS "started_at" timestamp;
