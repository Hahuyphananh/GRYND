-- ── Game Evaluation results — LLM post-match analysis journal ───────
-- Foundational table for the Game Evaluation feature: one row per
-- evaluation request for a finished match. No game logic and no UI is
-- wired up yet — this only creates the storage the feature needs.
--
-- WHY each column:
--   * `user_id`  — Clerk id of the evaluated player, stored as a plain
--     string with no FK to `users`, matching every other PvP table (a
--     row must survive whatever the game tables do with their ids).
--   * `game_key` — canonical game key, e.g. "chess", same vocabulary as
--     `match_lifecycle.game_key` / `player_ratings.game_key`.
--   * `match_id` — the game's OWN match/game id. This is POLYMORPHIC
--     (chess_games.id is a uuid, mines_pvp_matches.id is a serial), so a
--     foreign key cannot be expressed and is deliberately absent.
--   * `tier`     — membership tier the request was made under:
--     'free' | 'pro'.
--   * `objective_data` — the game-specific stats computed server-side.
--     This is the ONLY input the model is allowed to reason over, so it
--     is NOT NULL: an evaluation with no objective stats is meaningless.
--   * `ai_response` — structured LLM output, NULL until the provider
--     call lands (and stays NULL if it fails).
--   * `status`   — 'pending' | 'complete' | 'failed'. The row is written
--     as 'pending' first, then updated, so a request stays traceable
--     even when the provider call dies.
--
-- Values for `tier` / `status` are intentionally left unconstrained
-- (no CHECK / enum): they mirror plain `varchar` columns in
-- src/db/schema.ts, so the schema and the database stay in sync.
--
-- Access paths:
--   * (user_id, created_at) — the daily-limit check counts one user's
--     evaluations inside a rolling window.
--   * (game_key, match_id)  — fetching the evaluation(s) for a match.
--
-- IF NOT EXISTS everywhere, so this migration is safe to re-run.

CREATE TABLE IF NOT EXISTS "evaluation_results" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" varchar(255) NOT NULL,
    "game_key" varchar(80) NOT NULL,
    "match_id" varchar(255) NOT NULL,
    "tier" varchar(20) NOT NULL,
    "objective_data" jsonb NOT NULL,
    "ai_response" jsonb,
    "status" varchar(20) NOT NULL DEFAULT 'pending',
    "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "evaluation_results_user_created_idx"
  ON "evaluation_results" ("user_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "evaluation_results_game_match_idx"
  ON "evaluation_results" ("game_key", "match_id");
