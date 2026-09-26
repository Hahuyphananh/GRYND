-- 0173: Per-game trophies.
--
-- One independent trophy count per (player, game), sitting alongside — never
-- replacing — the per-game Elo rating. Chess and Precision are separate rows
-- and are never combined.
--
--   * `player_trophies` — canonical current trophy count per (user, game). The
--                         row is created LAZILY on the player's first eligible
--                         ranked match in that game (so an unplayed game reads
--                         as "no trophies yet"), and its first value is
--                         TROPHY_START = 0.
--
-- THE RULE (src/lib/trophies.js): ranked win = +30, ranked loss = −30, draw = 0,
-- clamped to [0, 10000]. Reaching 10,000 completes trophy progression for that
-- game; Elo then becomes the primary signal (Prestige = max(0, elo − 1000),
-- derived on read, never stored).
--
-- Written ONLY from server-side game settlement (applyTrophyResult, inside the
-- caller's row-locked transaction). No client input ever reaches a trophy
-- count, a delta or an outcome.
--
-- Trophies are independent of the token economy: nothing here is derived from
-- balance, winnings, XP, Battle Pass, Prestige, streaks or cosmetics.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS "player_trophies" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "game_key" VARCHAR(64) NOT NULL,
  "trophies" INTEGER NOT NULL DEFAULT 0,
  "peak_trophies" INTEGER NOT NULL DEFAULT 0,
  "games_rated" INTEGER NOT NULL DEFAULT 0,
  "wins" INTEGER NOT NULL DEFAULT 0,
  "losses" INTEGER NOT NULL DEFAULT 0,
  "draws" INTEGER NOT NULL DEFAULT 0,
  "last_delta" INTEGER NOT NULL DEFAULT 0,
  "last_trophy_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "player_trophies_user_game_unique" UNIQUE ("user_id", "game_key")
);

-- Board ordering: highest trophy count first within one game.
CREATE INDEX IF NOT EXISTS "player_trophies_game_trophies_idx"
  ON "player_trophies" ("game_key", "trophies" DESC);

CREATE INDEX IF NOT EXISTS "player_trophies_user_idx"
  ON "player_trophies" ("user_id");

-- Defense-in-depth guards. The application clamps trophies (see clampTrophies in
-- src/lib/trophies.js) and never writes a negative count, but the database
-- should refuse one anyway.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'player_trophies_band'
  ) THEN
    ALTER TABLE "player_trophies" ADD CONSTRAINT "player_trophies_band"
      CHECK ("trophies" >= 0 AND "trophies" <= 10000
             AND "peak_trophies" >= 0 AND "peak_trophies" <= 10000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'player_trophies_counts_nonneg'
  ) THEN
    ALTER TABLE "player_trophies" ADD CONSTRAINT "player_trophies_counts_nonneg"
      CHECK ("games_rated" >= 0 AND "wins" >= 0 AND "losses" >= 0 AND "draws" >= 0);
  END IF;
END $$;
