-- ============================================================================
-- DROP orphaned legacy tables — review before applying
-- ============================================================================
--
-- These tables exist in the live database but are NOT referenced anywhere in
-- the app code (no schema.ts entry, no SQL, no route). They are leftovers of
-- removed features (the clicker game was dropped; coin-flip is dead):
--
--   * clicker_actions  (~2 rows)
--   * clicker_rounds   (~78 rows)
--   * clicker_users    (~7 rows)
--   * coin_flip_games  (0 rows)
--
-- Keeping them costs nothing functionally, but they are surface area: they
-- appear in pg_dump output, and if RLS is ever FORCED they'd need policies
-- like every other table. Dropping them removes dead weight.
--
-- ⚠️ This deletes data. Run in a transaction on a COPY of the database first,
-- and only apply to production when you're sure the clicker feature is never
-- coming back. The wallet/transactions tables are NOT listed here because
-- those tables don't exist in the live DB at all (the wallet API routes that
-- referenced them were removed in the same cleanup — see git history).
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS public.clicker_actions;
DROP TABLE IF EXISTS public.clicker_rounds;
DROP TABLE IF EXISTS public.clicker_users;
DROP TABLE IF EXISTS public.coin_flip_games;

COMMIT;
