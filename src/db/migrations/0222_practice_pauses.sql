-- 0222_practice_pauses.sql
--
-- FREE-PLAY PAUSE (human vs AI only).
--
-- One row per paused vs-AI match. `paused_at` is the instant the human pressed
-- Pause. Resuming deletes the row and shifts the game's own clock forward by
-- the paused window (started_at / go_at / round_deadline, and the equivalent
-- JSON state), so a pause never burns a turn and the server-side bot cannot
-- bank progress while nobody is watching.
--
-- WHY ONE GENERIC TABLE: the alternative is a `paused` column on 19 match
-- tables plus 19 migrations. The game key is validated against a server-side
-- allowlist (never a client-supplied table name), and the service refuses any
-- row whose match is not a live vs-AI match, so a PvP match can never be
-- paused through this path.
--
-- Additive and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS "practice_pauses" (
  "id" serial PRIMARY KEY,
  "game" varchar(32) NOT NULL,
  "match_id" varchar(64) NOT NULL,
  "user_id" varchar(255) NOT NULL,
  "paused_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "practice_pauses_game_match_unique"
  ON "practice_pauses" ("game", "match_id");

CREATE INDEX IF NOT EXISTS "practice_pauses_game_idx"
  ON "practice_pauses" ("game", "paused_at");

COMMENT ON TABLE "practice_pauses" IS
  'Active free-play pause per vs-AI match; deleted on resume after the game clock is shifted forward';
COMMENT ON COLUMN "practice_pauses"."game" IS
  'Game key from the server-side practice-pause allowlist (chess, speed-typing, ...)';
COMMENT ON COLUMN "practice_pauses"."paused_at" IS
  'Instant Pause was pressed — the pause window subtracted from the game clock on resume';
