-- 0249_solitaire_analysis_cache.sql
--
-- GAME REVIEW — one cached, versioned analysis per game + exact move log.
--
-- WHY
--   The analysis is deterministic: `analyzeSolitaireGame({deal, moves})` plus
--   ANALYSIS_VERSION fully determines the result. Phase 4 recomputed it in the
--   browser on every review visit, so a refresh or a second device repeated
--   the same work. This table stores it once.
--
-- THE IDENTITY IS THE KEY
--   (game_kind, game_id, log_digest, engine_version) is UNIQUE. `log_digest` is
--   the server-computed SHA-256 of the canonical ordered log, and
--   `engine_version` is ANALYSIS_VERSION, so a cached row becomes unreachable
--   the moment the log or the scoring engine changes. ON CONFLICT resolves two
--   concurrent first views onto one record; no duplicate analysis can exist.
--
-- WHAT IS STORED
--   `analysis` is a COMPACT jsonb payload: per-move ply/kind/rating/event tags/
--   score before/after/delta/regret/commentary eligibility/reason codes, the
--   key moments, and the summary. No deal, no move log, no board snapshot and
--   no prose — the commentary is still rendered from translation templates.
--
-- RETENTION
--   Deliberately no foreign key: `game_id` is polymorphic (a duel match id, a
--   solo result id or a daily result id), so one FK cannot express it. The
--   nightly retention sweep deletes rows whose parent game no longer exists
--   (duel matches are purged after 45 days), and account deletion removes the
--   rows for that player's games. This keeps the cache consistent with the
--   games it describes instead of growing as an orphan table.
--
-- RLS: default-deny, like the tables it describes. Every read/write goes
-- through the Next.js server; nothing here is exposed to the browser or
-- published to Realtime.
--
-- Idempotent + additive: CREATE TABLE/INDEX IF NOT EXISTS, no drops, no
-- rewrites, no backfill.

CREATE TABLE IF NOT EXISTS "solitaire_analysis_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "game_kind" varchar(8) NOT NULL
    CHECK ("game_kind" IN ('duel', 'solo', 'daily')),
  "game_id" varchar(64) NOT NULL,
  "log_digest" varchar(64) NOT NULL,
  "engine_version" integer NOT NULL CHECK ("engine_version" > 0),
  "analysis" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- THE claim key. A unique index (not a plain one) is what makes
-- `onConflictDoUpdate({ target: [...] })` resolve against it and what makes a
-- duplicate analysis record impossible.
CREATE UNIQUE INDEX IF NOT EXISTS "solitaire_analysis_cache_identity_unique"
  ON "solitaire_analysis_cache" (
    "game_kind",
    "game_id",
    "log_digest",
    "engine_version"
  );

-- Retention's orphan lookup, and diagnostics for one game.
CREATE INDEX IF NOT EXISTS "solitaire_analysis_cache_game_idx"
  ON "solitaire_analysis_cache" ("game_kind", "game_id");

ALTER TABLE "solitaire_analysis_cache" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "solitaire_analysis_cache_no_client_access" ON "solitaire_analysis_cache";
CREATE POLICY "solitaire_analysis_cache_no_client_access" ON "solitaire_analysis_cache"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE "solitaire_analysis_cache" IS
  'One deterministic Game Review analysis per (game, canonical log digest, engine version); compact JSONB, no board snapshots or move history';
COMMENT ON COLUMN "solitaire_analysis_cache"."log_digest" IS
  'SHA-256 of the canonical ordered move log; part of the unique identity';
COMMENT ON COLUMN "solitaire_analysis_cache"."engine_version" IS
  'ANALYSIS_VERSION that produced analysis; a bump makes older rows unreachable';
COMMENT ON COLUMN "solitaire_analysis_cache"."analysis" IS
  'Compact GameAnalysis: ratings, tags, numeric scores and summary only — never the deal, the log or any prose';
