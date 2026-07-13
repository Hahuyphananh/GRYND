-- src/db/migrations/0050_mines_pvp_odds_turns.sql
--
-- Adds the `picks` JSONB column on `mines_pvp_matches` (and a matching
-- column on `mines_pvp_rounds`) to support the new "odds turn" Mines
-- Duel flow.
--
-- ── What changes ─────────────────────────────────────────────────────
-- The previous flow ran a single round: P1 picked → P2 picked → match
-- resolved (both-safe = DRAW). The new flow keeps the match going
-- across many picks — both players alternate picks using the pattern
--   firstPlayer, secondPlayer, secondPlayer, firstPlayer, ...
-- (each consecutive pair of 2 turns, the lead player swaps). The match
-- ends the instant a player picks a mine; the picker of the mine loses
-- outright. There are no draws.
--
-- `picks` is a chronologically-ordered JSONB array of rich objects:
--
--     {
--       "userId":      "<clerk_id>",      -- who picked
--       "seat":        "player1"|"player2",
--       "cell":        <0..24>,           -- row-major cell index
--       "isMine":      boolean,           -- whether the cell was a mine
--       "autoPicked":  boolean,           -- true if AFK auto-pick fired
--       "pickedAt":    <ISO timestamp>    -- server stamp
--     }
--
-- ── Backwards compatibility ──────────────────────────────────────────
-- The legacy per-pick columns (`p1_pick`, `p2_pick`, `p1_pick_is_mine`,
-- `p2_pick_is_mine`, `p1_auto_picked`, `p2_auto_picked`, `p1_picked_at`,
-- `p2_picked_at`) are NOT dropped here. New game logic writes the
-- MOST RECENT pick from each player into those scalars for any
-- legacy replay/history view that still reads them; the source of
-- truth for in-flight match state is now `picks`. Keeping the legacy
-- columns in place avoids a destructive data migration on existing
-- finished matches.
--
-- ── Mining `mines_pvp_rounds` ────────────────────────────────────────
-- The rounds table mirrors the final picks array so post-match
-- replays can render the exact same state without a JSONB walk on
-- the match row. The legacy single-pick columns are still written
-- with the first pick of each seat for parity with the old schema
-- contract.
ALTER TABLE mines_pvp_matches
  ADD COLUMN IF NOT EXISTS picks jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE mines_pvp_rounds
  ADD COLUMN IF NOT EXISTS picks jsonb NOT NULL DEFAULT '[]'::jsonb;
