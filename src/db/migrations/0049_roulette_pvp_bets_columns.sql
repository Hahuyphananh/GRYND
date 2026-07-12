-- ── Roulette PvP: live round bet state on the match row ────────────────
-- Bug fix: the server's `submitBets` and `resolveRound` functions
-- read and write `player1_bets` / `player2_bets` on the
-- `roulette_pvp_matches` row to track the IN-FLIGHT (between-submit-
-- and-resolve) bets for the current round. Without these columns,
-- Drizzle silently dropped those updates server-side — so
-- `submitBets` couldn't persist lock-ins, `bothReady` never tripped
-- when expected, and `fetchMatchWithAutoResolve` force-resolved with
-- empty bets at every deadline (producing zero payouts and the
-- illusion that "both players' points reset to 100 after every round"
-- even with healthy DB rows). The match-status API already normalises
-- those columns client-side; only the DB schema and the nullable
-- jsonb columns were missing here.
--
-- The columns default to NULL so live state is unambiguous — a NULL
-- `player{N}_bets` means "has not locked in for the current round",
-- NOT "has locked in with empty bets" (empty bets are stored as the
-- JSON literal `{}` per `submitBets`). The round-history
-- `roulette_pvp_rounds.player{1,2}_bets` is left untouched.
ALTER TABLE "roulette_pvp_matches"
  ADD COLUMN IF NOT EXISTS "player1_bets" jsonb,
  ADD COLUMN IF NOT EXISTS "player2_bets" jsonb;
