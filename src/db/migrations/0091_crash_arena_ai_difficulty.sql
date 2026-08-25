-- Crash Arena practice difficulty (easy/medium/hard, mirroring the poker
-- table AIs). Set at table creation for AI practice tables only; real
-- tables leave it NULL.
ALTER TABLE "crash_arena_tables"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(20);
