-- 0246_solitaire_onboarding_progress.sql
--
-- ADDITIVE ONLY. Onboarding progress for the Solitaire-first flow.
--
-- Why a migration is needed at all: the existing columns can express
-- "onboarding finished" (onboarding_completed_at) and "questionnaire answered"
-- (questionnaire_completed_at), but not the two states the Solitaire tutorial
-- must keep distinct: a tutorial the player FINISHED vs one they SKIPPED. They
-- must never collapse into the same value, and a skip must not count as a
-- completion.
--
-- Every column is nullable with no default and no backfill, so:
--   * existing accounts keep NULL (never re-onboarded, never re-prompted),
--   * no existing row is rewritten, deleted or reinterpreted,
--   * every write is guarded with IS NULL, so a later event can never
--     overwrite the first one (started stays started, skipped stays skipped).
--
-- Rollback is a plain DROP COLUMN of these four columns; no other table or
-- column is touched.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_started_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tutorial_started_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tutorial_completed_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tutorial_skipped_at" timestamp;
