-- Crash Arena — per-seat display names for AI bots.
--
--   crash_arena_players.nickname — optional per-seat display-name override,
--   used by the host to rename their AI bots (e.g. "GRYND AI" → "Rocket").
--   NULL on human seats and unnamed bots, whose names come from the users
--   table as before. The users row itself is shared across tables, so the
--   custom name lives on the SEAT, never on the shared bot user.

ALTER TABLE "crash_arena_players"
  ADD COLUMN IF NOT EXISTS "nickname" varchar(40);
