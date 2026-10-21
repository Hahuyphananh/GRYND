-- 0225_quests.sql
--
-- Daily & weekly quests, take two.
--
-- 0132_user_quests.sql is NOT journaled (it is pinned in
-- tests/migration-journal-guard.test.mjs), so `npm run db:migrate` never ran it.
-- It was also absent from src/db/schema.ts for the whole stalled stretch, so
-- nothing has queried it in a long time. This migration therefore has to be
-- correct in BOTH worlds and must not assume the table is missing:
--
--   * fresh database   → the CREATE builds the table, including the completion
--                        stamp the design needs,
--   * legacy database  → the CREATE is a no-op and the ALTER adds only the one
--                        column the 0132 shape did not have.
--
-- Shape notes:
--   * ("user_id", "period_type", "period_key", "slot") is the deterministic
--     identity. The slot and its quest come from
--     planQuests(periodType, periodKey) in src/lib/quests/definitions.ts, so a
--     retried or concurrent generation re-derives the SAME slots; the unique
--     constraint plus ON CONFLICT DO NOTHING in src/lib/quests/store.ts makes a
--     duplicate slot impossible.
--   * "target"/"progress" stay NUMERIC(14,2) — the type 0132 declared — so a
--     legacy table needs no column conversion. Quest progress is whole numbers.
--   * "reward" is virtual coins only: no cash-out, no gift cards, no purchased
--     progress.
--   * "meta" carries { definitionId, games }; "games" is the set of CANONICAL
--     game ids already counted for a "different games" quest.
--   * "completed_at" freezes completion, so a later definition change can never
--     un-complete a quest the player already finished.
--
-- Additive and idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS "user_quests" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "period_type" VARCHAR(10) NOT NULL,
  "period_key" VARCHAR(12) NOT NULL,
  "slot" INTEGER NOT NULL,
  "quest_type" VARCHAR(20) NOT NULL,
  "game_key" VARCHAR(30),
  "target" NUMERIC(14,2) NOT NULL,
  "reward" INTEGER NOT NULL,
  "progress" NUMERIC(14,2) NOT NULL DEFAULT 0,
  "claimed" BOOLEAN NOT NULL DEFAULT FALSE,
  "meta" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "completed_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_quests_user_period_slot_unique"
    UNIQUE ("user_id", "period_type", "period_key", "slot")
);
--> statement-breakpoint

-- Legacy 0132 table: PG already enforced the same slot uniqueness under its
-- generated name, so only the completion stamp has to be added.
ALTER TABLE "user_quests" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_user_quests_user_period"
  ON "user_quests" ("user_id", "period_type", "period_key");
