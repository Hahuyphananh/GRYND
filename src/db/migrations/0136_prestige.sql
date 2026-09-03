-- 0136: Permanent Prestige system layered on top of the permanent Battle Pass.
--
-- The Battle Pass is unchanged: Level 1 → 100 driven by XP, permanent, with
-- Level 100 as the hard cap (see src/lib/battlepass.js). Prestige is an
-- additional permanent progression layer for players who have reached Level
-- 100. It is NOT Battle Pass XP and NEVER raises the Battle Pass level, which
-- stays at 100 forever once reached.
--
-- Canonical state lives on `users` (like the all-time pvp_wins / games_won /
-- games_lost columns):
--   * prestige_level    — tiers earned. Monotonic: a loss can reduce the
--                         current tier's net-win progress but can never remove
--                         an already-earned tier.
--   * prestige_net_wins — current tier's net-win progress, clamped >= 0 and
--                         reset to 0 when the next tier's requirement is met.
--
-- `prestige_results` is the server-side idempotency journal. Every
-- authoritative match result that passes through the Prestige hook inserts a
-- row keyed by (user_id, source, source_id); a replayed, duplicate, or
-- concurrent settlement of the same match can never award progress twice.
-- Prestige values are ONLY ever written from server-side game settlement via
-- src/lib/prestige.js — no client input is accepted anywhere.
--
-- Existing users default to Prestige 0 with 0 net wins. Players already at
-- Level 100 (xp >= 63360, see src/lib/battlepass.js expToReachLevel(100))
-- become immediately eligible but receive NO automatic Prestige tiers.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "prestige_level" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "prestige_net_wins" INTEGER NOT NULL DEFAULT 0;

-- Non-negative guards (defense-in-depth — the application logic also clamps).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_prestige_level_nonneg'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_prestige_level_nonneg"
      CHECK ("prestige_level" >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_prestige_net_wins_nonneg'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_prestige_net_wins_nonneg"
      CHECK ("prestige_net_wins" >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "prestige_results" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "source" VARCHAR(64) NOT NULL,
  "source_id" VARCHAR(128) NOT NULL,
  "outcome" VARCHAR(8) NOT NULL,
  "delta" INTEGER NOT NULL DEFAULT 0,
  "prestige_level_after" INTEGER NOT NULL DEFAULT 0,
  "prestige_net_wins_after" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "prestige_results_unique_event" UNIQUE ("user_id", "source", "source_id")
);

CREATE INDEX IF NOT EXISTS "prestige_results_user_idx"
  ON "prestige_results" ("user_id", "created_at");
