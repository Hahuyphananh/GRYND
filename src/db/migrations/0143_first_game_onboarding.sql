-- 0143: Onboarding first free match — completion flag + one-time XP gate.
--
--   * New accounts start with NULL and are marked only when they finish the
--     onboarding Free Play vs AI match at a REAL terminal game state (never
--     merely for opening the game). Written exclusively by
--     POST /api/onboarding/first-game-complete, which also grants the
--     one-time FIRST_GAME_BONUS_XP (src/lib/battlepass.js) on first claim.
--   * Existing accounts are backfilled as completed so nobody already using
--     Grynd can trigger the tutorial match or its bonus. The UPDATE below
--     runs once at migration time; genuine new signups keep NULL.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_game_completed_at" timestamptz;
UPDATE "users" SET "first_game_completed_at" = NOW() WHERE "first_game_completed_at" IS NULL;
