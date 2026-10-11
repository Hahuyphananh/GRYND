-- Stakes are retired (src/lib/games/stakes.js): a Pool lobby is free to open, so
-- every lobby the platform creates carries `wager = 0`.
--
-- 0022_pool_masters.sql created this column as `wager INT NOT NULL CHECK (wager > 0)`.
-- That was correct while entering a game cost tokens, and it is now the last thing
-- in the schema that makes free play impossible: `POST /api/pool/create-lobby`
-- stores the normalized stake (0), Postgres refuses the row, and the lobby fails
-- with a raw `insert into "pool_lobbies" ... violates check constraint` instead of
-- opening. `pool_matches.wager` was already converted to `>= 0`; only the lobby's
-- copy of the constraint was missed.
--
-- Dropped by a NAME-AGNOSTIC lookup before it is re-added: the constraint was
-- declared INLINE in 0022, so its name is whatever Postgres generated for that
-- statement (`pool_lobbies_wager_check` in practice, but nothing depends on that
-- here). The lookup matches any check constraint on this table whose definition
-- mentions `wager` — which includes the one added below — so replaying this file
-- drops and re-creates it instead of failing on a duplicate name. The table guard
-- keeps it safe on a database where 0022 has not run.
DO $$
DECLARE
  existing record;
BEGIN
  IF to_regclass('pool_lobbies') IS NULL THEN
    RETURN;
  END IF;

  FOR existing IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'pool_lobbies'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%wager%'
  LOOP
    EXECUTE format('ALTER TABLE "pool_lobbies" DROP CONSTRAINT %I', existing.conname);
  END LOOP;
END $$;

-- A lobby's stake is 0 (or, for any row written before stakes were retired, the
-- historical amount) — but never negative.
ALTER TABLE "pool_lobbies"
  ADD CONSTRAINT "pool_lobbies_wager_free_check" CHECK ("wager" >= 0);
