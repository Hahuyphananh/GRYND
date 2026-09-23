-- Keno PvP — a life is lost only to your OWN miss.
--
-- Rule change to the 1v1 survival duel. Until now the race for the live
-- tile WAS the damage: `applyClaimToLives` took a life off whoever lost the
-- race to it, so a fast opponent bled you dry without you doing anything
-- wrong. Now:
--
--   * the tile stays lit for its WHOLE window and both players may tap it;
--   * you lose a life only if YOU did not tap it before the window closed;
--   * beating your opponent to it still credits you the tile (p1_tiles /
--     p2_tiles, which also drives the shrinking window and the
--     exhausted-board tiebreak) — it just costs them nothing;
--   * so both tapping = nobody loses a life, one tapping = only the silent
--     player does, neither tapping = both do.
--
-- That needs the server to know who tapped the tile CURRENTLY lit, which is
-- what these four columns carry. They are per-tile scratch state: reset to
-- false/NULL every time `lightNextTile` lights the next one. Reaction times
-- are stored per player (milliseconds from `live_started_at`) because both
-- players can now hold a reaction on the same tile; the single
-- `tile_log[].reactionMs` remains the credited claimant's.
--
-- Existing live matches are unaffected in substance: both flags default to
-- false, so the first tile after this migration resolves as a both-miss if
-- nobody taps — the same as it would have before.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS), so it can also be
-- pasted straight into the Supabase SQL editor.

ALTER TABLE "keno_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_claimed_live" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "p2_claimed_live" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "p1_claimed_ms" integer,
  ADD COLUMN IF NOT EXISTS "p2_claimed_ms" integer;

COMMENT ON COLUMN "keno_pvp_matches"."p1_claimed_live" IS
  'Player 1 tapped the CURRENT live tile in time (reset per tile; a false at resolution = a miss = one life)';

COMMENT ON COLUMN "keno_pvp_matches"."p2_claimed_live" IS
  'Player 2 tapped the CURRENT live tile in time (reset per tile; a false at resolution = a miss = one life)';

COMMENT ON COLUMN "keno_pvp_matches"."p1_claimed_ms" IS
  'Player 1 tap reaction on the current tile, ms from live_started_at (NULL = has not tapped)';

COMMENT ON COLUMN "keno_pvp_matches"."p2_claimed_ms" IS
  'Player 2 tap reaction on the current tile, ms from live_started_at (NULL = has not tapped)';

COMMENT ON COLUMN "keno_pvp_matches"."tile_log" IS
  'Public per-tile history: [{tile,index,outcome,at,p1Lives,p2Lives,windowMs,reactionMs,p1Claimed,p2Claimed,p1ReactionMs,p2ReactionMs}, ...]';
