-- 0226_quest_match_events.sql
--
-- The DURABLE idempotency key for "this settled match counted for this player".
--
-- WHY A TABLE AND NOT A FLAG
--   Settlement for one match can be attempted more than once: a client retry,
--   a second terminal event racing the first, or the shared writers being called
--   again from a reconciled poll. An in-memory flag cannot survive a process
--   restart, cannot be shared by two server instances, and cannot be rolled back
--   with the match. A unique row can: the insert and the quest progress commit
--   in the SAME transaction as the terminal match write, so either both happen
--   or neither does, and `ON CONFLICT DO NOTHING` turns every replay into a
--   no-op.
--
-- SHAPE
--   * ("user_id", "game_key", "match_id") is the identity — one row per
--     PARTICIPANT per match. A 4-seat table therefore writes 4 rows; a 1v1
--     writes 2. `game_key` is part of the key because two games may reuse a
--     match id namespace.
--   * both user columns are FOREIGN KEYS to `users`. That is what makes the
--     "real authenticated human" rule structural: an AI seat, a bot seat or a
--     practice opponent has no `users` row, so it cannot be journaled (and
--     therefore cannot move a quest) at all. It is also the proof the opponent
--     was a participant account rather than a client claim.
--   * "outcome" is the server-decided result for that seat (win/loss/draw),
--     kept for auditability of the progress it produced.
--   * nothing here pays anything: rewards remain the claim path's job.
--
-- Additive and idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS "quest_match_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "game_key" VARCHAR(30) NOT NULL,
  "match_id" VARCHAR(128) NOT NULL,
  "opponent_user_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "outcome" VARCHAR(8) NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "quest_match_events_user_game_match_unique"
    UNIQUE ("user_id", "game_key", "match_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_quest_match_events_match"
  ON "quest_match_events" ("game_key", "match_id");
