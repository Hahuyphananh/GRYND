-- Migration 0064 — Keno PvP overtime + extended round cap.
--
-- Extends the `keno_pvp_status` pgEnum (created in migration 0061) so
-- the Keno Catch Duel match clock can run ~3 minutes before settling:
--
--   * round_6 … round_16 — the round race is allowed to run PAST the
--     3-minute match clock (16 rounds × ~11.6s ≈ 3.1 min) so the
--     overtime rule can actually fire. Matches still end the moment a
--     player reaches POINTS_TO_WIN (10).
--   * 'overtime' — a 30-second countdown state entered when nobody has
--     reached 10 points at the next round boundary after the 3-minute
--     clock. No balls release during overtime; when it ends the player
--     with the most tiles (highest cumulative score) wins, and an
--     overtime tie is a DRAW that refunds each player 95% of their
--     stake (5% rake per side).
--
-- State machine after this migration:
--   waiting → ready → round_1 … round_16 → overtime → finished
--   (waiting/ready/round_N/overtime → cancelled for forfeits)
--
-- Values MUST stay in sync with src/lib/keno-pvp/constants.js
-- (MATCH_STATUS / MAX_ROUNDS) and src/db/schema.ts
-- (kenoPvpStatusEnum). New enum values are appended with ADD VALUE so
-- existing rows keep their meaning.

ALTER TYPE "keno_pvp_status" ADD VALUE 'round_6';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'round_7';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'round_8';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'round_9';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'round_10';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'round_11';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'round_12';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'round_13';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'round_14';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'round_15';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'round_16';--> statement-breakpoint
ALTER TYPE "keno_pvp_status" ADD VALUE 'overtime';
