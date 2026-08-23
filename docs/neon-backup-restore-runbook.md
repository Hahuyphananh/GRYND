# Neon Backup & Restore Runbook

GRYND's database is Neon Postgres. This runbook documents what protection
exists, how to verify restores actually work, and the exact steps to follow
during a real incident.

> **Golden rule: "we have backups" is not "restores work".** Run the restore
> drill below at least once before launch, then quarterly. A restore you have
> never practiced will fail at the worst possible moment.

---

## What protection exists (by default)

| Mechanism | What it does | Retention |
|---|---|---|
| **Change history / Time Travel** | Neon keeps a full change history (WAL) so you can branch from or restore to any past timestamp | Up to 30 days (plan-dependent) |
| **Scheduled snapshots** | Optional scheduled backups on top of the change history | Configurable |
| **Branching** | Instant, zero-copy branches used for restore/recovery and testing | Indefinite until deleted |

**You do not get an off-site backup from Neon alone.** A logical `pg_dump`
export is the only artifact that survives "the whole project vanished" — run
it on a schedule if that risk matters to you (script below).

---

## Verify current settings (5 minutes, before launch)

1. Neon console → your project → **Settings → Storage** (or **Branches**):
   - Confirm the **restore window** is what you expect (30 days on Scale).
   - Confirm snapshots are enabled if you configured them.
2. Test a branch restore right now — this is the drill below.

---

## The restore drill (practice this quarterly)

### Option A — Neon branch restore (recommended, instant)

1. **Take the app down**: admin dashboard → *Turn Maintenance ON* (the kill
   switch we built). This prevents writes during the restore.
2. Neon console → **Branches** → **Restore**:
   - Pick the timestamp (or LSN) you want to restore to.
   - Restore **into a new branch** first — never restore over `main`
     blindly. Name it e.g. `restore-drill-<date>`.
3. **Verify the branch**:
   ```bash
   # Point a throwaway DATABASE_URL at the new branch, then:
   npx tsx -e "
     const { db } = await import('./src/db');
     const rows = await db.execute('SELECT count(*) FROM users');
     console.log('users:', rows);
   "
   ```
   - Spot-check: `users` row count, a recent game row, `app_settings` has
     `maintenance_mode=false`.
   - Confirm the migration journal matches the app version
     (`src/db/migrations` — the newest file must be applied on the branch).
4. **Promote the branch** only after verification passes (Neon: branch →
   **Set as primary**), then point `DATABASE_URL` back and confirm.
5. **Bring the app back**: admin dashboard → *Turn Maintenance OFF*.
6. Confirm `/api/health` reports `db: ok`.

### Option B — logical dump/restore (off-site safety net)

Run monthly to a safe location (S3, your machine, etc.):

```bash
# Dump (uses the non-pooling connection string — set POSTGRES_URL_NON_POOLING)
pg_dump "$POSTGRES_URL_NON_POOLING" --no-owner --no-privileges \
  -f grynd-backup-$(date +%F).sql

# Restore into a scratch database to verify the artifact is usable
createdb grynd-restore-test
pg_restore --no-owner --dbname=grynd-restore-test grynd-backup-$(date +%F).sql
# or, for plain-SQL dumps: psql grynd-restore-test < grynd-backup-$(date +%F).sql
```

> `pg_dump` may not be installed locally — it ships with Postgres (`brew
> install libpq` on macOS, `apt install postgresql-client` on Linux).

---

## Post-restore app checklist (every restore, real or drill)

- [ ] `app_settings` table exists and `maintenance_mode` = `false`
- [ ] `/api/health` returns `db: ok` (and `redis: ok`)
- [ ] Admin dashboard loads (admin user still has `is_admin` in the restored
      data — a restore to an old timestamp may roll back admin badges)
- [ ] A user's balance and game history look sane
- [ ] The weekly-reset cron ran successfully (`/api/jobs/weekly-reset`) — a
      restore can confuse its last-run state
- [ ] Real-time games work (socket server can reach the DB)

---

## Incident playbook (real restore)

1. **Assess**: how much data loss is acceptable? Pick the newest timestamp
   that contains no corrupt/erroneous data.
2. **Maintenance ON** (admin dashboard) — stop writes immediately.
3. **Branch-restore** to that timestamp (Option A, step 2).
4. **Verify** before promoting (Option A, step 3) — especially that the
   schema version matches the deployed app.
5. **Promote**, **maintenance OFF**, run the post-restore checklist.
6. **Post-mortem**: log what happened in `docs/`; update this runbook with
   anything that surprised you.
