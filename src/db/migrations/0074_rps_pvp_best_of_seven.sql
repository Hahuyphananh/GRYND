-- 0074_rps_pvp_best_of_seven.sql
-- RPS PvP: convert the single-round wager into a best-of-7 match.
--
-- Previously a matched game ended the moment both players submitted a
-- choice (winner took the pot). Now a match runs until one player
-- reaches 4 round wins (first to 4, best of 7):
--
--   • rounds_won_1 / rounds_won_2 — tally of decided rounds per player.
--   • current_round — 1-based round number. Ties do NOT advance the
--     round; the same round is replayed until someone wins it.
--   • round_history — JSONB array of resolved rounds, one entry per
--     decided round: { round, player1Choice, player2Choice, winner }
--     where winner is 'player1' | 'player2' | 'tie'. Used by the match
--     page to render the rounds sidebar (each player's last throw).
--
-- The wager stays escrowed across all rounds (it was already deducted
-- from both players at create/join) and is paid out once the match
-- finishes — the single-round payout logic moves from the "both chose"
-- moment to the "4th round win" moment.
--
-- Applied manually like the other raw SQL migrations (0055+). Every
-- statement is idempotent — ADD COLUMN IF NOT EXISTS no-ops on
-- databases that already applied this migration.
ALTER TABLE rps_pvp_games ADD COLUMN IF NOT EXISTS rounds_won_1 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rps_pvp_games ADD COLUMN IF NOT EXISTS rounds_won_2 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rps_pvp_games ADD COLUMN IF NOT EXISTS current_round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rps_pvp_games ADD COLUMN IF NOT EXISTS round_history JSONB NOT NULL DEFAULT '[]'::jsonb;
