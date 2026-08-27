-- Crash Arena — private tables, server-scheduled next round, per-bot difficulty.
--
--   crash_arena_tables.is_private   — host-created private tables are hidden
--                                     from the public lobby grid; only the
--                                     host may add AI seats to them (AIs are
--                                     private-only, like the poker tables).
--   crash_arena_tables.next_round_at — absolute wall-clock deadline for the
--                                     next round start, written when a hand
--                                     settles. Every client counts down to
--                                     the SAME moment and the start-round
--                                     route rejects early starts, so a round
--                                     can never fire before a client's
--                                     countdown ends.
--   crash_arena_players.ai_difficulty — per-bot difficulty (easy/medium/hard)
--                                     picked in the Add-AI dialog; NULL for
--                                     human seats.
--
-- All columns are additive (ADD COLUMN IF NOT EXISTS), mirroring 0090/0098.

ALTER TABLE "crash_arena_tables"
  ADD COLUMN IF NOT EXISTS "is_private" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "next_round_at" timestamp;

ALTER TABLE "crash_arena_players"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(20);
