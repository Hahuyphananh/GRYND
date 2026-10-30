-- 0233: LAST RUN match record — participants, authoritative outcome, ratings.
--
-- WHY THIS EXISTS
--   Until now a completed LAST RUN match was recorded only as JSON on a
--   `match_lifecycle_events` row, with:
--     * no participant ids anywhere (the lifecycle table is queue-level and
--       has no player columns), so no query could answer "my LAST RUN matches";
--     * no typed winner / distance / survival columns, so the result could not
--       be filtered, indexed or verified;
--     * no natural key the settlement could rely on for exactly-once writes.
--
--   `match_lifecycle` is deliberately NOT extended: it is the platform's shared
--   queue record for every game, and adding game-specific player/outcome
--   columns there would duplicate the per-game tables every other game already
--   keeps (chess_games, tic_tac_toe_matches, lane_rush_duel_matches, …).
--
--   This table is that per-game record. It is the AUTHORITATIVE result: the row
--   is written by the server's settlement transaction (src/lib/last-run/
--   settlement.ts) from the engine's own final state, inside the same
--   transaction that applies Elo. No client ever supplies a winner, distance,
--   survival time or rating.
--
-- CONVENTIONS (matching every other PvP table)
--   * `id` is the registry match id (a UUID) — the natural idempotency key:
--     `INSERT … ON CONFLICT ("id") DO NOTHING` makes a retry a no-op.
--   * Player ids are plain Clerk id strings with NO FK to `users`, exactly like
--     `tic_tac_toe_matches` / `lane_rush_duel_matches` (users are deletable and
--     historical matches must survive that; account deletion purges these rows
--     explicitly via the existing purge list).
--   * `result` is seat-absolute ('player1' | 'player2' | 'draw'); every reader
--     converts to a viewer-relative win/loss/draw.
--   * Elo and trophies are NOT duplicated here. They live in `rating_events` /
--     `trophy_events`, keyed by (user, game_key, match_id), which is the
--     platform's exactly-once journal.
--
-- Safe: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. Nothing
-- existing is altered.

CREATE TABLE IF NOT EXISTS "last_run_matches" (
  "id" uuid PRIMARY KEY,
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255) NOT NULL,
  "winner_id" varchar(255),
  "result" varchar(8) NOT NULL,
  "end_reason" varchar(16) NOT NULL,
  "player1_distance" integer NOT NULL DEFAULT 0,
  "player2_distance" integer NOT NULL DEFAULT 0,
  "player1_survival_ms" integer NOT NULL DEFAULT 0,
  "player2_survival_ms" integer NOT NULL DEFAULT 0,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "seed" bigint NOT NULL,
  "rated" boolean NOT NULL DEFAULT false,
  "started_at" timestamp NOT NULL,
  "ended_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT NOW(),
  CONSTRAINT "last_run_matches_distinct_players" CHECK ("player1_id" <> "player2_id"),
  CONSTRAINT "last_run_matches_result_valid" CHECK ("result" IN ('player1', 'player2', 'draw')),
  CONSTRAINT "last_run_matches_winner_matches_result" CHECK (
    ("result" = 'draw' AND "winner_id" IS NULL) OR
    ("result" <> 'draw' AND "winner_id" IS NOT NULL)
  ),
  CONSTRAINT "last_run_matches_time_order" CHECK ("ended_at" >= "started_at"),
  CONSTRAINT "last_run_matches_counts_nonnegative" CHECK (
    "player1_distance" >= 0 AND "player2_distance" >= 0 AND
    "player1_survival_ms" >= 0 AND "player2_survival_ms" >= 0 AND
    "duration_ms" >= 0
  )
);

-- Match history: "my matches, newest first", one index per seat.
CREATE INDEX IF NOT EXISTS "last_run_matches_p1_idx"
  ON "last_run_matches" ("player1_id", "ended_at" DESC);

CREATE INDEX IF NOT EXISTS "last_run_matches_p2_idx"
  ON "last_run_matches" ("player2_id", "ended_at" DESC);

-- Global recency (retention sweep / operational reads).
CREATE INDEX IF NOT EXISTS "last_run_matches_ended_idx"
  ON "last_run_matches" ("ended_at" DESC);
