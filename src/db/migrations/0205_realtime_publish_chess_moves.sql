-- ── 0205: Publish `chess_moves` for event-driven Chess state sync ───────────
--
-- Chess previously polled `/api/chess/game-state?gameId=…` every 2s to learn
-- about the opponent's move. The append-only `chess_moves` row written by the
-- authoritative `/api/chess/move` route is the minimum table that can produce
-- those move events, so it is published here.
--
-- WHY ONLY `chess_moves` (NOT `chess_games`):
--   Postgres Changes streams FULL rows to any client holding the public
--   publishable key, and RLS cannot restrict COLUMNS. `chess_games` carries
--   money/identity columns (`bet_amount`, `payout`, `player_white_id`,
--   `player_black_id`, `winner_id`), so publishing it would leak wagers and
--   player ids. It is DELIBERATELY EXCLUDED. Game-level transitions (join,
--   resign, draw, opponent-left, clock timeout) are delivered as a Socket.IO
--   room "poke" that triggers ONE authoritative `/api/chess/game-state`
--   fetch — never a recurring poll — so no sensitive game row is ever exposed.
--
-- `chess_moves` columns are all safe to expose: id, game_id, played_by (Clerk
-- id, the same identifier `chat_messages` already publishes), move_uci,
-- move_san, fen_after, created_at. No money, no hidden information (a completed
-- move is public to both players).
--
-- SECURITY INVARIANTS (unchanged):
--   * Clerk remains the only auth system; Supabase Auth is NOT used.
--   * The browser NEVER writes authoritative state through Supabase. Moves
--     still go through `/api/chess/move`; Realtime is read-only notification.
--   * `users`, the token ledger, auth/session tables, `chess_games`, and every
--     other staked game table remain OUT of the publication.
--
-- Idempotent and guarded: no-ops on a database without the `supabase_realtime`
-- publication (local dev / non-Supabase Postgres) or where the table is
-- missing, and is safe to re-run.

DO $$
DECLARE
  t text;
  target_tables text[] := ARRAY['chess_moves'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;

  FOREACH t IN ARRAY target_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = t AND n.nspname = 'public'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Realtime only delivers rows the subscribing role may SELECT, and RLS is
-- enabled, so `chess_moves` needs the same read policy 0097 gave chat_messages.
-- Guarded on table existence; `USING (true)` for ALL roles keeps working
-- whether or not FORCE ROW LEVEL SECURITY is set (the table-owner connection
-- bypasses RLS without FORCE, and with FORCE the app's own reads must pass).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'chess_moves' AND n.nspname = 'public'
  ) THEN
    DROP POLICY IF EXISTS realtime_public_read ON public.chess_moves;
    CREATE POLICY realtime_public_read ON public.chess_moves
      FOR SELECT
      USING (true);
  END IF;
END $$;
