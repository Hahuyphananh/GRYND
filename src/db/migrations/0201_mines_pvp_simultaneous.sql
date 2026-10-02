-- ── Mines PvP — simultaneous independent-board scoring ──────────────
-- Replaces the shared-board alternating-turn model with a SIMULTANEOUS
-- competitive scoring model. Every statement is additive and idempotent
-- (ADD COLUMN IF NOT EXISTS / ADD VALUE IF NOT EXISTS), so this can be
-- re-run and can also be pasted straight into the Supabase SQL editor.
--
-- What this migration does NOT do:
--   * it does NOT drop any existing column or enum label — legacy rows
--     (and the pre-rework client) still need `board`, `picks`,
--     `p{N}_flags`, `round_deadline`, `p1_turn`/`p2_turn`, …;
--   * it does NOT backfill the new per-seat boards for in-flight legacy
--     matches — those rows simply never advance into `active`.
--
-- WHY each new column:
--   * `p1_board` / `p2_board` — each seat's OWN server-generated board
--     (`{ size, mines, values }`). Both share dimensions/mine count/value
--     distribution; their mine POSITIONS must differ. Server-only: never
--     serialised while the match is live.
--   * `p{N}_revealed` — the cells a seat has resolved by revealing (safe
--     tiles + mines it detonated).
--   * `p{N}_correct_flags` — the subset of `p{N}_flags` that really are
--     mines. Backs board-completion and the tiebreak ladder.
--   * `p{N}_score` + the public stat counters — server-authoritative
--     scoring; a client can never submit any of them.
--   * `p{N}_completed` / `p{N}_completed_at` / `p{N}_locked` — a cleared
--     board is locked, keeps its final score, is shown to both players,
--     and is NOT an automatic victory.
--   * `match_deadline` / `match_timer_seconds` — ONE server-authoritative
--     180s match timer, replacing the old 20s per-turn window.

-- ── status enum: add the simultaneous-play state ────────────────────
-- ADD VALUE is idempotent and additive; the legacy p1_turn / p2_turn
-- labels are deliberately left in place for old rows.
ALTER TYPE "mines_pvp_status" ADD VALUE IF NOT EXISTS 'active';
--> statement-breakpoint

-- ── matches: per-seat boards + state ────────────────────────────────
ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_board" jsonb NOT NULL DEFAULT '{"size":10,"mines":[],"values":{}}'::jsonb;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_board" jsonb NOT NULL DEFAULT '{"size":10,"mines":[],"values":{}}'::jsonb;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_revealed" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_revealed" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_correct_flags" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_correct_flags" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_score" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_score" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_safe_revealed" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_safe_revealed" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_mines_hit" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_mines_hit" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_correct_flag_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_correct_flag_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_incorrect_flag_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_incorrect_flag_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_completed" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_completed" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_completed_at" timestamp;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_completed_at" timestamp;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_locked" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_locked" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "match_deadline" timestamp;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "match_timer_seconds" integer NOT NULL DEFAULT 180;
--> statement-breakpoint

-- ── rounds: replay mirror for both boards + scores ──────────────────
ALTER TABLE "mines_pvp_rounds"
  ADD COLUMN IF NOT EXISTS "p2_board_snapshot" jsonb NOT NULL DEFAULT '{"size":10,"mines":[],"values":{}}'::jsonb;
--> statement-breakpoint

ALTER TABLE "mines_pvp_rounds"
  ADD COLUMN IF NOT EXISTS "p1_score" integer;
--> statement-breakpoint

ALTER TABLE "mines_pvp_rounds"
  ADD COLUMN IF NOT EXISTS "p2_score" integer;
