-- ── Migration: 0045_blackjack_pvp_schema_refactor.sql ────────────────
-- Refactors the Blackjack PvP match schema to align with the user
-- spec. Each match row now exposes these spec-named columns:
--   matchId (PK)
--   player1Id / player2Id                       (unchanged)
--   roundNumber                                 (renamed from current_round)
--   roundsWonPlayer1 / roundsWonPlayer2         (renamed from score_player1/2)
--   player1Hand / player2Hand                   (unchanged)
--   player1OriginalCards / player2OriginalCards (NEW — snapshotted at deal time)
--   player1FrozenCard / player2FrozenCard       (renamed from player1/2_held_card)
--   player1UsedSwap / player2UsedSwap           (renamed from player1/2_swaps_used, int kept for forward compat)
--   player1UsedFreeze / player2UsedFreeze       (renamed from player1/2_holds_used, int kept for forward compat)
--   player1Standing / player2Standing           (COMPUTE-ON-READ — derived from playerN_state, NOT a column to avoid split-brain)
--   winner                                      (renamed from winner_id; userId of the winning player)
--   status                                      (unchanged enum)
--
-- All renames + new column adds are split across two tables
-- (blackjack_pvp_matches + blackjack_pvp_rounds) so post-match
-- replays continue to read the same shape they wrote at deal-time.
-- The rounds mirroring is required because the page renders the
-- round-result reveal from `rounds` rows — without the per-round
-- originals / frozen-card snapshot, the modal would lose the
-- historical context.
--
-- Notes:
--   * standing is intentionally a wire-only computed boolean — adding
--     it as a stored column would introduce a constant battle with the
--     `player_state` enum to keep them in sync (and any drift would
--     be invisible until runtime).
--   * winner_id → winner is a simple rename; existing rows keep their
--     data, the new column name just surfaces it under the spec's
--     preferred label. The `result` column continues to be the
--     per-side identifier ("player1" | "player2" | "draw").
--   * PostgreSQL allows `ALTER TABLE ... RENAME COLUMN` + `ADD
--     COLUMN` in the same transaction; `--> statement-breakpoint`
--     gives the Drizzle migrator the per-statement breakpoints it
--     uses for partial-failure recovery.

-- ── blackjack_pvp_matches renames ─────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_matches' AND column_name = 'current_round'
  ) THEN
    ALTER TABLE "blackjack_pvp_matches" RENAME COLUMN "current_round" TO "round_number";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_matches' AND column_name = 'score_player1'
  ) THEN
    ALTER TABLE "blackjack_pvp_matches" RENAME COLUMN "score_player1" TO "rounds_won_player1";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_matches' AND column_name = 'score_player2'
  ) THEN
    ALTER TABLE "blackjack_pvp_matches" RENAME COLUMN "score_player2" TO "rounds_won_player2";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_matches' AND column_name = 'player1_swaps_used'
  ) THEN
    ALTER TABLE "blackjack_pvp_matches" RENAME COLUMN "player1_swaps_used" TO "player1_used_swap";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_matches' AND column_name = 'player2_swaps_used'
  ) THEN
    ALTER TABLE "blackjack_pvp_matches" RENAME COLUMN "player2_swaps_used" TO "player2_used_swap";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_matches' AND column_name = 'player1_holds_used'
  ) THEN
    ALTER TABLE "blackjack_pvp_matches" RENAME COLUMN "player1_holds_used" TO "player1_used_freeze";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_matches' AND column_name = 'player2_holds_used'
  ) THEN
    ALTER TABLE "blackjack_pvp_matches" RENAME COLUMN "player2_holds_used" TO "player2_used_freeze";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_matches' AND column_name = 'player1_held_card'
  ) THEN
    ALTER TABLE "blackjack_pvp_matches" RENAME COLUMN "player1_held_card" TO "player1_frozen_card";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_matches' AND column_name = 'player2_held_card'
  ) THEN
    ALTER TABLE "blackjack_pvp_matches" RENAME COLUMN "player2_held_card" TO "player2_frozen_card";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_matches' AND column_name = 'winner_id'
  ) THEN
    ALTER TABLE "blackjack_pvp_matches" RENAME COLUMN "winner_id" TO "winner";
  END IF;
END $$;
--> statement-breakpoint

-- ── blackjack_pvp_matches — new columns ──────────────────────────────
ALTER TABLE "blackjack_pvp_matches"
  ADD COLUMN IF NOT EXISTS "player1_original_cards" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "player2_original_cards" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

-- ── blackjack_pvp_rounds renames (mirror the matches table) ─────────
-- Post-match replays read from `rounds`, so the history rows must use
-- the same spec names. Without these renames the page would fall
-- back to legacy column reads on rows written by old code.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_rounds' AND column_name = 'player1_swaps_used'
  ) THEN
    ALTER TABLE "blackjack_pvp_rounds" RENAME COLUMN "player1_swaps_used" TO "player1_used_swap";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_rounds' AND column_name = 'player2_swaps_used'
  ) THEN
    ALTER TABLE "blackjack_pvp_rounds" RENAME COLUMN "player2_swaps_used" TO "player2_used_swap";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_rounds' AND column_name = 'player1_holds_used'
  ) THEN
    ALTER TABLE "blackjack_pvp_rounds" RENAME COLUMN "player1_holds_used" TO "player1_used_freeze";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_rounds' AND column_name = 'player2_holds_used'
  ) THEN
    ALTER TABLE "blackjack_pvp_rounds" RENAME COLUMN "player2_holds_used" TO "player2_used_freeze";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_rounds' AND column_name = 'player1_held_card'
  ) THEN
    ALTER TABLE "blackjack_pvp_rounds" RENAME COLUMN "player1_held_card" TO "player1_frozen_card";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blackjack_pvp_rounds' AND column_name = 'player2_held_card'
  ) THEN
    ALTER TABLE "blackjack_pvp_rounds" RENAME COLUMN "player2_held_card" TO "player2_frozen_card";
  END IF;
END $$;
--> statement-breakpoint

-- ── blackjack_pvp_rounds — new columns ───────────────────────────────
-- Per-round original-card snapshot mirrors the per-match snapshot so
-- post-match replays show exactly which cards were dealt at the
-- start of each round, even after a swap corrupted the live hand.
ALTER TABLE "blackjack_pvp_rounds"
  ADD COLUMN IF NOT EXISTS "player1_original_cards" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "player2_original_cards" jsonb NOT NULL DEFAULT '[]'::jsonb;
