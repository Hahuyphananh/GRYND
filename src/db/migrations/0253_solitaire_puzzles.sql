-- 0253_solitaire_puzzles.sql
--
-- THE DAILY + UNLIMITED SOLITAIRE PUZZLE.
--
-- WHY
--   The daily page already hosts the deterministic daily GAME. On top of it the
--   product now offers a one-move PUZZLE: a real position from an engine-verified
--   winning deal, three candidate moves, exactly one of which turns a face-down
--   card face up and stays on the winning line. The daily puzzle is free and can
--   be answered ONCE a day; the unlimited puzzle is 5/day on the free plan and
--   unlimited for GRYND PRO.
--
-- TABLES
--   solitaire_puzzle_attempts — ONE row per identity per puzzle. The unique
--     (user_id, puzzle_key) index is what makes the daily puzzle one-shot: a
--     second submission conflicts and records nothing, exactly like the daily
--     game's (user_id, challenge_date) backstop.
--   solitaire_puzzle_usage — one row per (identity, UTC day) counting answered
--     UNLIMITED puzzles. The daily puzzle never touches this table.
--
--   There is deliberately NO foreign key to `users`: the daily puzzle is free to
--   a signed guest (`grynd_guest` cookie), whose identity is not a user row.
--   Account deletion removes these rows in the same sweep as the player's other
--   solitaire data.
--
-- RLS: default-deny. Only the Next.js server reads or writes these tables;
-- nothing is published to the browser or Realtime.
--
-- Idempotent + additive: CREATE TABLE/INDEX IF NOT EXISTS, no drops, no rewrites.

CREATE TABLE IF NOT EXISTS "solitaire_puzzle_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Clerk user id, or the signed guest id. No FK: a guest has no user row.
  "user_id" varchar(255) NOT NULL,
  -- 'daily' | 'unlimited'.
  "kind" varchar(16) NOT NULL,
  -- 'daily:YYYY-MM-DD' or 'unlimited:<seed>'. The puzzle is rebuildable from it.
  "puzzle_key" varchar(80) NOT NULL,
  -- The ONE answer the player chose. Server-verified against the rebuilt puzzle.
  "choice" varchar(1) NOT NULL,
  "correct" boolean NOT NULL DEFAULT false,
  "elapsed_ms" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "solitaire_puzzle_attempts_kind_check"
    CHECK ("kind" IN ('daily', 'unlimited')),
  CONSTRAINT "solitaire_puzzle_attempts_choice_check"
    CHECK ("choice" IN ('A', 'B', 'C'))
);

-- THE one-shot guarantee: one answer per identity per puzzle (per day for the
-- daily puzzle, per seed for an unlimited one).
CREATE UNIQUE INDEX IF NOT EXISTS "solitaire_puzzle_attempts_user_puzzle_unique"
  ON "solitaire_puzzle_attempts" ("user_id", "puzzle_key");

CREATE INDEX IF NOT EXISTS "solitaire_puzzle_attempts_user_idx"
  ON "solitaire_puzzle_attempts" ("user_id", "created_at");

ALTER TABLE "solitaire_puzzle_attempts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "solitaire_puzzle_attempts_no_client_access" ON "solitaire_puzzle_attempts";
CREATE POLICY "solitaire_puzzle_attempts_no_client_access" ON "solitaire_puzzle_attempts"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE "solitaire_puzzle_attempts" IS
  'One verified answer per identity per solitaire puzzle; the unique key makes the daily puzzle one-shot';
COMMENT ON COLUMN "solitaire_puzzle_attempts"."puzzle_key" IS
  'daily:YYYY-MM-DD for the free daily puzzle, unlimited:<seed> for a practice puzzle';

CREATE TABLE IF NOT EXISTS "solitaire_puzzle_usage" (
  -- Clerk user id, or the signed guest id. No FK: a guest has no user row.
  "user_id" varchar(255) NOT NULL,
  -- UTC calendar day, YYYY-MM-DD. The allowance resets at UTC midnight.
  "day_key" varchar(10) NOT NULL,
  -- UNLIMITED puzzles answered today. Never decremented. The daily puzzle is
  -- free and is not counted here.
  "used" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "solitaire_puzzle_usage_pk" PRIMARY KEY ("user_id", "day_key")
);

ALTER TABLE "solitaire_puzzle_usage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "solitaire_puzzle_usage_no_client_access" ON "solitaire_puzzle_usage";
CREATE POLICY "solitaire_puzzle_usage_no_client_access" ON "solitaire_puzzle_usage"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE "solitaire_puzzle_usage" IS
  'Per-identity, per-UTC-day count of unlimited solitaire puzzles; PRO members are never counted';
COMMENT ON COLUMN "solitaire_puzzle_usage"."used" IS
  'Unlimited puzzles answered that day; the free daily puzzle costs nothing';
