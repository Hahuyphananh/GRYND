-- 0170: Per-game Elo ratings.
--
-- One independent Elo rating per (player, game). Chess and Precision are
-- separate rows and are never combined — there is deliberately no "overall"
-- rating. The calculation itself lives in src/lib/elo.js (pure math) and the
-- server-authoritative writer in src/lib/rating.js.
--
--   * `player_ratings`  — canonical current rating per (user, game). The row
--                         is created LAZILY on the player's first eligible
--                         ranked match in that game (so an unplayed game reads
--                         as "Unrated"), and its first value is
--                         STARTING_RATING = 1000.
--   * `rating_events`   — the idempotency journal AND the per-match rating
--                         history. Two rows per rated match, one per player,
--                         uniquely keyed by (user_id, game_key, match_id), so a
--                         duplicate / replayed / concurrent settlement of the
--                         same match can never move a rating twice.
--
-- Both tables are written ONLY from server-side game settlement
-- (applyRatingResult, inside the caller's row-locked transaction). No client
-- input ever reaches a rating, a delta or an outcome.
--
-- Ratings are independent of the token economy: nothing here is derived from
-- balance, winnings, XP, Battle Pass, Prestige, streaks or cosmetics.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS "player_ratings" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "game_key" VARCHAR(64) NOT NULL,
  "rating" INTEGER NOT NULL DEFAULT 1000,
  "peak_rating" INTEGER NOT NULL DEFAULT 1000,
  "games_rated" INTEGER NOT NULL DEFAULT 0,
  "wins" INTEGER NOT NULL DEFAULT 0,
  "losses" INTEGER NOT NULL DEFAULT 0,
  "draws" INTEGER NOT NULL DEFAULT 0,
  "last_delta" INTEGER NOT NULL DEFAULT 0,
  "last_rated_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "player_ratings_user_game_unique" UNIQUE ("user_id", "game_key")
);

-- Board ordering: highest rating first within one game.
CREATE INDEX IF NOT EXISTS "player_ratings_game_rating_idx"
  ON "player_ratings" ("game_key", "rating" DESC);

CREATE INDEX IF NOT EXISTS "player_ratings_user_idx"
  ON "player_ratings" ("user_id");

CREATE TABLE IF NOT EXISTS "rating_events" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "game_key" VARCHAR(64) NOT NULL,
  "match_id" VARCHAR(128) NOT NULL,
  "opponent_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "outcome" VARCHAR(8) NOT NULL,
  "rating_before" INTEGER NOT NULL,
  "rating_after" INTEGER NOT NULL,
  "delta" INTEGER NOT NULL,
  "k_factor" INTEGER NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "rating_events_unique_event"
    UNIQUE ("user_id", "game_key", "match_id")
);

CREATE INDEX IF NOT EXISTS "rating_events_user_idx"
  ON "rating_events" ("user_id", "game_key", "created_at");

CREATE INDEX IF NOT EXISTS "rating_events_match_idx"
  ON "rating_events" ("match_id");

-- Defense-in-depth guards. The application clamps ratings (see clampRating in
-- src/lib/elo.js) and never writes a negative count, but the database should
-- refuse one anyway.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'player_ratings_rating_floor'
  ) THEN
    ALTER TABLE "player_ratings" ADD CONSTRAINT "player_ratings_rating_floor"
      CHECK ("rating" >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'player_ratings_counts_nonneg'
  ) THEN
    ALTER TABLE "player_ratings" ADD CONSTRAINT "player_ratings_counts_nonneg"
      CHECK ("games_rated" >= 0 AND "wins" >= 0 AND "losses" >= 0 AND "draws" >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rating_events_outcome_valid'
  ) THEN
    ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_outcome_valid"
      CHECK ("outcome" IN ('win', 'loss', 'draw'));
  END IF;
END $$;
