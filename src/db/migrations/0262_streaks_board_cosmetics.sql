-- 0262_streaks_board_cosmetics.sql
--
-- THE UTC DAILY STREAK AND THE BOARD COSMETIC UNLOCKS.
--
-- WHY A NEW TABLE
--   `users.daily_streak_*` is the LOGIN streak: it is keyed on the player's
--   LOCAL calendar day, it can be protected by a consumable shield, and the
--   daily login reward reads it. The streak this migration introduces is a
--   different product promise: one credit per UTC day for PLAYING (a Daily
--   Challenge or a ranked Solitaire Duel), no shields, no freezes, and unlocks
--   that are permanent. Mixing the two would make a login reward and a board
--   cosmetic disagree about the same number, so they are deliberately separate.
--
-- RULES (enforced in src/lib/streaks/server.ts, never here)
--   * the day key is the UTC calendar date — the same reset the deterministic
--     Daily Challenge uses;
--   * a second completion on the same UTC day is a no-op;
--   * yesterday's completion extends the streak, any longer gap resets it to 1;
--   * unlocks are permanent rows in `user_unlocks`;
--   * the PRO trial columns are the only way a trial is granted: the product
--     never creates a subscription for one.
--
-- Idempotent + additive: CREATE TABLE/COLUMN IF NOT EXISTS, no drops, no
-- rewrites. Safe to apply to the live schema by hand.

CREATE TABLE IF NOT EXISTS "user_streaks" (
  "user_id" integer PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "current_streak" integer NOT NULL DEFAULT 0,
  "longest_streak" integer NOT NULL DEFAULT 0,
  -- The UTC calendar day (YYYY-MM-DD) of the last credited completion.
  "last_completed_utc_date" date,
  "initial_pro_trial_claimed" boolean NOT NULL DEFAULT false,
  "pro_trial_expires_at" timestamptz,
  -- One pip per completed 30-day loop after Day 365.
  "prestige_pips" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "user_streaks_current_idx"
  ON "user_streaks" ("current_streak" DESC);

-- PERMANENT cosmetic ownership earned by the streak. Defaults are never rows
-- here: an always-owned item is decided by the catalog, not by a grant.
CREATE TABLE IF NOT EXISTS "user_unlocks" (
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "item_id" varchar(64) NOT NULL,
  "unlocked_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_unlocks_pk" PRIMARY KEY ("user_id", "item_id")
);

CREATE INDEX IF NOT EXISTS "user_unlocks_user_idx"
  ON "user_unlocks" ("user_id", "unlocked_at" DESC);

-- The equipped BOARD cosmetics. Title and frame reuse the existing systems
-- (`users.selected_title` / `users.equipped_cosmetics.profile_frame`), so there
-- is one authority per slot rather than a second copy of the same preference.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "equipped_felt" varchar(40) NOT NULL DEFAULT 'felt_default';
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "equipped_card_back" varchar(40) NOT NULL DEFAULT 'card_back_default';
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "equipped_deck_skin" varchar(40) NOT NULL DEFAULT 'deck_default';

-- RLS: default-deny. Only the Next.js server reads or writes these tables.
ALTER TABLE "user_streaks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_streaks_no_client_access" ON "user_streaks";
CREATE POLICY "user_streaks_no_client_access" ON "user_streaks"
  FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

ALTER TABLE "user_unlocks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_unlocks_no_client_access" ON "user_unlocks";
CREATE POLICY "user_unlocks_no_client_access" ON "user_unlocks"
  FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

COMMENT ON TABLE "user_streaks" IS
  'UTC daily play streak (Daily Challenge or ranked Solitaire Duel); separate from the local-time login streak on users';
COMMENT ON COLUMN "user_streaks"."last_completed_utc_date" IS
  'UTC calendar day of the last credited completion; the streak resets unless the next completion lands on the following UTC day';
COMMENT ON COLUMN "user_streaks"."pro_trial_expires_at" IS
  'Active while in the future: the account is treated as GRYND PRO. Only the streak milestones write it';
COMMENT ON TABLE "user_unlocks" IS
  'Permanent streak-earned cosmetic ownership; does not include always-owned defaults';
