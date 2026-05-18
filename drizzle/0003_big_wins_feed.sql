-- Migration: Add big_wins table for big wins feed
-- This table tracks wins of 1 million tokens or more for display in the chat widget

CREATE TABLE IF NOT EXISTS "big_wins" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" text NOT NULL,
    "username" text NOT NULL,
    "game" text NOT NULL,
    "bet_amount" integer NOT NULL,
    "win_amount" integer NOT NULL,
    "multiplier" double precision NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
);

-- Index for querying by creation date (for recent big wins feed)
CREATE INDEX IF NOT EXISTS "idx_big_wins_created_at" ON "big_wins" USING BTREE ("created_at");

-- Index for querying by multiplier (for sorting by biggest multipliers)
CREATE INDEX IF NOT EXISTS "idx_big_wins_multiplier" ON "big_wins" USING BTREE ("multiplier");