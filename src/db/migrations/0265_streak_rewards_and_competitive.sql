-- 0265: streak rewards become real, competitive win streaks get a home, and
-- the UTC daily streak is backfilled conservatively.
--
-- WHY
-- ---
-- The daily play streak already writes permanent `user_unlocks` rows, but its
-- profile rewards (badges / frame / Centurion title) had no catalog to resolve:
-- they could never be equipped. The account-creation cosmetic grant also hands
-- every enabled non-PRO row to every new player, so a streak reward added to the
-- catalog without a flag would be owned by everyone immediately.
--
-- WHAT
-- ----
--   * `cosmetics.streak_only` + `unlock_streak_day`: earned entries that the
--     grant-all path skips and the equip path validates against `user_unlocks`.
--   * Four streak rows (two badges, the 365-day frame, the 365+ badge) and the
--     Centurion special title.
--   * `competitive_result_events` / `user_competitive_streaks`: per-match
--     journal + per-game win streak, written inside ranked settlement.
--   * A conservative `user_streaks` backfill from the legacy local streak.
--
-- BACKFILL RULE: counts are seeded, the UTC date is NOT. The source columns
-- are the LOCAL LOGIN counters on `users`, not UTC play evidence; they are
-- preserved as historical counts only. Copying `last_login_date` into a UTC
-- column would let the next completion extend a streak the UTC rules never
-- credited, so the date stays null and the first UTC completion resets
-- `current_streak` to 1 (the legacy `longest_streak` is kept). No `user_unlocks`
-- row is granted retroactively: rewards are earned from the day this ships,
-- which is a product decision left deliberately un-automated.
--
-- DEPLOY ORDER: this migration must be applied BEFORE the code that reads the
-- new columns/tables. Old code does not know `streak_only`, so a user created or
-- re-synced between the two steps can receive a streak cosmetic/title for free;
-- see the Phase 7 deployment procedure for the maintenance/cleanup steps.
--
-- Idempotent and additive: IF NOT EXISTS / ON CONFLICT everywhere.

ALTER TABLE "cosmetics"
  ADD COLUMN IF NOT EXISTS "streak_only" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "cosmetics"
  ADD COLUMN IF NOT EXISTS "unlock_streak_day" INTEGER;

INSERT INTO "cosmetics"
  ("key", "name", "description", "category", "rarity", "visual",
   "price_tokens", "unlock_condition", "enabled", "sort_order",
   "pro_only", "streak_only", "unlock_streak_day")
VALUES
  (
    'badge_flame_14',
    'Amber Flame Badge',
    'Earned by finishing a game on 14 consecutive days.',
    'badge',
    'Streak',
    '{"color":"#f59e0b"}'::jsonb,
    NULL, NULL, TRUE, 700, FALSE, TRUE, 14
  ),
  (
    'badge_flame_blue',
    'Electric Flame Badge',
    'Earned by finishing a game on 180 consecutive days.',
    'badge',
    'Streak',
    '{"color":"#38bdf8"}'::jsonb,
    NULL, NULL, TRUE, 701, FALSE, TRUE, 180
  ),
  (
    'badge_365_plus',
    '[ 365+ ]',
    'A full year of daily completions — and every 30 days after it.',
    'badge',
    'Legendary',
    '{"color":"#c9a24a"}'::jsonb,
    NULL, NULL, TRUE, 702, FALSE, TRUE, 365
  ),
  (
    'frame_eternal',
    'Eternal Frame',
    'The profile frame for a 365-day streak.',
    'profile_frame',
    'Legendary',
    '{"cssClass":"frame-eternal"}'::jsonb,
    NULL, NULL, TRUE, 902, FALSE, TRUE, 365
  )
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "rarity" = EXCLUDED."rarity",
  "visual" = EXCLUDED."visual",
  "price_tokens" = NULL,
  "unlock_condition" = NULL,
  "enabled" = TRUE,
  "streak_only" = TRUE,
  "unlock_streak_day" = EXCLUDED."unlock_streak_day";

INSERT INTO "special_titles" ("key", "name", "description", "rarity")
VALUES (
  'title_centurion',
  'CENTURION',
  'A 100-day daily streak.',
  'Streak'
)
ON CONFLICT ("key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "competitive_result_events" (
  "id" serial PRIMARY KEY,
  "match_id" varchar(255) NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "game_key" varchar(80) NOT NULL,
  "outcome" varchar(10) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "competitive_result_events_unique"
    UNIQUE ("match_id", "user_id", "game_key")
);

CREATE INDEX IF NOT EXISTS "competitive_result_events_user_idx"
  ON "competitive_result_events" ("user_id", "game_key");

CREATE TABLE IF NOT EXISTS "user_competitive_streaks" (
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "game_key" varchar(80) NOT NULL,
  "current_streak" integer NOT NULL DEFAULT 0,
  "best_streak" integer NOT NULL DEFAULT 0,
  "last_match_id" varchar(255),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "game_key")
);

ALTER TABLE "competitive_result_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "competitive_result_events_no_client_access"
  ON "competitive_result_events";
CREATE POLICY "competitive_result_events_no_client_access"
  ON "competitive_result_events" FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

ALTER TABLE "user_competitive_streaks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_competitive_streaks_no_client_access"
  ON "user_competitive_streaks";
CREATE POLICY "user_competitive_streaks_no_client_access"
  ON "user_competitive_streaks" FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

-- Conservative backfill: login counts only, no UTC date, no retroactive
-- unlocks. Re-running is a no-op: existing (post-deploy) streak rows win.
INSERT INTO "user_streaks" ("user_id", "current_streak", "longest_streak")
SELECT "id", "daily_streak_current", "daily_streak_best"
  FROM "users"
 WHERE "daily_streak_current" > 0 OR "daily_streak_best" > 0
ON CONFLICT ("user_id") DO NOTHING;
