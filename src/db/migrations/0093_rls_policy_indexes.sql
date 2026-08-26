-- ── 0093: Indexes required by RLS policies and account-deletion purges ──
--
-- The RLS policy plan (docs/security-fixes/RLS_MIGRATION.sql) filters every
-- row by the acting Clerk id (current_setting('app.clerk_id')), and
-- lib/security/deleteUserData.ts deletes by the same id columns. These
-- filters only stay fast (and the policies only stay index-backed) if the
-- matching column has an index. Most tables already do; this migration
-- closes the gaps found during the Supabase/RLS audit:
--
--   * chat_messages.clerk_id         — chat moderation + user purge
--   * big_wins.user_id               — big-wins feed + user purge
--   * chess_moves.played_by          — user purge (cascade from games)
--   * pool_shots.user_id             — user purge
--   * dice_flush_actions.user_id     — user purge
--   * dice_flush_players.user_id     — user purge
--   * dice_lobbies.host/opponent     — user purge
--   * pool_lobbies.host/opponent     — user purge
--   * hex_duel_games.player2_id      — user purge (player1 already indexed)
--   * rps_pvp_games.player2_id       — user purge (player1 already indexed)
--   * odds_games.player2_id          — user purge (player1 already indexed)
--
-- All are CREATE INDEX IF NOT EXISTS — safe to apply to any database
-- (missing tables from schema drift are skipped by the guard clauses).

CREATE INDEX IF NOT EXISTS "chat_messages_clerk_idx" ON "chat_messages" ("clerk_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "big_wins_user_idx" ON "big_wins" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chess_moves_played_by_idx" ON "chess_moves" ("played_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_shots_user_idx" ON "pool_shots" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dice_flush_actions_user_idx" ON "dice_flush_actions" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dice_flush_players_user_idx" ON "dice_flush_players" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dice_lobbies_host_user_idx" ON "dice_lobbies" ("host_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dice_lobbies_opponent_user_idx" ON "dice_lobbies" ("opponent_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_lobbies_host_user_idx" ON "pool_lobbies" ("host_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_lobbies_opponent_user_idx" ON "pool_lobbies" ("opponent_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hex_duel_games_player2_idx" ON "hex_duel_games" ("player2_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rps_pvp_games_player2_idx" ON "rps_pvp_games" ("player2_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "odds_games_player2_idx" ON "odds_games" ("player2_id");
