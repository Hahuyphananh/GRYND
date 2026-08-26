-- ============================================================================
-- Restore column defaults lost during the Neon → Supabase dump/restore
-- ----------------------------------------------------------------------------
-- The data migration copied rows with explicit ids but the schema dump/restore
-- dropped the DEFAULT clauses on these columns. Drizzle's schema expects them
-- (uuid PKs with defaultRandom(), status with default 'waiting'), so inserts
-- that rely on the ORM-generated defaults fail with NOT NULL violations:
--   • /api/chat/big-wins/record → 500 on every big win (inserts without id)
--   • recordBigWinIfNeeded()     → silently fails to record big wins
--   • pool_* inserts currently work only because the routes pass
--     crypto.randomUUID() + status explicitly — fragile, any new insert site
--     would break.
-- Idempotent: SET DEFAULT can be re-run safely.
--
-- Also: chess_moves.game_id_int is a dead leftover from the serial→UUID
-- migration (kept as rollback source per UUID_MIGRATION.sql) but is NOT NULL
-- with no default, so every chess move insert fails with 23502. The app never
-- writes it — relax it so inserts succeed; the column can be dropped later.
-- ============================================================================

ALTER TABLE big_wins
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE pool_lobbies
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE pool_lobbies
  ALTER COLUMN status SET DEFAULT 'waiting';

ALTER TABLE pool_matches
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE pool_shots
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE chess_moves
  ALTER COLUMN game_id_int DROP NOT NULL;
