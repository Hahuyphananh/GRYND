-- 0116: RLS on the token-economy tables.
--
-- Prevents normal (non-privileged) database roles from directly reading or
-- writing token balances / transaction records. The app's own server-side
-- connection (the pool owner or Supabase `service_role`) bypasses RLS, so this
-- is transparent to the application — every balance change still flows through
-- the server-authoritative credit path.
--
-- Deliberately NOT using `FORCE ROW LEVEL SECURITY`: FORCE would also block the
-- owning connection, which is how the app's Drizzle pool may connect. Enabling
-- RLS alone is enough to deny the `anon`/client role (which has no policies),
-- while the privileged connection keeps full access. Same pattern as the
-- existing realtime RLS on chat_messages / big_wins.

ALTER TABLE "token_packages"
  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "token_transactions"
  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "stripe_checkout_sessions"
  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Explicit default-deny policies (idempotent). Clients get no grant; only the
-- bypassing privileged connection operates on these tables.
DROP POLICY IF EXISTS "token_tables_no_direct_client_access" ON "token_packages";
CREATE POLICY "token_tables_no_direct_client_access" ON "token_packages"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "token_tables_no_direct_client_access" ON "token_transactions";
CREATE POLICY "token_tables_no_direct_client_access" ON "token_transactions"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "token_tables_no_direct_client_access" ON "stripe_checkout_sessions";
CREATE POLICY "token_tables_no_direct_client_access" ON "stripe_checkout_sessions"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint

-- Block any PUBLIC grants that would have exposed these to the anon role.
REVOKE ALL ON "token_packages"           FROM PUBLIC;
REVOKE ALL ON "token_transactions"       FROM PUBLIC;
REVOKE ALL ON "stripe_checkout_sessions" FROM PUBLIC;
--> statement-breakpoint