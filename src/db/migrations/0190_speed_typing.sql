-- Migration 0190 — Speed Typing PvP match infrastructure.
--
-- Server-authoritative 1v1 typing race: both seats receive the EXACT same text
-- and the first to correctly complete it wins. NO wagers, NO tokens, NO
-- balances, NO payouts — so unlike the staked PvP tables there is deliberately
-- no stake_amount / prize_paid / house_fee column, and no money is ever moved
-- by settlement.
--
-- Matchmaking follows the Mini Golf pattern (0179) rather than Pool Masters'
-- lobby+match pair (0022): a single `speed_typing_matches` row with a nullable
-- `player2_id` and status 'waiting' IS the open lobby, so create-or-join
-- matches two players under the per-game advisory lock
-- (SPEED_TYPING_LOCK_NAMESPACE) with no second table to keep in sync. Because
-- the game is unstaked there is also no per-wager queue bucket to race on.
--
-- HOUSE COLUMNS ONLY. This migration lands the match's IDENTITY and LIFECYCLE:
-- everything matchmaking, the lobby list, the canonical queue mirror
-- (createMatchLifecycle / transitionMatchLifecycle) and the match-history
-- formatter (/api/get-bet-history) read. The race's own state — the shared
-- passage and its server-only text, the server GO instant, the per-seat
-- finish/progress columns and the race replay envelope — arrives with the
-- gameplay migration as additive columns, exactly as Mini Golf gained
-- `ai_difficulty` in 0182 after shipping in 0179.
--
-- Player ids are plain clerk-id strings with no FK to `users`, matching every
-- other PvP table.

CREATE TABLE IF NOT EXISTS speed_typing_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id VARCHAR(255) NOT NULL,
  -- Nullable so a 'waiting' row doubles as the open lobby.
  player2_id VARCHAR(255),
  winner_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'ready', 'playing', 'finished', 'cancelled')),
  -- Marked on every practice match so settlement skips rating/trophies/stats.
  is_ai BOOLEAN NOT NULL DEFAULT FALSE,
  -- AI tier for a practice match: easy | normal | hard (NULL = the default).
  ai_difficulty VARCHAR(16),
  -- 'player1' | 'player2' | 'tie'. Null until the match settles.
  result VARCHAR(20) CHECK (result IN ('player1', 'player2', 'tie')),
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

-- Lobby list: "the oldest waiting row with no opponent".
CREATE INDEX IF NOT EXISTS speed_typing_matches_status_idx
  ON speed_typing_matches(status, created_at ASC);--> statement-breakpoint

-- Match history: "my matches, newest first" per seat.
CREATE INDEX IF NOT EXISTS speed_typing_matches_player1_idx
  ON speed_typing_matches(player1_id, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS speed_typing_matches_player2_idx
  ON speed_typing_matches(player2_id, created_at DESC);
