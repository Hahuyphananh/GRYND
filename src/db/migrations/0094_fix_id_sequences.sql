-- ── 0094: Re-sync id sequences after the Neon → Supabase data migration ──
--
-- The data migration (scripts/migrate-data.mjs) copied rows with explicit
-- ids, then called fixSequences(), which relied on pg_get_serial_sequence().
-- That function returns NULL when the sequence→column dependency is missing
-- (the schema dump/restore restored `DEFAULT nextval(...)` columns without
-- the pg_depend auto-link), so the fix silently did nothing. Every serial
-- column kept its fresh-install value (1 or 2) while the table already held
-- hundreds of rows — the next INSERT collided with an existing primary key
-- and 500'd every game route that creates/joins a match or records a game
-- (duplicate key value violates unique constraint "..._pkey").
--
-- This migration finds serial columns the resilient way — via the
-- information_schema nextval() default, which does not depend on the
-- sequence→column dependency — and setval()s each sequence to MAX(col).
--
-- Safe to run any number of times:
--   * setval(seq, MAX(col), true) only ever moves sequences FORWARD
--     relative to existing rows, never backward.
--   * Tables with no rows get nextval = 2 (setval(seq, 1, true)).
--   * Orphaned sequences (owning table/column gone) are skipped.

DO $$
DECLARE
  r RECORD;
  seq_name text;
  max_id bigint;
BEGIN
  FOR r IN
    SELECT table_schema, table_name, column_name, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_default LIKE 'nextval(%'
    ORDER BY table_name, ordinal_position
  LOOP
    seq_name := substring(
      r.column_default
      FROM 'nextval\(''([^'']+)''::regclass\)'
    );
    CONTINUE WHEN seq_name IS NULL;

    -- Skip orphaned sequences whose owning table/column no longer exists.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = r.table_schema AND table_name = r.table_name
    );
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = r.table_schema
        AND table_name = r.table_name
        AND column_name = r.column_name
    );

    EXECUTE format(
      'SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I.%I), 1), true)',
      seq_name,
      r.column_name,
      r.table_schema,
      r.table_name
    );
  END LOOP;
END $$;
