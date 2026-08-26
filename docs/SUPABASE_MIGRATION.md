# Neon → Supabase Migration Runbook

## Why

The app's Postgres was on **Neon Free** (100 compute hours/month). The site
blew past 100h, Neon suspended the compute, the site degraded, and Google
Search Console flagged the redirect issues. **Supabase** has no compute-hour
cap and far more storage headroom, so this moves the database there.

Auth (Clerk), the realtime server (Render), and the app itself are
**unchanged** — only the Postgres provider moves.

## What the code change did

All database access now goes through plain `pg` (TCP) so it works against
any Postgres, including Supabase:

- `src/db/pool.ts` — one shared `pg` Pool (reads `DATABASE_URL`, SSL on for
  cloud hosts).
- `src/db/client.ts` — Drizzle over `pg` (`drizzle-orm/node-postgres`),
  typed with the schema.
- `src/db/index.ts` — re-exports the same client (all `import { db } from
  "../db"` callers unchanged).
- `src/db/neon.ts` — `getNeonSql()` is now pg-backed (was Neon's HTTP-only
  `neon()` driver, which cannot talk to Supabase).
- `src/db/sql.ts` — `sql` tagged template replacing `@vercel/postgres`
  (deprecated, and it rejects Supabase pooler URLs).
- `src/db/migrate.ts` — uses `drizzle-orm/node-postgres/migrator`.
- `src/db/migrations/_journal.json` — **rebuilt**: it only had 14 of 99
  entries, so `npm run db:migrate` would have applied a fraction of the
  schema. Now all 99 migrations are in the journal, ordered by number then
  creation date.
- `src/db/migrations/0092_missing_tables_from_push.sql` — **new**: 7 tables
  (`user_presence`, `user_login_rewards`, `connect_four_games`,
  `dice_flush_rooms/players/actions`, `lane_runner_pvp_matches`) plus 2 enum
  types existed in `schema.ts` but were never in a migration (only ever
  `drizzle-kit push`ed). This migration recreates them so a fresh database
  built from the chain matches the schema.
- `scripts/check-schema-vs-migrations.mjs` — verifies every schema table /
  column is covered by a migration (currently passes).
- `scripts/migrate-data.mjs` — copies data from the source DB to the target.

## Prerequisites

1. A Supabase project (you have one: `wfiqkaltdpaqhhfxkhmt.supabase.co`).
2. The **Neon** connection string still in `DATABASE_URL` (in `.env.local` /
   Vercel). Neon may wake on connect even after suspension — try it.
3. Supabase connection strings from
   **Project Settings → Database → Connection string**:
   - **Transaction pooler** (for the app / serverless): `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
   - **Direct** or **Session pooler** (for the migration script): the direct
     URL `postgresql://postgres.<ref>:<password>@db.<ref>.supabase.co:5432/postgres`

## How the migration was actually executed

> The migration SQL chain (`src/db/migrations`) was **never the source of
> truth** — it was missing journal entries (14 of 99), missing columns
> (e.g. `chess_games.status`), and had cast bugs. The live Neon schema was
> the ground truth, so the schema was **dumped from Neon** and restored to
> Supabase instead.

### 1. Schema (dumped from Neon → restored to Supabase)

```bash
# dump the live Neon schema as DDL (enums, sequences, tables, constraints, indexes)
SOURCE_URL="<neon-url>" node scripts/dump-schema.mjs > neon_schema.sql

# reset the target public schema and apply the dump (one transaction)
TARGET_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
  node scripts/apply-schema.mjs neon_schema.sql
```

### 2. Data (Neon → Supabase)

```bash
NEON_URL="<neon-url>" \
SUPA_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
node scripts/migrate-data.mjs
```

Copies all public tables in FK order (9,973 rows for this migration),
fixes sequences, prints per-table row-count verification, and exits
non-zero on mismatches.

### 3. Mark migrations as applied (so future `npm run db:migrate` is incremental)

```bash
TARGET_URL="postgresql://postgres.<ref>:<password>@..." \
  node scripts/mark-migrations-applied.mjs
```

Records the sha256 of all 99 migration files in `drizzle.__drizzle_migrations`.

### 4. Swap the environment variables

- **`.env.local`** (local dev): **done** — `DATABASE_URL` now points at the
  Supabase **transaction pooler** (`...pooler.supabase.com:6543/postgres`).
- **Vercel** (Project Settings → Environment Variables): set `DATABASE_URL`
  to the same Supabase transaction pooler URL, then redeploy. `POSTGRES_URL`
  is no longer used by any code — you can leave it or remove it. Keep the
  Neon URL saved somewhere for rollback.
- **Render** (realtime server): no DB connection — no change. It reaches
  the database only through Next.js API routes.

### 5. Verify

- `GET /api/debug-env` → `dbPingStatus: "ok"` (dev only).
- Sign in, check balance/history, start a PvP match.
- Sanity-check counts: `SELECT COUNT(*) FROM users;` on Supabase vs the
  numbers you remember from Neon.
- Watch the Supabase dashboard (Database → usage) — no compute-hour cap.

### 6. Rollback

If anything goes wrong, flip `DATABASE_URL` back to the Neon URL on Vercel
and redeploy. Both databases remain intact during the transition; delete the
Neon project only after a few days of clean Supabase operation.

## Not migrated (deliberately)

- `data/*.sql` — sample/seed data with fake users (alice@example.com…).
  Do **not** restore into production.
- `docs/security-fixes/RLS_MIGRATION.sql`, `UUID_MIGRATION.sql` — drafts,
  not applied on Neon, so not applied here.
- `drizzle/` (legacy folder) — an older migration out-dir superseded by
  `src/db/migrations/`.

## Security posture (unchanged)

- **Auth**: Clerk, exactly as before. Supabase Auth is not used.
- **RLS**: off, exactly as before (tables are app-layer protected). Do not
  enable Supabase RLS unless you write per-user policies — the app
  authenticates via Clerk, not Supabase.
- All validation, IDOR checks, and admin MFA stay in the app layer.
