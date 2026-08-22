-- Rebrand: migrate title display data from the old GoonBet identity to GRYND.
--
-- No schema changes — only seeded/display values are updated so existing
-- players see the new branding without needing to re-unlock anything.
-- Every statement is a no-op when the old value isn't present, so this is
-- safe to run against any database (fresh installs already carry the new
-- values via the updated 0017 seed).

-- ── Special titles: rename keys + display names/descriptions ──────────────
UPDATE special_titles SET key = 'chatterbox' WHERE key = 'talkative_goon';
UPDATE special_titles SET name = 'Chatterbox' WHERE key = 'chatterbox';

UPDATE special_titles SET key = 'loyal_grinder' WHERE key = 'loyal_goon';
UPDATE special_titles
  SET name = 'Loyal Grinder', description = 'Type "grynd" 10 times in chat.'
  WHERE key = 'loyal_grinder';

UPDATE special_titles SET key = 'resident_grinder' WHERE key = 'resident_goon';
UPDATE special_titles SET name = 'Resident Grinder' WHERE key = 'resident_grinder';

UPDATE special_titles SET key = 'grynd_ascended' WHERE key = 'goon_ascended';
UPDATE special_titles SET name = 'GRYND ASCENDED' WHERE key = 'grynd_ascended';

-- ── Users' unlocked + equipped special titles ─────────────────────────────
UPDATE user_special_titles SET title_key = 'chatterbox' WHERE title_key = 'talkative_goon';
UPDATE user_special_titles SET title_key = 'loyal_grinder' WHERE title_key = 'loyal_goon';
UPDATE user_special_titles SET title_key = 'resident_grinder' WHERE title_key = 'resident_goon';
UPDATE user_special_titles SET title_key = 'grynd_ascended' WHERE title_key = 'goon_ascended';

UPDATE users SET selected_special_title = 'chatterbox' WHERE selected_special_title = 'talkative_goon';
UPDATE users SET selected_special_title = 'loyal_grinder' WHERE selected_special_title = 'loyal_goon';
UPDATE users SET selected_special_title = 'resident_grinder' WHERE selected_special_title = 'resident_goon';
UPDATE users SET selected_special_title = 'grynd_ascended' WHERE selected_special_title = 'goon_ascended';

-- ── Milestone titles (selected/highest are stored as display names) ───────
UPDATE users SET selected_title = 'Fresh Contender' WHERE selected_title = 'Newbie Goon';
UPDATE users SET selected_title = 'Bronze Contender' WHERE selected_title = 'Bronze Goon';
UPDATE users SET selected_title = 'Silver Contender' WHERE selected_title = 'Silver Goon';
UPDATE users SET selected_title = 'Gold Contender' WHERE selected_title = 'Gold Goon';
UPDATE users SET selected_title = 'Diamond Contender' WHERE selected_title = 'Diamond Goon';
UPDATE users SET selected_title = 'Mythic Contender' WHERE selected_title = 'Mythic Goon';
UPDATE users SET selected_title = 'GRYND Emperor' WHERE selected_title = 'Goon Emperor';
UPDATE users SET selected_title = 'GRYND OVERLORD' WHERE selected_title = 'GOONBET OVERLORD';

UPDATE users SET highest_title = 'Fresh Contender' WHERE highest_title = 'Newbie Goon';
UPDATE users SET highest_title = 'Bronze Contender' WHERE highest_title = 'Bronze Goon';
UPDATE users SET highest_title = 'Silver Contender' WHERE highest_title = 'Silver Goon';
UPDATE users SET highest_title = 'Gold Contender' WHERE highest_title = 'Gold Goon';
UPDATE users SET highest_title = 'Diamond Contender' WHERE highest_title = 'Diamond Goon';
UPDATE users SET highest_title = 'Mythic Contender' WHERE highest_title = 'Mythic Goon';
UPDATE users SET highest_title = 'GRYND Emperor' WHERE highest_title = 'Goon Emperor';
UPDATE users SET highest_title = 'GRYND OVERLORD' WHERE highest_title = 'GOONBET OVERLORD';
