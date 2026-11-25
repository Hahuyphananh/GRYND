-- 0264_solitaire_puzzle_sessions.sql
--
-- The server-authoritative Puzzle Ranked / Puzzle vs AI session foundation.
--
-- Two NEW tables, deliberately separate from `solitaire_duel_matches`: a puzzle
-- session races a frozen sequence of puzzle specs rather than one shared deal,
-- and its outcome is a solved count plus a solve instant, so reusing the duel
-- table would overload columns with different settlement semantics.
--
-- WHAT IS STORED SERVER-ONLY:
--   * `manifest` — the frozen start states (face-down identities, stock order),
--     objectives and constraints. No accepted solution path, no verification.
--   * `p1_state` / `p2_state` — the live authoritative board per seat.
--   * `selection_seed` — the selection entropy; `selection_hash` is its public
--     commitment.
-- The browser only ever receives the sanitized projection built in
-- src/lib/solitaire-puzzle/projection.ts.
--
-- No rating, trophy, wager or queue column exists here: this phase awards
-- nothing, and a practice session must never be settleable.
--
-- Forward-only and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS "solitaire_puzzle_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "format" varchar(24) NOT NULL DEFAULT 'puzzle-race-v1',
  "mode" varchar(16) NOT NULL DEFAULT 'ranked',
  "status" varchar(16) NOT NULL DEFAULT 'waiting',
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255),
  "is_ai" boolean NOT NULL DEFAULT false,
  "ai_difficulty" varchar(24),
  "puzzle_count" integer NOT NULL DEFAULT 5,
  "selection_seed" varchar(64) NOT NULL,
  "selection_hash" varchar(64) NOT NULL,
  "manifest" jsonb NOT NULL,
  "p1_puzzle_index" integer NOT NULL DEFAULT 0,
  "p1_solved" integer NOT NULL DEFAULT 0,
  "p1_ply" integer NOT NULL DEFAULT 0,
  "p1_state" jsonb NOT NULL,
  "p1_stats" jsonb NOT NULL,
  "p1_last_solve_at" timestamp,
  "p1_finished_at" timestamp,
  "p1_last_action_at" timestamp,
  "p2_puzzle_index" integer NOT NULL DEFAULT 0,
  "p2_solved" integer NOT NULL DEFAULT 0,
  "p2_ply" integer NOT NULL DEFAULT 0,
  "p2_state" jsonb NOT NULL,
  "p2_stats" jsonb NOT NULL,
  "p2_last_solve_at" timestamp,
  "p2_finished_at" timestamp,
  "p2_last_action_at" timestamp,
  "go_at" timestamp,
  "deadline_at" timestamp,
  "ended_at" timestamp,
  "result" varchar(16),
  "winner_id" varchar(255),
  "resolution_reason" varchar(16),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "solitaire_puzzle_sessions_p1_idx"
  ON "solitaire_puzzle_sessions" ("player1_id", "created_at");

CREATE INDEX IF NOT EXISTS "solitaire_puzzle_sessions_p2_idx"
  ON "solitaire_puzzle_sessions" ("player2_id", "created_at");

CREATE INDEX IF NOT EXISTS "solitaire_puzzle_sessions_status_idx"
  ON "solitaire_puzzle_sessions" ("status", "updated_at");

CREATE TABLE IF NOT EXISTS "solitaire_puzzle_session_moves" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL,
  "seat" varchar(16) NOT NULL,
  "ply" integer NOT NULL,
  "puzzle_index" integer NOT NULL DEFAULT 0,
  "kind" varchar(32) NOT NULL,
  "move" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- THE concurrency backstop: one accepted move per (session, seat, ply). A
-- duplicate or racing submission collides here and the store reports a 409.
CREATE UNIQUE INDEX IF NOT EXISTS "solitaire_puzzle_session_moves_seat_ply_unique"
  ON "solitaire_puzzle_session_moves" ("session_id", "seat", "ply");

CREATE INDEX IF NOT EXISTS "solitaire_puzzle_session_moves_session_idx"
  ON "solitaire_puzzle_session_moves" ("session_id", "created_at");
