-- 0174: Trophy event journal — idempotency + per-match trophy history.
--
-- Two rows per ranked match, one per player, uniquely keyed by
-- (user_id, game_key, match_id). That unique key is what makes a duplicate,
-- replayed, retried or concurrent settlement of the same match a guaranteed
-- no-op — and the same rows double as the match trophy history.
--
-- Inserted only from src/lib/trophyStore.js, inside the caller's settlement
-- transaction, so the journal commits atomically with the trophy update.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS "trophy_events" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "game_key" VARCHAR(64) NOT NULL,
  "match_id" VARCHAR(128) NOT NULL,
  "opponent_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "outcome" VARCHAR(8) NOT NULL,
  "trophies_before" INTEGER NOT NULL,
  "trophies_after" INTEGER NOT NULL,
  "delta" INTEGER NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "trophy_events_unique_event"
    UNIQUE ("user_id", "game_key", "match_id")
);

CREATE INDEX IF NOT EXISTS "trophy_events_user_idx"
  ON "trophy_events" ("user_id", "game_key", "created_at");

CREATE INDEX IF NOT EXISTS "trophy_events_match_idx"
  ON "trophy_events" ("match_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trophy_events_outcome_valid'
  ) THEN
    ALTER TABLE "trophy_events" ADD CONSTRAINT "trophy_events_outcome_valid"
      CHECK ("outcome" IN ('win', 'loss', 'draw'));
  END IF;
END $$;
