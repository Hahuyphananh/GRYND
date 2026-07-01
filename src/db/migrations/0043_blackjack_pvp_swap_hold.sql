-- ── Blackjack PvP: Swap and Hold actions + per-seat hidden state ────
--
-- Adds per-seat usage counters + held-card storage to
-- `blackjack_pvp_matches` so the server-authoritative state machine
-- can enforce the per-round 1-swap + 1-hold cap. Mirrors the same
-- columns onto `blackjack_pvp_rounds` so post-match replays show
-- exactly what each player did without trusting client claims.
--
-- The Swap and Hold actions are described in detail in
-- `src/lib/blackjack-pvp/serverStore.js`. Quoting the user-confirmed
-- spec:
--
--   * Swap (1 use per round, per player): server picks one of the 2
--     ORIGINAL starting cards (always at hand indices 0 and 1 — Hit
--     appends to the end, so the originals are unambiguous) and
--     replaces it with a fresh draw from the deck. Hand length stays
--     the same. Re-bust rule: post-swap score > 21 means the swapper
--     immediately loses the round.
--   * Hold (1 use per round, per player): after Hit, the most-recently
--     drawn card is stored into a side-slot (`player{1,2}_held_card`)
--     instead of being appended to the hand. Use Held (add|discard)
--     later, before Stand, resolves the held card.
--
-- All these columns are SERVER-ONLY state. The API route at GET
-- /api/blackjack-pvp/match/[matchId] scrubs every opponent-side
-- column (cards, score, state, held card, swap count, hold count, hold
-- resolution) before returning — so the opponent never learns whether
-- you stood, busted, swapped, or held.

ALTER TABLE "blackjack_pvp_matches"
  ADD COLUMN IF NOT EXISTS "player1_swaps_used" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "player2_swaps_used" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "player1_holds_used" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "player2_holds_used" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "player1_held_card" jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "player2_held_card" jsonb DEFAULT NULL,
  -- 'add' | 'discard' | null (NULL = held card not yet resolved)
  ADD COLUMN IF NOT EXISTS "player1_held_resolved" varchar(10) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "player2_held_resolved" varchar(10) DEFAULT NULL;
--> statement-breakpoint

-- Mirror the usage counters + held-card resolution onto the
-- per-round history so post-match replays can show what each player
-- did in each round without trusting any client-side replay.
ALTER TABLE "blackjack_pvp_rounds"
  ADD COLUMN IF NOT EXISTS "player1_swaps_used" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "player2_swaps_used" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "player1_holds_used" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "player2_holds_used" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "player1_held_card" jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "player2_held_card" jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "player1_held_resolved" varchar(10) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "player2_held_resolved" varchar(10) DEFAULT NULL;
