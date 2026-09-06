-- 0148: Make the never-granted battlepass rewards claimable.
--
-- The 100-level track always displayed title / XP-boost / quest-boost /
-- streak-shield rewards, but the claim route only ever granted banner +
-- emote. This migration adds the two pieces the other types need:
--
--   1. The 12 battlepass-exclusive titles go into the existing
--      special_titles catalog (the same table the secret/achievement
--      titles use), so claiming one writes a user_special_titles row and
--      it shows up in the profile title picker like any other special
--      title.
--   2. battlepass_claims — a per-level claim journal for the functional
--      rewards (xp_boost / quest_boost / shield). Banner/emote/title
--      ownership already lives in their own tables; the functional
--      rewards have no other place to record "claimed at level N", and
--      since the track has multiple identical items at different levels
--      (ten streak shields), a per-level row is what keeps each one
--      claimable exactly once.
--
-- Grandfathering note: none of these rewards were grantable before this
-- migration, so there is nothing to grandfather. Every claim going
-- forward is recorded here (or in user_special_titles).

CREATE TABLE IF NOT EXISTS "battlepass_claims" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "level" integer NOT NULL,
  "reward_type" varchar(32) NOT NULL,
  "reward_key" varchar(64),
  "claimed_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "battlepass_claims_user_level_type_unique" UNIQUE ("user_id", "level", "reward_type")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "battlepass_claims_user_idx" ON "battlepass_claims" ("user_id");
--> statement-breakpoint
INSERT INTO special_titles (key, name, description, rarity) VALUES
  ('bp_pass_starter',       'Pass Starter',          'Battlepass-exclusive title', 'Common'),
  ('bp_token_shuffler',     'Token Shuffler',        'Battlepass-exclusive title', 'Common'),
  ('bp_quest_completist',   'Quest Completist',      'Battlepass-exclusive title', 'Common'),
  ('bp_wager_warrior',      'Wager Warrior',         'Battlepass-exclusive title', 'Bronze'),
  ('bp_streak_sentinel',    'Streak Sentinel',       'Battlepass-exclusive title', 'Bronze'),
  ('bp_pass_raider',        'Pass Raider',           'Battlepass-exclusive title', 'Silver'),
  ('bp_glow_bearer',        'Glow Bearer',           'Battlepass-exclusive title', 'Silver'),
  ('bp_lucky_gambit',       'Lucky Gambit',          'Battlepass-exclusive title', 'Gold'),
  ('bp_battlepass_titan',   'Battlepass Titan',      'Battlepass-exclusive title', 'Gold'),
  ('bp_high_roller_legend', 'High Roller Legend',    'Battlepass-exclusive title', 'Elite'),
  ('bp_aurora_master',      'Aurora Master',         'Battlepass-exclusive title', 'Mythic'),
  ('bp_grynd_pass_legend',  'GRYND PASS LEGEND',     'The ultimate battlepass title', 'Overlord')
ON CONFLICT (key) DO NOTHING;