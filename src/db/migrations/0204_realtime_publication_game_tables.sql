-- ── 0204: Publish the shared foundation's game match tables to Realtime ─────
--
-- 0096 published `big_wins` + `chat_messages`; 0172 later dropped `big_wins`,
-- so before this migration the `supabase_realtime` publication held ONLY
-- `chat_messages`. This migration adds the small, explicitly non-sensitive set
-- of match tables the shared realtime layer (src/lib/realtime.ts +
-- src/hooks/useRealtimeSubscription.ts) is allowed to mirror.
--
-- ⚠️ SECURITY — READ BEFORE ADDING A TABLE
--
-- Clerk is the auth system; Supabase Auth is NOT used and RLS is enabled on
-- all tables. Postgres Changes streams FULL ROWS to any client holding the
-- public publishable key, so ONLY money-free, no-hidden-information match
-- tables may be published. A table is eligible ONLY if ALL of these hold:
--
--   1. It has NO money columns: no wager, stake, bet_amount, payout,
--      prize_pool, prize_paid, house_fee, balance, or token-ledger reference.
--      Staked tables (chess_games, hex_duel_games, odds_games,
--      four_in_a_row_games, dots_and_boxes_*, rps_pvp_games, mines_pvp_*,
--      keno_pvp_*, lane_runner_games, memory_grid_matches, tower_arena_matches,
--      precision_matches, pool_*, dice_flush_rooms) are DELIBERATELY EXCLUDED.
--   2. It carries NO hidden state that an opponent must not read (so
--      solitaire_duel_matches is excluded — its state holds the deck).
--   3. It is NOT a PII / auth table. `users`, the token ledger,
--      user_presence / user_game_presence, and every authentication/session
--      table are NEVER published.
--
-- Eligible today (money-free, perfect-information, verified column-by-column
-- against their CREATE TABLE statements in 0179 and 0192):
--
--   * tic_tac_toe_matches  (0192) — NO wagers/tokens/payouts by design
--   * mini_golf_matches    (0179) — NO wagers/tokens/payouts by design
--
-- Candidates explicitly NOT published yet (needs a column-level review first):
--   sudoku_duel_matches, speed_typing_matches. Publishing them would also
--   require an RLS SELECT policy and a decision on exposing player ids.
--
-- Only the minimum is exposed: a client subscribing to a match uses a filtered
-- subscription (`id=eq.<matchId>`), not "every row in the table".
--
-- Idempotent and guarded: no-ops on a database without the `supabase_realtime`
-- publication (local dev / non-Supabase Postgres) or where a table is missing,
-- and is safe to re-run.

DO $$
DECLARE
  t text;
  target_tables text[] := ARRAY['tic_tac_toe_matches', 'mini_golf_matches'];
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

-- RLS is enabled, and Realtime Postgres Changes only delivers rows the
-- subscribing role may SELECT. Mirror 0097's `realtime_public_read` policy for
-- the tables published above (guarded on table existence). `USING (true)` for
-- ALL roles keeps working whether or not FORCE ROW LEVEL SECURITY is set — the
-- table-owner connection bypasses RLS without FORCE, and with FORCE the app's
-- own reads must still pass.
DO $$
DECLARE
  t text;
  target_tables text[] := ARRAY['tic_tac_toe_matches', 'mini_golf_matches'];
BEGIN
  FOREACH t IN ARRAY target_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = t AND n.nspname = 'public'
    ) THEN
      EXECUTE format('DROP POLICY IF EXISTS realtime_public_read ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY realtime_public_read ON public.%I FOR SELECT USING (true)',
        t
      );
    END IF;
  END LOOP;
END $$;
