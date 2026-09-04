-- 0141: Settings — user-level MFA flag, email notification prefs, per-game default wagers.
-- All additive; existing rows keep current behavior (MFA off, prefs on, no saved wagers).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notification_prefs" jsonb NOT NULL DEFAULT '{"promotions":true,"daily":true,"summary":true,"progress":true}'::jsonb;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "default_wagers" jsonb NOT NULL DEFAULT '{}'::jsonb;