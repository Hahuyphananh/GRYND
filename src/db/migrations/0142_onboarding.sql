-- 0142: First-time-user onboarding — server-side completion flag.
--
--   * New accounts start with NULL (onboarding incomplete) and are marked
--     permanently once they finish or skip the welcome flow.
--   * Existing accounts are backfilled as completed so nobody already using
--     Grynd is suddenly dropped into onboarding. The UPDATE below runs once
--     at migration time; any row created afterwards (a genuine new signup)
--     keeps NULL and sees the welcome flow.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamptz;
UPDATE "users" SET "onboarding_completed_at" = NOW() WHERE "onboarding_completed_at" IS NULL;
