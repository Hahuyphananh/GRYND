-- ── 0097: Realtime under RLS — public read policies + admin tables out ──
--
-- Background: RLS is enabled on all tables, and Realtime Postgres Changes
-- only delivers events the subscribing role may SELECT. Two consequences:
--
--   1. The admin inbox tables (player_reports / contact_messages) can no
--      longer be streamed to browsers via Realtime — and must NOT get
--      public SELECT policies. Admin notifications now run through the
--      Socket.IO admin-only room (realtime-server/server.js +
--      src/lib/adminNotify.ts). If an earlier draft of 0096 published
--      them, remove them here.
--
--   2. The public realtime tables (big_wins, chat_messages) need an RLS
--      read policy for subscribers to keep receiving events. Both already
--      expose this data through unauthenticated API endpoints
--      (/api/chat/big-wins and GET /api/chat/messages — the auth() call
--      in the messages route guards POST only), so a read-all policy
--      exposes nothing new.
--
-- The policies use `USING (true)` for ALL roles (not just anon) so they
-- keep working whether or not FORCE ROW LEVEL SECURITY is set — the
-- table-owner connection bypasses RLS without FORCE, and with FORCE the
-- app's own reads of these public tables must still pass.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY (no IF NOT EXISTS on
-- CREATE POLICY, so drop-then-create is the safe pattern).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'player_reports'
    ) THEN
      ALTER PUBLICATION supabase_realtime DROP TABLE public.player_reports;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'contact_messages'
    ) THEN
      ALTER PUBLICATION supabase_realtime DROP TABLE public.contact_messages;
    END IF;
  END IF;
END $$;

DROP POLICY IF EXISTS realtime_public_read ON big_wins;
CREATE POLICY realtime_public_read ON big_wins
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS realtime_public_read ON chat_messages;
CREATE POLICY realtime_public_read ON chat_messages
  FOR SELECT
  USING (true);
