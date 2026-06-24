-- ── Coin Flip PvP "best of 3" ────────────────────────────────────────────
-- Mirror of the Precision game's best-of-5 wiring. While precision uses
-- a separate `precision_rounds` child table, coin flip reuses the same
-- row per match and just resets per-round columns on each round
-- resolve. The new columns track the multi-round aggregate score.
--
-- `target_wins=2` makes a coin flip match a best-of-3 (first player to
-- win 2 rounds takes the match). DEFAULT 2 keeps existing rows
-- consistent on deploy without an additional backfill migration.
ALTER TABLE "coin_flip_games"
ADD COLUMN "target_wins" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint

ALTER TABLE "coin_flip_games"
ADD COLUMN "score_player1" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "coin_flip_games"
ADD COLUMN "score_player2" integer DEFAULT 0 NOT NULL;
