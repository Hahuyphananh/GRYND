-- ── 0096: Enable Supabase Realtime for chat + big wins ──
--
-- Supabase Realtime (Postgres Changes) pushes row-level events to subscribed
-- clients over a WebSocket. A table must be a member of the
-- `supabase_realtime` publication for its writes to produce events — the
-- client wrapper (src/lib/realtime.ts) subscribes to these tables:
--
--   * big_wins       — live Big Wins feed (ChatWidget)
--   * chat_messages  — live global chat (ChatWidget)
--
-- Admin inbox tables (player_reports / contact_messages) are deliberately
-- NOT published: RLS is on and those rows must stay admin-only. Admin
-- notifications run through the Socket.IO admin room instead (see
-- realtime-server/server.js + src/lib/adminNotify.ts). An earlier draft of
-- this migration may have published them — 0097 removes them if present.
--
-- Guarded so it no-ops on databases without the publication (local dev /
-- non-Supabase Postgres) or when a table is missing, and is idempotent
-- (safe to re-run).
--
-- ⚠️ Security: this app authenticates with Clerk (Supabase Auth is not
-- used), so Realtime streams full rows to any client holding the public
-- publishable key. ONLY non-sensitive, already-public tables belong in the
-- publication. NEVER publish `users` (email / password hash / balance) or
-- other PII tables.

DO $$
DECLARE
  t text;
  target_tables text[] := ARRAY['big_wins', 'chat_messages'];
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
