-- Migration 0259 — Friend Challenge links for Solitaire Duel.
--
-- A friend challenge is an ORDINARY waiting match with one extra fact: it is
-- addressable by a short code instead of only by the public queue. The second
-- seat is taken by whoever opens /duel/<code>, so two people can race the same
-- deterministic deal without either of them sitting in the public matchmaker.
--
-- Why a column on the existing table rather than a new one:
--
--   * the deal, the two boards, the GO clock, settlement, ratings and the match
--     page are all already correct for a waiting match;
--   * a separate table would need every one of those paths duplicated, and the
--     first thing to drift would be "both players get the same deal";
--   * a private lobby is therefore structurally indistinguishable from a public
--     one except for these two columns, and every queue query filters
--     `invite_code IS NULL`, so the public matchmaker can never hand out a
--     private table (or a private table's deal) to a stranger.
--
-- NULL on public lobbies, AI practice matches, ghost duels and every match that
-- has started; the code is only meaningful while the row is `waiting`.
--
-- The expiry is what keeps a link from becoming a permanent unlisted door: a
-- code past `invite_expires_at` seats nobody, and the row is then just an
-- abandoned lobby the retention sweep already knows how to clean up.

ALTER TABLE solitaire_duel_matches
  -- The shareable code (upper case, unambiguous alphabet, 8 chars).
  ADD COLUMN IF NOT EXISTS invite_code VARCHAR(12),
  -- When the link stops seating a second player.
  ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMP;--> statement-breakpoint

-- One live lobby per code. Partial, because the column is NULL on every public
-- match and Postgres would otherwise treat those NULLs as distinct rows anyway
-- (harmless, but the partial index keeps the index small and the intent clear).
CREATE UNIQUE INDEX IF NOT EXISTS solitaire_duel_matches_invite_code_idx
  ON solitaire_duel_matches(invite_code)
  WHERE invite_code IS NOT NULL;--> statement-breakpoint

-- The join path looks the lobby up by code and status, and never by id alone.
CREATE INDEX IF NOT EXISTS solitaire_duel_matches_invite_open_idx
  ON solitaire_duel_matches(invite_code, invite_expires_at)
  WHERE invite_code IS NOT NULL AND status = 'waiting';
