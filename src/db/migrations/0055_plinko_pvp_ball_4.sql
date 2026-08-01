-- 0055_plinko_pvp_ball_4.sql
-- Add 'ball_4' to the plinko_pvp_status enum for the 4th tiebreaker ball.
-- When both players are tied after the 3 normal balls, the match advances
-- to a 4th tiebreaker ball. If still tied after ball 4, each player forfeits
-- 5% of their wager and receives 95% back.
ALTER TYPE "plinko_pvp_status" ADD VALUE 'ball_4';
