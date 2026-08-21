-- ============================================================================
-- Serial → UUID primary keys — DRAFT playbook, review before applying
-- ============================================================================
--
-- 18 tables currently use `serial` (sequential integer) primary keys:
--   users, special_titles, streak_titles, user_secret_stats, roulette_games,
--   crash_games, poker_games, poker_player_positions, blackjack_games,
--   mines_games, lane_runner_games, plinko_games, chess_games, uno_games,
--   rps_games, keno_games, email_events, user_automation_state
--
-- WHAT CHANGED vs the previous draft (why this one is safer):
--   • Constraint names are DISCOVERED from pg_constraint, never hardcoded —
--     `DROP CONSTRAINT chess_games_pkey` / `..._fk` no longer fail if the
--     live names differ.
--   • Orphaned child rows are counted and reported BEFORE `SET NOT NULL`, so
--     the failure is a clear message with a count instead of a cryptic
--     "current transaction is aborted".
--   • Re-run guards abort with an explicit message if a previous partial run
--     left `id_int` / `game_id` columns behind.
--   • Old integer columns are NOT dropped in this migration — they stay as a
--     built-in rollback source. Drop them in a separate migration only after
--     the app has been verified for a few days.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Step 0 — discover every FK that points at each serial parent
-- ---------------------------------------------------------------------------
SELECT
  child.relname      AS child_table,
  a.attname          AS child_column,
  parent.relname     AS parent_table
FROM pg_constraint c
JOIN pg_class child   ON child.oid   = c.conrelid
JOIN pg_class parent  ON parent.oid  = c.confrelid
JOIN pg_attribute a   ON a.attrelid  = c.conrelid
                     AND a.attnum    = ANY (c.conkey)
WHERE c.contype = 'f'
  AND parent.relname IN (
    'users','special_titles','streak_titles','user_secret_stats',
    'roulette_games','crash_games','poker_games','poker_player_positions',
    'blackjack_games','mines_games','lane_runner_games','plinko_games',
    'chess_games','uno_games','rps_games','keno_games','email_events',
    'user_automation_state'
  )
ORDER BY parent.relname, child.relname;


-- ---------------------------------------------------------------------------
-- Step 1 — convert one parent + its children (repeat this block per pair)
-- ---------------------------------------------------------------------------
-- Adjust the four table/column names at the top of the DO block for each
-- parent/child pair. Runs atomically: any failure rolls back everything.
BEGIN;

DO $$
DECLARE
  parent_table  text := 'chess_games';
  child_table   text := 'chess_moves';
  parent_col    text := 'id';        -- old serial PK column
  child_col     text := 'game_id';   -- old integer FK column
  fk_name       text;
  pk_name       text;
  orphan_count  bigint;
BEGIN
  -- Guard 1: refuse to run if a previous partial run left columns behind.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = parent_table
      AND column_name = parent_col || '_int'
  ) THEN
    RAISE EXCEPTION '%.% already exists — schema already converted or a previous run was not rolled back',
      parent_table, parent_col || '_int';
  END IF;

  -- 1. Rename the old columns and add the new uuid columns.
  EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I',
    parent_table, parent_col, parent_col || '_int');
  EXECUTE format('ALTER TABLE %I ADD COLUMN %I uuid',
    parent_table, parent_col);
  EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I',
    child_table, child_col, child_col || '_int');
  EXECUTE format('ALTER TABLE %I ADD COLUMN %I uuid',
    child_table, child_col);

  -- 2. Backfill uuid values on parent, then remap children (old int -> uuid).
  EXECUTE format('UPDATE %I SET %I = gen_random_uuid()',
    parent_table, parent_col);
  EXECUTE format(
    'UPDATE %I c SET %I = p.%I FROM %I p WHERE p.%I = c.%I',
    child_table, child_col, parent_col,
    parent_table, parent_col || '_int', child_col || '_int');

  -- 3. Orphan check — report a clear count instead of a NOT NULL abort.
  EXECUTE format(
    'SELECT count(*) FROM %I WHERE %I IS NULL',
    child_table, child_col) INTO orphan_count;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION '% rows in %.% have no matching row in %.% — resolve orphans before re-running',
      orphan_count, child_table, child_col, parent_table, parent_col;
  END IF;

  -- 4. Drop every FK from child → parent (loop: there could be more than one).
  FOR fk_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = to_regclass(child_table)
      AND confrelid = to_regclass(parent_table)
      AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', child_table, fk_name);
  END LOOP;

  -- 5. Swap the parent's primary key (name discovered, not assumed).
  SELECT conname INTO pk_name
    FROM pg_constraint
   WHERE conrelid = to_regclass(parent_table) AND contype = 'p'
   LIMIT 1;
  IF pk_name IS NULL THEN
    RAISE EXCEPTION 'no primary key found on %.%', parent_table, parent_col;
  END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', parent_table, pk_name);
  EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET NOT NULL', parent_table, parent_col);
  EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (%I)', parent_table, parent_col);
  EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT gen_random_uuid()',
    parent_table, parent_col);

  -- 6. Re-add the FK on the child against the new uuid PK.
  EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET NOT NULL', child_table, child_col);
  EXECUTE format(
    'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE CASCADE',
    child_table, child_table || '_' || child_col || '_' || parent_table || '_' || parent_col || '_fk',
    child_col, parent_table, parent_col);
END $$;

COMMIT;
-- NOTE: old integer columns (`id_int`, `game_id_int`) are intentionally KEPT
-- as a rollback source. Once the app has been verified for a few days, drop
-- them in a separate migration:
--   ALTER TABLE chess_moves DROP COLUMN game_id_int;
--   ALTER TABLE chess_games DROP COLUMN id_int;


-- ---------------------------------------------------------------------------
-- Step 2 — `users` is the hardest parent (many integer FKs)
-- ---------------------------------------------------------------------------
-- Its children include integer `user_id`/`host_id` columns (e.g. crash-arena
-- tables, and tables with the "INT to match users.id" comment). Repeat the
-- Step 1 DO block per child, substituting the table/column names. With the
-- dynamic version, the constraint names no longer need guessing — run the
-- Step 0 query first to get the exact child list, then convert child-by-child,
-- each in its own transaction so a failure is isolated.
-- Also update `src/db/schema.ts` (serial -> uuid(...).defaultRandom()) and
-- re-run `drizzle-kit generate` so future migrations match reality.


-- ---------------------------------------------------------------------------
-- Step 3 — app-code sweep before rollout
-- ---------------------------------------------------------------------------
-- grep for integer-id assumptions:
--   grep -rnE "parseInt\(|Number\(.*id|\.id[^a-z]|user_id" src/app --include="*.tsx"
-- Drizzle queries reference columns by name, so schema.ts changes flow
-- through automatically — the risk is raw SQL or client-side arithmetic on ids.
