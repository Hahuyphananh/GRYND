-- Migration 0191 — Speed Typing: the authoritative RACE state.
--
-- 0190 landed the match's identity and lifecycle (a row with a nullable
-- `player2_id` that doubles as the open lobby). This migration lands the race
-- itself, following Mini Golf's 0179 → 0182 precedent of adding game state to a
-- table that already ships: every column here is ADDITIVE and nullable/defaulted,
-- so existing rows — including anything still `waiting` — stay valid untouched.
--
-- THE PERSISTENCE MODEL, in one paragraph. Typing produces an event per
-- keystroke, far more than any game should write rows for, so there is
-- deliberately NO keystroke table and NO per-event row: the socket layer streams
-- keystrokes, the server keeps the authoritative position, and only THROTTLED
-- CHECKPOINTS (PROGRESS_MIN_ADVANCE, src/lib/speed-typing/constants.ts) plus AT
-- MOST ONE VERIFIED FINISH PER SEAT reach the database. The authoritative blob
-- is `race_state` (jsonb), exactly like `mini_golf_matches.game_state`; the
-- `player*` columns beside it are a denormalised mirror of the handful of
-- numbers the lobby, match history and the boards read, so nothing has to parse
-- JSONB to list a result.
--
-- EVERYTHING A CLIENT CAN INFLUENCE IS A STRING IT TYPED. It never supplies a
-- winner, a progress count, a completion time, a WPM, an accuracy, an Elo delta
-- or a trophy count — those are derived server-side from the passage in
-- src/lib/speed-typing/passages.ts and the server's own clock, then written here.
--
-- WHY THE PASSAGE TEXT IS NOT A COLUMN. Only the SEED and the (id, version) pair
-- are stored; the text is derived in code from that pair. So a match is
-- reproducible forever, a bad passage is fixed by bumping the version, and the
-- server always verifies against the text IT resolved — never a client-supplied
-- target. Same shape as Mini Golf storing `seed` + `course_version`.
--
-- NO ECONOMY. There is no wager column on this table and no money-moving code
-- path in the store. A settled race moves exactly two kinds of number, both
-- owned by existing shared writers: per-game Elo and per-game trophies, plus
-- `users.games_won` / `users.games_lost`.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS, and each constraint is
-- dropped before it is re-added), so it can also be pasted straight into the
-- Supabase SQL editor.

ALTER TABLE speed_typing_matches
  -- Server-generated race seed, bigint because the 32-bit unsigned range (up to
  -- 4294967295) overflows int4. Selection is deterministic — see
  -- `passageIndexFromSeed` in src/lib/speed-typing/passages.ts.
  ADD COLUMN IF NOT EXISTS race_seed BIGINT,
  -- The passage pair this match is raced on. Immutable once armed.
  ADD COLUMN IF NOT EXISTS passage_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS passage_version INTEGER,
  -- The ABSOLUTE server instant typing opens (join instant + countdown). Both
  -- seats are told the same instant on the same clock; no client clock is ever
  -- trusted with a number that decides a rated match.
  ADD COLUMN IF NOT EXISTS go_at TIMESTAMP,
  -- Monotonic per authoritative write. The concurrency field: a client can
  -- compare it to detect a stale view, and every accepted checkpoint, finish,
  -- forfeit and resolution increments it.
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0,
  -- How the server ended it: finish | deadline | forfeit | draw.
  ADD COLUMN IF NOT EXISTS resolution_reason VARCHAR(32),
  -- The authoritative race state: { version, seats: { player1, player2 }, ... }.
  -- Never NULL, so a legacy/unarmed row coerces to an empty race rather than
  -- forcing every read to null-check.
  ADD COLUMN IF NOT EXISTS race_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Authoritative progress + correct/incorrect counts, per seat (the mirror of
  -- race_state.seats.* for indexed reads).
  ADD COLUMN IF NOT EXISTS player1_chars_typed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS player1_errors INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS player2_chars_typed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS player2_errors INTEGER NOT NULL DEFAULT 0,
  -- Authoritative completion, per seat: the SERVER instant of the verified
  -- finish. NULL means "this seat has not completed the passage".
  ADD COLUMN IF NOT EXISTS player1_completed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS player2_completed_at TIMESTAMP;--> statement-breakpoint

-- Progress and error counts are counts, and errors can never exceed the
-- characters typed (correct = typed − errors). Enforced in the database as well
-- as in the store, so a hand-written UPDATE cannot corrupt a match's numbers.
ALTER TABLE speed_typing_matches
  DROP CONSTRAINT IF EXISTS speed_typing_matches_progress_nonnegative;--> statement-breakpoint
ALTER TABLE speed_typing_matches
  ADD CONSTRAINT speed_typing_matches_progress_nonnegative CHECK (
    player1_chars_typed >= 0 AND player2_chars_typed >= 0
    AND player1_errors >= 0 AND player2_errors >= 0
    AND revision >= 0
  );--> statement-breakpoint

ALTER TABLE speed_typing_matches
  DROP CONSTRAINT IF EXISTS speed_typing_matches_errors_within_progress;--> statement-breakpoint
ALTER TABLE speed_typing_matches
  ADD CONSTRAINT speed_typing_matches_errors_within_progress CHECK (
    player1_errors <= player1_chars_typed
    AND player2_errors <= player2_chars_typed
  );--> statement-breakpoint

-- A seat cannot have completed the passage before the race opened.
ALTER TABLE speed_typing_matches
  DROP CONSTRAINT IF EXISTS speed_typing_matches_completed_after_go;--> statement-breakpoint
ALTER TABLE speed_typing_matches
  ADD CONSTRAINT speed_typing_matches_completed_after_go CHECK (
    go_at IS NULL
    OR (player1_completed_at IS NULL OR player1_completed_at >= go_at)
      AND (player2_completed_at IS NULL OR player2_completed_at >= go_at)
  );--> statement-breakpoint

ALTER TABLE speed_typing_matches
  DROP CONSTRAINT IF EXISTS speed_typing_matches_resolution_reason_valid;--> statement-breakpoint
ALTER TABLE speed_typing_matches
  ADD CONSTRAINT speed_typing_matches_resolution_reason_valid CHECK (
    resolution_reason IS NULL
    OR resolution_reason IN ('finish', 'deadline', 'forfeit', 'draw')
  );--> statement-breakpoint

ALTER TABLE speed_typing_matches
  DROP CONSTRAINT IF EXISTS speed_typing_matches_race_seed_range;--> statement-breakpoint
ALTER TABLE speed_typing_matches
  ADD CONSTRAINT speed_typing_matches_race_seed_range CHECK (
    race_seed IS NULL OR (race_seed >= 0 AND race_seed <= 4294967295)
  );--> statement-breakpoint

-- The scheduler's query: "armed races whose hard limit has passed and which are
-- still unresolved". Grouped by status first, then by GO instant.
CREATE INDEX IF NOT EXISTS speed_typing_matches_due_idx
  ON speed_typing_matches(status, go_at);--> statement-breakpoint

COMMENT ON COLUMN speed_typing_matches.race_seed IS
  'Server-generated race seed; selects the passage deterministically';
COMMENT ON COLUMN speed_typing_matches.passage_id IS
  'Catalog id of the passage both seats race (text lives in code, per version)';
COMMENT ON COLUMN speed_typing_matches.passage_version IS
  'Catalog version the passage id resolves under; bump to change any text';
COMMENT ON COLUMN speed_typing_matches.go_at IS
  'Absolute server instant typing opens (join instant + RACE_COUNTDOWN_MS)';
COMMENT ON COLUMN speed_typing_matches.revision IS
  'Monotonic per authoritative write; clients compare it for staleness';
COMMENT ON COLUMN speed_typing_matches.resolution_reason IS
  'How the server ended the race: finish | deadline | forfeit | draw';
COMMENT ON COLUMN speed_typing_matches.race_state IS
  'Authoritative race state: { version, seats: { player1, player2 } } — never a keystroke log';
COMMENT ON COLUMN speed_typing_matches.player1_chars_typed IS
  'Authoritative progress: characters of the passage seat 1 has typed (server-derived)';
COMMENT ON COLUMN speed_typing_matches.player1_errors IS
  'Wrong characters typed by seat 1, monotonic — a correction never erases a mistake';
COMMENT ON COLUMN speed_typing_matches.player1_completed_at IS
  'Server instant of seat 1''s verified finish (NULL until it completes the passage)';
COMMENT ON COLUMN speed_typing_matches.player2_chars_typed IS
  'Authoritative progress: characters of the passage seat 2 has typed (server-derived)';
COMMENT ON COLUMN speed_typing_matches.player2_errors IS
  'Wrong characters typed by seat 2, monotonic — a correction never erases a mistake';
COMMENT ON COLUMN speed_typing_matches.player2_completed_at IS
  'Server instant of seat 2''s verified finish (NULL until it completes the passage)';
