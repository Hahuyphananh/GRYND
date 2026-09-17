-- Migration: 0160_precision_persistence
--
-- Persists the Precision PvP duel (lobbies + match state) in Postgres.
-
-- WHY
--   Precision's lobby and match state lived in two `globalThis` Maps
--   (`precisionLobbyStore` / `precisionMatchStore`) with `setTimeout`s driving
--   the round countdown and the bot's stop. On Vercel that is not a store: each
--   instance had its own copy, so a match created by one request did not exist
--   for the next poll (the player was routed to a match page that rendered
--   nothing) and a round could sit at "0" forever because the timer died with
--   the instance. Nothing was ever reclaimed either.
--
-- WHAT
--   precision_lobbies  the PvP queue. The lobby id doubles as the match id once
--                      two players are paired (see `tryAutoMatch`), so both URL
--                      shapes (`/games/precision/game/<id>`) keep working.
--   precision_matches  one row per match: the public PrecisionState snapshot as
--                      jsonb plus the canonical house columns that the shared
--                      reporting surfaces already read
--                      (player1_id / player2_id / winner_id / wager / status /
--                      created_at / ended_at — same shape as pool_matches and
--                      tower_arena_matches), plus the SERVER-ONLY values that
--                      make the game work without a live process:
--                        server_target_ms  the rolled target while arming
--                        ai_stop_at        the instant the bot stops at
--                        pending_stops     round-in-flight stop telemetry
--                        anomaly_ledger    audit samples + logged flags
--
--   No timers: the countdown and the bot are stored INSTANTS that the next read
--   acts on, so a recycled instance can never strand a round.
--
-- LIFECYCLE
--   precision_lobbies: waiting → active (paired; the id becomes the match id)
--                      waiting → deleted (host cancelled / TTL sweep)
--   precision_matches: ready_up → arming → active → … → finished
--                      any non-finished phase → deleted (abandoned sweep,
--                      practice leave, or a cancelled match)
--
-- LEGACY STUB
--   Migration 0035 created `precision_matches` / `precision_rounds` as an
--   unwritten stub (integer id, player1_id/player2_id/wager/status/winner_id,
--   no state). Nothing in the codebase ever inserted into them — only the
--   analytics, retention, live-stats and sitemap reads referenced the name —
--   so this migration takes over the canonical name with the REAL columns the
--   game needs. The stub is renamed aside (never dropped) so any historical
--   rows survive untouched; the guarded block keeps a re-run a no-op.

DO $$
BEGIN
  IF to_regclass('public.precision_matches') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'precision_matches'
         AND column_name = 'player1_id'
     )
  THEN
    IF to_regclass('public.precision_matches_legacy_0035') IS NULL THEN
      ALTER TABLE "precision_matches" RENAME TO "precision_matches_legacy_0035";
    END IF;
  END IF;

  IF to_regclass('public.precision_rounds') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'precision_rounds'
         AND column_name = 'round_number'
     )
  THEN
    IF to_regclass('public.precision_rounds_legacy_0035') IS NULL THEN
      ALTER TABLE "precision_rounds" RENAME TO "precision_rounds_legacy_0035";
    END IF;
  END IF;
END $$;

-- ── precision_lobbies ──────────────────────────────────────────────────
-- One row per waiting PvP queue entry. Host identity is the Clerk user id
-- (never a client-supplied value) and the display name is sanitized.

CREATE TABLE IF NOT EXISTS "precision_lobbies" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "host_user_id" VARCHAR(255) NOT NULL,
  "host_name" VARCHAR(64) NOT NULL DEFAULT 'Player 1',
  "opponent_user_id" VARCHAR(255),
  "opponent_name" VARCHAR(64),
  "wager" INTEGER NOT NULL,
  "game_mode" VARCHAR(12) NOT NULL DEFAULT 'pvp',
  "status" VARCHAR(12) NOT NULL DEFAULT 'waiting',
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Pairing query: "oldest waiting lobby at my wager that isn't mine".
-- List query: "all waiting lobbies".
CREATE INDEX IF NOT EXISTS "precision_lobbies_status_idx"
  ON "precision_lobbies" ("status", "wager", "created_at");

-- Idempotent re-queue: "my own waiting lobby at this wager".
CREATE INDEX IF NOT EXISTS "precision_lobbies_host_idx"
  ON "precision_lobbies" ("host_user_id", "status");

-- ── precision_matches ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "precision_matches" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "player1_id" VARCHAR(255) NOT NULL,
  "player2_id" VARCHAR(255),
  "winner_id" VARCHAR(255),
  "wager" INTEGER NOT NULL DEFAULT 0,
  "status" VARCHAR(20) NOT NULL DEFAULT 'waiting',
  "is_ai_game" BOOLEAN NOT NULL DEFAULT FALSE,
  "phase" VARCHAR(16) NOT NULL DEFAULT 'ready_up',
  "state" JSONB NOT NULL,
  "pending_stops" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "anomaly_ledger" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "server_target_ms" INTEGER,
  "ai_stop_at" TIMESTAMP,
  "payout_processed_at" TIMESTAMP,
  "ended_at" TIMESTAMP,
  "touched_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Abandoned-match sweep: unfinished matches that stopped moving.
CREATE INDEX IF NOT EXISTS "precision_matches_phase_idx"
  ON "precision_matches" ("phase", "touched_at");

-- Finished-match sweep + retention purge (`WHERE status IN (...) AND ended_at <`).
CREATE INDEX IF NOT EXISTS "precision_matches_ended_idx"
  ON "precision_matches" ("ended_at");

-- Per-player history, same shape as pool_matches.
CREATE INDEX IF NOT EXISTS "precision_matches_player1_idx"
  ON "precision_matches" ("player1_id", "created_at");

CREATE INDEX IF NOT EXISTS "precision_matches_player2_idx"
  ON "precision_matches" ("player2_id", "created_at");
