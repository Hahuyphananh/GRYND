-- 0159: per-game ACTIVE PLAYER presence (the casino lobby's "N playing").
--
-- WHY THIS TABLE AND NOT A NEW ONE
--   user_game_presence already exists (0012_friends_presence_profile_picture),
--   has the right columns and the right unique key, and — verified by a
--   repo-wide search — is written and read by NO code at all. It was built for
--   exactly this feature and then never wired up. Extending it is the "reuse
--   the existing system" path; a second presence table would be a parallel
--   system, which is exactly what we must avoid.
--
--   The three presence tables from 0012 stay separate on purpose:
--     user_presence          one row per user  → online / friends feed
--     user_game_presence     one row per user PER GAME → THIS feature
--     spectator_presence     one row per spectator per target match
--
-- WHY NOT user_presence (where useGamePresence already writes)
--   Its app-wide heartbeat (src/components/PresenceHeartbeat.tsx →
--   /api/presence/heartbeat) refreshes last_seen for EVERY signed-in tab and
--   deliberately preserves status = 'in_game'. A player who closes a game while
--   another GRYND tab stays open would therefore be counted as playing forever,
--   and current_game_id is a "key:id" string that cannot be grouped per game
--   with an index. user_game_presence is written ONLY by the game's own
--   heartbeat, so staleness here means exactly what we want it to mean.
--
-- KEY SPACE
--   game_key holds the CANONICAL game id (the lobby's leaderboardKey, e.g.
--   "mines-pvp", "rps", "crash" — the same ids src/lib/gameTags.js exports and
--   /casino/classement uses). Game pages report their own gameLabel
--   ("mines-duel", "rock-paper-scissors", "crash-arena"); the label → id map
--   lives in ONE place (src/lib/gamePresence.js) and the API resolves it
--   server-side, so an unknown label can never create a row.
--
-- EXPIRATION
--   There is no "leave" requirement: a row counts as active only while
--   last_seen_at is inside the activity window (3 minutes, see
--   ACTIVE_PLAYER_WINDOW_SECONDS in src/lib/gamePresence.js). A closed tab or a
--   crashed browser simply ages out. The optional leave endpoint only makes the
--   drop-off instant.
--
-- IDEMPOTENT ON PURPOSE
--   The repo's migration journal has drift (several SQL files were never
--   journaled), so this file re-asserts its own table/columns/indexes with
--   IF NOT EXISTS. It is safe whether 0012 ran, was skipped, or was applied by a
--   drizzle push.

CREATE TABLE IF NOT EXISTS user_game_presence (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_key VARCHAR(80) NOT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT user_game_presence_user_game_unique UNIQUE (user_id, game_key)
);

-- Columns 0012 added / this feature needs. TIMESTAMP (no tz) matches the rest
-- of the 0012 presence family; every query compares against NOW() just like
-- the existing user_presence / spectator_presence reads do.
ALTER TABLE user_game_presence
  ADD COLUMN IF NOT EXISTS game_id INTEGER;

-- The client's session/tab id. NOT part of the unique key: a user must never
-- count twice for the same game just because they have two tabs or two
-- devices open. It exists so a leaving tab only clears ITS OWN row instead of
-- wiping a still-open second tab's presence.
ALTER TABLE user_game_presence
  ADD COLUMN IF NOT EXISTS session_id VARCHAR(128);

ALTER TABLE user_game_presence
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();

ALTER TABLE user_game_presence
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

-- The aggregate is "count active rows per game": (game_key, last_seen_at) is
-- the exact access path, and the window predicate keeps the scan tiny (rows
-- are at most users × games).
CREATE INDEX IF NOT EXISTS user_game_presence_game_idx
  ON user_game_presence (game_key, last_seen_at DESC);

-- One active row per (user, game) — this is what makes the heartbeat
-- idempotent and the count free of multi-tab duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS user_game_presence_user_game_unique
  ON user_game_presence (user_id, game_key);
