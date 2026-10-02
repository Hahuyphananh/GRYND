-- 0197: Solitaire Duel / Sudoku Duel inactivity tracking.
--
-- BOTH duels drop their match time limit: `deadline_at` stays in the schema but
-- is no longer written, so a live match has no clock and can only end by a
-- completion, a concession, a long disconnect, or the inactivity rule below.
--
-- `p1_last_action_at` / `p2_last_action_at` record each seat's OWN last accepted
-- move/action (NULL until the seat's first move, in which case GO is the
-- baseline). They are what the server compares against INACTIVITY_ALARM_MS
-- (15 min → alarm the idle seat) and INACTIVITY_FORFEIT_MS (20 min → the idle
-- seat forfeits and the opponent wins). One nullable timestamp per seat, so a
-- read never has to scan the append-only move log to prove a seat is idle.

ALTER TABLE solitaire_duel_matches
  ADD COLUMN IF NOT EXISTS p1_last_action_at timestamp;--> statement-breakpoint
ALTER TABLE solitaire_duel_matches
  ADD COLUMN IF NOT EXISTS p2_last_action_at timestamp;--> statement-breakpoint
ALTER TABLE sudoku_duel_matches
  ADD COLUMN IF NOT EXISTS p1_last_action_at timestamp;--> statement-breakpoint
ALTER TABLE sudoku_duel_matches
  ADD COLUMN IF NOT EXISTS p2_last_action_at timestamp;
