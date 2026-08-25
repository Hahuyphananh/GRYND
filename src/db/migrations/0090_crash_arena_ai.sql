-- Free Crash Arena practice tables: a human plays head-to-head against the
-- GRYND AI bot with free table chips. No wallet deductions, refunds, or
-- payouts happen on these tables — every balance is virtual.
ALTER TABLE "crash_arena_tables"
  ADD COLUMN IF NOT EXISTS "is_ai" boolean NOT NULL DEFAULT false;
