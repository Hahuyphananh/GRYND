-- 0176: Reset Battle Pass progress to level 1 (the XP track is retired).
--
-- The Battle Pass level is now DERIVED from trophies: 10,000 total trophies =
-- level 100 (see getLevelFromTrophies in src/lib/battlepass.js). The stored
-- XP/level columns no longer drive progression, so every player is reset to
-- level 1 / 0 XP.
--
-- REWARDS ARE PRESERVED. This migration deliberately does NOT touch:
--   * battlepass_claims   — every claimed reward stays claimed,
--   * user_emotes / user_special_titles / user_glows / user_cosmetics — every
--     granted cosmetic stays owned and equipped.
-- Nothing a player already earned is revoked; only the progression counter is
-- reset. Since the new level is derived from trophies (everyone starts at 0),
-- the reset is also what makes the stored column agree with the derived value.
--
-- Idempotent: safe to run repeatedly (the WHERE makes a second run a no-op).

UPDATE "users"
   SET "xp" = 0,
       "level" = 1
 WHERE "xp" <> 0 OR "level" <> 1;

UPDATE "user_stats"
   SET "xp" = 0,
       "level" = 1
 WHERE "xp" <> 0 OR "level" <> 1;
