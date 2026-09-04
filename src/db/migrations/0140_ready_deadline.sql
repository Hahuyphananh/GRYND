-- 0140: ready_deadline_at for the pair-game "Match found!" ready phase.
--
-- Four-In-A-Row and Dots & Boxes used to flip straight from waiting →
-- in_progress the moment the opponent joined, so the waiting takeover
-- could never show both players. A brief ready window (status "ready")
-- now sits between join and start, with ready_deadline_at marking when
-- the countdown ends and the game auto-advances to in_progress (via
-- advanceReadyIfNeeded in the game-state routes). Both pages render the
-- unified MatchWaiting "Match found!" takeover with both usernames +
-- wagers during that window.
--
-- Additive and idempotent (safe to run repeatedly).

ALTER TABLE "four_in_a_row_games" ADD COLUMN IF NOT EXISTS "ready_deadline_at" timestamp;
ALTER TABLE "dots_and_boxes_games" ADD COLUMN IF NOT EXISTS "ready_deadline_at" timestamp;