-- Crash Poker — hand-state columns on the existing Crash Arena tables.
--
-- The lobby / table / buy-in / socket infrastructure is unchanged; only the
-- game concept inside a hand becomes poker-style betting (blinds + ante,
-- fold/call/raise at 0.25x checkpoints) against the crash curve.
--
--   crash_arena_tables.carry_over   — pot carried from a hand with no winner
--   crash_arena_rounds.*            — blinds, dealer, open checkpoint,
--                                     required bet, betting window, snapshot
--   crash_arena_entries.*           — per-player hand state (contributed,
--                                     fold point, last action, active flag)
--
-- All columns are additive (ADD COLUMN IF NOT EXISTS) so this is safe to run
-- on an environment that is one migration behind — mirroring 0090/0091.

ALTER TABLE "crash_arena_tables"
  ADD COLUMN IF NOT EXISTS "carry_over" numeric(14, 2) NOT NULL DEFAULT '0.00';

ALTER TABLE "crash_arena_rounds"
  ADD COLUMN IF NOT EXISTS "small_blind" numeric(10, 2),
  ADD COLUMN IF NOT EXISTS "big_blind" numeric(10, 2),
  ADD COLUMN IF NOT EXISTS "dealer_position" integer,
  ADD COLUMN IF NOT EXISTS "checkpoint_index" integer NOT NULL DEFAULT -1,
  ADD COLUMN IF NOT EXISTS "required_bet" numeric(14, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "betting_open" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hand_state" jsonb;

ALTER TABLE "crash_arena_entries"
  ADD COLUMN IF NOT EXISTS "contributed" numeric(14, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "folded_at_multiplier" numeric(6, 2),
  ADD COLUMN IF NOT EXISTS "last_action" varchar(20),
  ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;
