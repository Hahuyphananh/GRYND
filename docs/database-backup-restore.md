# Database Backup & Restore (Supabase)

GRYND's Postgres now runs on **Supabase** (see `docs/SUPABASE_MIGRATION.md`;
the Neon runbook `docs/neon-backup-restore-runbook.md` is historical). This
doc covers the backup/restore tooling that ships with the repo and how to
test that restores actually work.

> **Golden rule: "we have backups" is not "restores work".** Run the drill
> below before trusting any backup, then repeat it quarterly (or whenever
> the schema changes).

## What protection exists (by default)

| Mechanism | What it does |
|---|---|
| **Supabase PITR / point-in-time recovery** | Supabase keeps write-ahead logs so you can restore a branch to any past timestamp (paid plans; free tier keeps ~1 day) |
| **Supabase scheduled backups** | Optional daily/weekly backups of the whole project, restorable from the dashboard |
| **Supabase branches** | Instant zero-copy branches — the recommended way to test a *schema/data* restore without touching production |

**None of those survive the whole Supabase project vanishing.** A logical
dump (`scripts/db-backup.mjs`) is the only portable artifact — it is a
plain `pg`-generated SQL file you can store off-site (S3, CI artifact,
local machine) and restore anywhere, including a different provider.

## The backup script

```bash
# Writes ./backups/grynd-YYYY-MM-DD.sql (schema + data in one file, in a transaction)
DATABASE_URL="postgresql://<user>:<password>@<host>:6543/postgres" npm run db:backup

# Custom path, or stream to stdout
DATABASE_URL="..." node scripts/db-backup.mjs -o=backups/prod-2026-09-04.sql
DATABASE_URL="..." node scripts/db-backup.mjs --stdout > prod.sql
```

- **Dependency-free**: uses the `pg` driver already in the project — no
  `pg_dump`/`psql`/Docker needed.
- **Read-only**: no writes, no locks, no `VACUUM`-style work.
- **Portable output**: plain SQL with schema DDL (enums, sequences, tables,
  constraints, indexes) + `INSERT` data in **foreign-key order**, plus
  `setval()` calls to realign sequences after restore.
- The dump is a single `BEGIN…COMMIT` transaction, so a failed restore
  leaves the target untouched.

## The restore script

```bash
# Apply a backup to a target DB
TARGET_URL="postgresql://<user>:<password>@<host>:6543/postgres" npm run db:restore -- backups/grynd-2026-09-04.sql

# Wipe the target's public schema first (DESTRUCTIVE — only for scratch DBs)
TARGET_URL="..." node scripts/db-restore.mjs backups/grynd-2026-09-04.sql --reset-schema

# After restoring, compare row counts against the source DB (the real drill)
SOURCE_URL="..." node scripts/db-restore.mjs backups/grynd-2026-09-04.sql --verify-source="$SOURCE_URL"
```

The restore runs in one transaction; any failure rolls back. With
`--verify-source`, it prints a per-table `source → target` row-count
comparison and exits non-zero on any mismatch.

## The restore drill (practice quarterly)

1. **Take writes off**: admin dashboard → *Turn Maintenance ON* (this is a
   real restore drill — prevent writes during it).
2. **Back up** the live DB with `db:backup` (the artifact you're testing).
3. **Create a scratch target**: Supabase → create a new **branch** (or a
   fresh project) and grab its connection string.
4. **Restore** into the scratch DB:
   ```bash
   SOURCE_URL="$(grep DATABASE_URL .env.local | cut -d= -f2-)" \
   TARGET_URL="postgresql://postgres.<ref>:<pw>@db.<ref>.supabase.co:5432/postgres" \
   node scripts/db-restore.mjs backups/grynd-<date>.sql --reset-schema --verify-source="$SOURCE_URL"
   ```
   Expect `Restore verified (N tables checked) — backup/restore round-trip OK ✔`.
5. **Spot-check the app against the scratch DB**: point a local dev server
   at the scratch URL, confirm a user's balance/history look sane, and a
   couple of game pages render.
6. **Maintenance OFF**, then delete the scratch branch.

## Post-restore checklist (every restore, real or drill)

- [ ] `app_settings.maintenance_mode = false` (restore to an old timestamp
      may have caught it ON)
- [ ] `/api/health` → `db: ok`
- [ ] Admin dashboard loads (admin badge is data — an old restore can roll
      back `is_admin`)
- [ ] Sequences are realigned (the dump includes `setval`; insert a row in
      a fresh dev DB to confirm no PK collisions)
- [ ] The weekly-reset cron state is sane
- [ ] Realtime games work (socket server reaches the DB)

## Testing the tooling without a live database

The pure logic (SQL literal escaping, statement splitting, FK ordering) is
unit-tested in `tests/db-backup-restore.test.mjs`:

```bash
npm run test:db-backup-restore   # or part of npm test
```

This covers data-integrity escapes (`O'Brien` → `O''Brien`), the
emit/split contract, and that parents are always dumped before children —
the three things that silently corrupt or abort a restore.