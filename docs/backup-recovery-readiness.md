# Backup and recovery readiness — audit, design and drill

**Status: audit and design only.** No backup was taken, no restore was run, no
schedule was enabled, no credential was created or changed, and no Supabase
setting was touched. The only code added is a read-only status collector
(`deploy/lib/backup/status.mjs`) and a `backup` command in the Control Center
broker. Everything that would create, move or delete a backup is gated on your
approval in §10.

Read §2 for what is actually true today, §4 for the destination recommendation,
§7 for the drill that must pass before you trust any of it, and §9 for what the
free tiers do and do not cover.

---

## 1. Method and limits

- Reviewed `scripts/db-backup.mjs`, `scripts/db-backup-lib.mjs`,
  `scripts/db-restore.mjs`, `docs/database-backup-restore.md`,
  `docs/neon-backup-restore-runbook.md`, `src/db/pool.ts`, `src/db/migrate.ts`,
  `src/db/schema.ts`, `src/db/migrations/`, `package.json`, `vercel.json`,
  `.github/`, `.gitignore`.
- **No database connection was opened.** No credentials were read, printed or
  used. Row counts, dump size and actual row-level content are therefore
  *unknown* in this report, and are marked as such rather than estimated.
- Provider-side settings (PITR, scheduled backups, retention) **cannot be
  verified from this repository.** §2.4 lists exactly what evidence is needed.
- Nothing was executed against production.

---

## 2. Audit findings

### 2.1 What database is backed up

A **Postgres** database reached through `DATABASE_URL` (falling back to
`POSTGRES_URL`). Per `docs/database-backup-restore.md` and
`docs/SUPABASE_MIGRATION.md`, production runs on **Supabase**; the Neon runbook
is retained as historical. `src/db/pool.ts` documents Supabase's pooler
explicitly (port 6543, self-signed leaf certificate).

Schema shape at the time of this audit:

| Fact | Value |
|---|---|
| Public tables | 19 (`users`, `game_plays`, `user_stats`, `chess_games`, `dice_*`, `pool_player_stats`, `email_events`, …) |
| Drizzle migrations | 238 |
| `src/db/schema.ts` | 4,602 lines |
| Migration journal | `drizzle.__drizzle_migrations` (Drizzle 0.45.2 default), tracked by `src/db/migrations/meta/_journal.json` |

### 2.2 How the current backup works

`scripts/db-backup.mjs` builds a **logical dump** using the `pg` driver already
in the project — no `pg_dump`, no `psql`, no Docker. It emits one plain-SQL file
containing enums, sequences, tables, constraints, indexes, `INSERT` data in
foreign-key order, and `setval()` realignment, wrapped in `BEGIN…COMMIT`.

The restore tool is `scripts/db-restore.mjs`: applies that file in one
transaction, optionally `--reset-schema` (destructive), optionally
`--verify-source=<url>` to compare per-table row counts.

What exists around it:

| Concern | Today |
|---|---|
| Schedule | **None.** No GitHub Action, no Vercel cron, no systemd timer runs `db:backup`. The four Vercel crons are app routes only. |
| Destination | **None.** Default output is `./backups/grynd-YYYY-MM-DD.sql`, relative to the working directory — the production VM if run there. |
| Off-VM copy | **None.** |
| Encryption of the artifact | **None.** Plain SQL. |
| Compression | **None.** |
| Integrity record | **None.** No sha256, no manifest written alongside the dump. |
| Retention / deletion | **None.** Files accumulate until deleted by hand. |
| Restore-test record | **None.** `--verify-source` prints to a terminal and exits; nothing is stored. |
| Access control | Whoever can read `backups/` on the host. |
| Git exposure | Good: `.gitignore` line 101–102 ignores `/backups/`. (Only that literal path — `-o=` elsewhere is not covered.) |

### 2.3 Findings, ranked

| # | Severity | Finding | Evidence |
|---|---|---|---|
| F1 | **High** | **The dump is not migration-complete.** It only reads `schemaname = 'public'`. The Drizzle journal lives in `drizzle.__drizzle_migrations`, so the `tablename <> '__drizzle_migrations'` filter is a no-op and the `drizzle` schema is never dumped. A restored database has full schema and data but **no migration history**, so `npm run db:migrate` (`src/db/migrate.ts`) would replay all 238 migrations onto an already-current schema and fail on the first `CREATE TYPE`/`CREATE TABLE`. | `scripts/db-backup.mjs:96,107,145,192,219,308`; `node_modules/drizzle-orm/pg-core/dialect.js:45-54` |
| F2 | **High** | **TLS certificate verification is disabled** on every path that touches production data: `rejectUnauthorized: false` in the backup script, the restore script, the migration check, and `src/db/pool.ts`. The release gate (`deploy/production-fixes.json`) checks **only** `src/db/pool.ts`, so the backup scripts could keep this indefinitely without failing a release. | `scripts/db-backup.mjs:64`, `scripts/db-restore.mjs:61`, `scripts/db-migrate-check.mjs:27`, `src/db/pool.ts:84` |
| F3 | **High** | **No off-VM copy exists or is configured.** The only possible artifact is a file on the VM being backed up. Losing the VM loses the database and every backup of it. | §2.2 |
| F4 | **High** | **No schedule.** Backups are entirely manual, so the real recovery point objective is "whenever someone last remembered". | §2.2 |
| F5 | **Medium** | **Verification compares against live production** rather than against a record captured at dump time. `--verify-source` re-reads the source, so any write between dump and verification appears as a mismatch — and a genuine corruption can be masked by coincidental counts. | `scripts/db-restore.mjs` (§ `--verify-source`) |
| F6 | **Medium** | **The whole dump is buffered in memory** (`lines[]`, then `join("\n")`), roughly 2× the dump size at peak. On a small VM a multi-GB database fails here — after a long read, with no artifact. | `scripts/db-backup.mjs` main block |
| F7 | **Medium** | **The docs point the dump at the transaction pooler** (port 6543) while the tool holds one connection open for hundreds of sequential queries. Poolers recycle and time out under exactly that pattern. A full logical dump should use the direct/non-pooling connection. | `docs/database-backup-restore.md` (backup example) |
| F8 | **Medium** | **The artifact is plaintext PII.** `users` carries `email`, `name`, `phone` and `password` (hash). A dump of it is a credential-adjacent dataset with no encryption at rest beyond whatever the disk provides. | `src/db/schema.ts` (`users`) |
| F9 | **Low** | **No integrity artifact.** Nothing records the dump's sha256, size or table counts, so a truncated or half-written file is indistinguishable from a good one until a restore fails. | §2.2 |
| F10 | **Low** | **Sequences lose `OWNED BY`.** `CREATE SEQUENCE IF NOT EXISTS` is emitted without ownership; `setval()` realignment is included and does work, but dropped-column semantics differ. | `scripts/db-backup.mjs:96-104` |

### 2.4 Provider-managed protection — unverified

`docs/database-backup-restore.md` states that Supabase offers PITR (paid plans;
free tier ~1 day), optional scheduled backups, and zero-copy branches. **That is
documentation, not evidence that any of it is enabled on your project.** I have
no access to the Supabase dashboard and will not claim otherwise.

To close this, capture from the Supabase dashboard:

1. Project → **Database → Backups**: is PITR shown as enabled, and what is the
   stated retention window?
2. The **plan tier** (it determines whether PITR is available at all).
3. Whether any **scheduled backup** is listed, with its cadence and last run.
4. Whether **branches** are available on this plan (the drill in §7 prefers one).

Record the answers next to this document. Until then, the honest statement is:
*provider-managed recovery is unknown; the only protection we can reason about
is the logical dump, and it is currently unscheduled and off-VM-less.*

---

## 3. What is in the data

A dump contains real user data. From `src/db/schema.ts`:

- `users`: `email`, `name`, `phone`, `password` (hash), admin flags, balance-bearing fields
- `game_plays`, `*_games`, `*_matches`: full play history
- `email_events`: recipient addresses and message metadata
- `user_automation_state`, `user_secret_stats`: per-user behaviour

Some fields are application-encrypted (`src/lib/security/fieldEncryption.ts`,
used by reports), which means the dump contains ciphertext for those and
plaintext for everything else. **Do not treat the dump as low-sensitivity.** It
must be encrypted, access-controlled, retained deliberately and deleted on a
schedule.

---

## 4. Recommended destination

### 4.1 Requirement restated

Off-VM, no additional recurring cost if a genuinely suitable option exists, no
assumption that storage/bandwidth/API calls are free, never the only copy on the
VM, never GitHub or a deployment artifact, least-privilege credentials, no
secret values in logs.

### 4.2 Options, with verified limits

Figures below were checked against vendor pages in October 2026. Re-check before
committing — free tiers change.

| Option | Free allowance | Beyond the allowance | Survives VM loss? | Notes |
|---|---|---|---|---|
| **Oracle Cloud Object Storage** (same tenancy as the VM) | **20 GB total**, combined across Standard / Infrequent Access / Archive tiers; **50,000 Object Storage API requests/month**; no expiry | Standard storage billed per GB-month; egress beyond the tenancy's free outbound allowance billed | **Yes** — regional object storage is independent of the compute instance | No new vendor, no new account, no new billing relationship. Oracle's own Always Free documentation states the 20 GB combined figure (some material splits it 10 GB object + 10 GB archive; the combined total is 20 GB either way). |
| **Cloudflare R2** | **10 GB-month** storage, **1 M Class A** + **10 M Class B** operations/month, **zero egress** | $0.015/GB-month storage; Class A $4.50/million | Yes | Best egress terms of any option; requires a Cloudflare account and an API token. |
| **Backblaze B2** | **First 10 GB** storage free; egress free up to **3× stored** per month | ~$6.95/TB-month (~$0.00695/GB); egress ~$0.01/GB beyond 3× | Yes | Requires a Backblaze account. |
| **AWS S3** | Introductory, **time-limited** free tier — not recurring | Full S3 pricing | Yes | **Not a zero-recurring-cost answer.** Excluded on that basis. |
| Supabase Storage | Included with the Supabase plan | Plan-dependent | Survives VM loss | Same vendor as the database: it does **not** survive loss of the Supabase project. Useful as a convenience copy, not as the off-site backup. |
| GitHub Releases / Actions artifacts | — | — | — | **Forbidden by the brief**, and wrong: artifacts expire and the repo is not a backup store. |

### 4.3 Recommendation

**Primary: Oracle Cloud Object Storage in the existing tenancy.**

Why: 20 GB always-free is ample for compressed dumps at a realistic retention
depth (§9), 50,000 API calls/month is roughly three orders of magnitude more
than a daily job needs, it survives loss of the VM, and it introduces no new
vendor, account, payment method or credential store. The VM can authenticate
with an **instance principal**, so **no long-lived credential has to sit on
disk at all** — the strongest least-privilege option available here.

**Optional second copy: Cloudflare R2** (10 GB free, zero egress), one object
per week, for one specific risk the primary cannot cover: loss of the Oracle
tenancy itself. This is a real risk and worth naming, but it is a second
integration; do it only if you accept a second vendor account.

**What this does not protect against:** loss of the Oracle account/tenancy,
loss of the encryption key, or a backup job that has been silently failing.
The last one is why §6 exists.

---

## 5. Proposed backup pipeline (design only — not built, not enabled)

```
 systemd timer (daily, randomised)
        │
        ▼
 db-backup.mjs  ──► dump.sql ──► gzip ──► AES-256-GCM ──► sha256 ──► PUT object
   (read-only,              (client-side, key outside the VM)          │
    non-pooling                                                         ▼
    connection)                                          OCI bucket: grynd-backups/
        │                                                  backups/2026-10-26T03-15Z.sql.gz.enc
        │                                                  manifest/2026-10-26T03-15Z.json
        └──► append record to state/backup/ledger.jsonl ──► Control Center (§6)
```

Design decisions and the reasons:

1. **Change the dump before scheduling it.** F1 and F2 must be fixed first:
   either include the `drizzle` schema (preferred) or emit a synthetic journal
   entry that reproduces the applied-migration set. A restore that cannot be
   migrated is not a recovery.
2. **Direct connection, not the pooler** (F7): `POSTGRES_URL_NON_POOLING` or
   port 5432, with a statement timeout so a hung query cannot wedge the timer.
3. **Stream to disk, don't buffer** (F6): write statements as they are produced.
   This is a small change to the script and removes the OOM failure mode.
4. **Compress, then encrypt client-side.** gzip via Node's `zlib` (no new
   dependency), then AES-256-GCM with a key stored **outside the VM** — in a
   password manager or your own secret store. Encryption at rest by the provider
   does not help if the VM itself is compromised, because the key would be
   compromised with it. Record the IV and auth tag in the manifest.
5. **Manifest per artifact**, written next to it and mirrored in the ledger:
   `{ id, at, bytesCiphertext, sha256Ciphertext, sha256Plaintext, tables: {name: rowCount}, schemaVersion, commit, durationMs }`.
   Capturing row counts **at dump time** fixes F5 — verification later compares
   against this record, not against a live, moving database.
6. **Least privilege:** an OCI policy granting the instance principal
   `OBJECT_CREATE`/`OBJECT_OVERWRITE` on one bucket prefix, plus read for the
   drill. No list-all, no delete-everything, no tenancy-wide rights. If a
   credential is used instead, it is scoped to the bucket and stored `0600`
   outside `releases/`.
7. **No secrets in logs.** The job logs object keys, byte counts, durations and
   exit codes only. Never the DSN, never the key, never a row value.
8. **Retention by lifecycle rule** in the bucket (e.g. delete objects under
   `backups/` older than 30 days), mirrored by the same rule in the job. Two
   independent statements of the same policy is deliberate — a job that stops
   running must not turn into unbounded storage.
9. **Fail loudly.** A non-zero exit appends `backup.failed` to the ledger, which
   is what turns the Control Center red. A silent failure is the main way
   backup systems die.

Scheduling mechanism: a **systemd timer** on the VM (`OnCalendar=*-*-* 03:15`,
`RandomizedDelaySec=900`, `Persistent=true` so a missed run fires after reboot),
with a lock so two runs cannot overlap. Not enabled in this phase.

---

## 6. Control Center integration (implemented, read-only)

Added in this phase:

- `deploy/lib/backup/status.mjs` — reads `<root>/state/backup/ledger.jsonl` and
  builds the status view. It reads one file and nothing else: no database
  connection, no credential, no network call unless a destination adapter is
  explicitly supplied.
- `deploy/ops.mjs backup` (and the `backup.status` broker action) — the
  dashboard's data source, alongside the existing `status`, `config` and
  `audit` actions.

### 6.1 What the page shows

| Page element | Field | Notes |
|---|---|---|
| Last successful backup | `lastSuccess.at`, `.id` | `null` → renders "never" |
| Last failed backup | `lastFailure.at`, `.code`, `.message` | message is redacted |
| Backup size | `size.bytes`, `size.human` | from the newest successful record |
| Backup age | `age.hours`, `age.stale` | stale after 36 h (1.5× daily cadence) |
| Retention status | `retention.backupsInWindow`, `.gaps`, `.withinPolicy` | 30-day window |
| Destination health | `destination.state` — `ok` / `unreachable` / `unknown` / `not_configured` | `unknown` when no probe is wired |
| Most recent restore test | `restoreTest.*` | pass/fail, age, target, mismatches |
| Warnings | `warnings[]` with `severity` | critical = page is not green |

### 6.2 Exists vs verified

The brief's key distinction is a field, not a colour:

```
verified === true
  ⟺ a completed restore test exists
  ∧ it recorded the SAME sha256 as the newest backup
  ∧ it had zero row-count mismatches
  ∧ its target was scratch | branch | local | staging   (never production)
```

So:

- `evidence: "none"` — no ledger at all. Nothing is claimed.
- `evidence: "metadata-only"` — a backup exists and was uploaded, but its
  restore has not been proven. **This is the normal state on day one** and the
  page must say so plainly.
- `evidence: "restore-verified"` — the newest artifact has been restored
  successfully into an isolated target.

A restore of last week's dump does **not** verify today's; the page emits
`RESTORE_TEST_NOT_CURRENT`. A restore *into production* is not a drill and emits
`RESTORE_TEST_ON_PRODUCTION`, which is critical.

### 6.3 Why the ledger is a file and not a database table

The status page must work when the database is the thing that is broken. A
ledger in Postgres would be unavailable exactly when it is needed. The file is
append-only JSONL under `state/backup/`, alongside the operations audit, and the
record schema is documented at the top of `status.mjs`.

### 6.4 What the page cannot tell you

It reports what the ledger records and what one probe observes. It cannot prove
a backup is restorable — only a drill does that. Every response carries a
`disclosure` string saying so, and the page should render it.

---

## 7. Recovery drill — design (NOT executed)

Nothing in this section has been run. It is written down first, so the criteria
are fixed before anyone is tempted to declare a drill successful.

### 7.1 Rules

1. **Never restore over production.** No `--reset-schema` against the production
   DSN, ever, including during an incident. Restore to an isolated target, verify,
   then decide.
2. **The target must be isolated**: a Supabase branch, a scratch project, or a
   local Postgres. Record which one in the ledger's `target` field.
3. **The drill must not need production credentials** beyond reading the
   artifact. If verification requires querying production, capture those numbers
   at dump time instead (§5.5).
4. **Time-box it.** If the drill is not finished in 90 minutes, stop, record the
   blocker and fix the runbook. A recovery process that needs a day is a finding.
5. **Delete the scratch target and any local artifact copy afterwards.** The
   scratch database contains the same PII.

### 7.2 Steps

| # | Step | Pass criterion |
|---|---|---|
| 1 | Select the newest artifact and its manifest | Both present; `sha256Ciphertext` matches a recomputation |
| 2 | Decrypt and decompress to a temp path with `0600` | Auth tag validates; plaintext sha256 matches the manifest |
| 3 | Provision the isolated target | Target records as `scratch` / `branch` / `local`; **not** production |
| 4 | Restore with `scripts/db-restore.mjs <file>` (no `--reset-schema` needed on an empty target) | Process exits 0; transaction committed |
| 5 | Compare per-table row counts to the **manifest**, not to live production | Zero mismatches across all captured tables |
| 6 | Verify schema completeness | All 19 expected tables, enums, constraints and indexes exist; no missing column |
| 7 | Verify migration state (F1) | `drizzle.__drizzle_migrations` present and its newest hash matches the deployed commit's journal |
| 8 | Verify sequences | For each serial/identity column, `last_value >= max(id)`; an insert in the scratch DB succeeds without a PK collision |
| 9 | Boot the app against the target | `GET /api/health` → `{"ok":true,"db":"ok"}` |
| 10 | Data spot-check **without extracting PII** | Aggregate checks only: user count, sum of balances, a hash of 100 sample ids — compared to the manifest, not printed |
| 11 | Record the outcome | `restore.verified` (or `restore.failed` with a code) appended to the ledger |
| 12 | Clean up | Scratch target deleted; temp files removed; ledger is the only residue |

### 7.3 Abort criteria

Stop and record a failure — do not proceed to a production restore — if any of:

- ciphertext or plaintext sha256 does not match the manifest;
- any table's row count differs from the manifest;
- a table, column, enum, constraint or index is missing;
- the migration journal is absent or its newest hash is older than the
  deployed commit (this is F1 occurring in practice);
- a sequence would collide on insert;
- the app cannot reach the restored database.

### 7.4 Cadence

Quarterly, and **immediately after** any of: a schema change touching money or
identity, a provider change, a restore-tool change, or a failed backup that
required intervention. The status page reports drill age and warns past 90 days.

---

## 8. Restore verification — what "verified" must mean

Row counts alone are a weak test: they miss wrong values, wrong types, silently
truncated text, and reordered sequences. The manifest from §5.5 makes a stronger
check possible without touching production:

- per-table row count, captured at dump time;
- sha256 of the plaintext dump (integrity of the artifact itself);
- schema version (commit + newest applied migration hash);
- sequence high-water marks;
- optional column-level aggregates for high-value tables (sum of balances,
  count of distinct users) — never raw PII.

If a stronger guarantee is needed later, the next step is per-table content
hashes over a deterministic ordering, which turns "same number of rows" into
"same rows". That is a larger change and is not proposed for v1.

---

## 9. Costs and free-tier limits, honestly

### 9.1 Option A — OCI Object Storage (recommended)

| Item | Allowance | What we would use |
|---|---|---|
| Storage | 20 GB total, combined Standard/IA/Archive | Compressed, encrypted daily dumps × retention depth (§9.3) |
| API requests | 50,000/month | ~2–4 per run (PUT object, PUT manifest, occasional GET) → ~120/month at one run/day |
| Egress | Within the tenancy's free outbound allowance | A restore reads one artifact: hundreds of MB at most |
| Recurring cost | **$0 while inside the allowance** | — |

### 9.2 Option B — Cloudflare R2 (secondary copy)

| Item | Allowance | Notes |
|---|---|---|
| Storage | 10 GB-month free, then $0.015/GB-month | One weekly copy fits comfortably |
| Operations | 1 M Class A + 10 M Class B/month free | Weekly copy is negligible |
| Egress | **$0 at any volume** | Best terms for restoring in a hurry |

### 9.3 What could exceed a free tier

- **Dump size is unknown.** It has never been measured. 19 tables including
  `game_plays` could be anywhere from tens of MB to multiple GB. **Measure the
  first dump before fixing retention depth**, and re-measure monthly.
- **Retention depth × size.** 30 daily + 12 weekly copies multiplies whatever
  the dump is. At 200 MB compressed that is ~8.4 GB — inside 20 GB. At 2 GB it
  is ~84 GB and the free tier is gone. This is the number that decides the plan.
- **Versioning or object lock**, if enabled, retains every version and counts
  against storage.
- **Failed multipart uploads** leave hidden parts that bill as storage.
- **Restore egress in a real disaster** — small (one artifact), but not zero on
  providers that charge for it.
- **Unbounded growth of `game_plays`** pushes storage steadily upward.

### 9.4 Not free, stated plainly

AWS S3's free tier is time-limited and is not a permanent answer. If the free
allowances turn out to be too small, the honest options are R2 at ~$0.015/GB-month
or OCI at standard rates — both are cheap at realistic sizes, but they are not
zero, and this document will not pretend otherwise.

---

## 10. Approval gates

Nothing below is done. Each gate is separately approvable.

- [ ] **G1 — Confirm the destination.** OCI bucket in the existing tenancy
      (recommended), optionally plus R2 for the weekly copy.
- [ ] **G2 — Provider evidence.** Fill in §2.4 from the Supabase dashboard.
- [ ] **G3 — Approve the dump changes.** Fix F1 (migration journal), F2 (TLS
      verification), F6 (streaming), F7 (direct connection). No schedule runs
      before these land.
- [ ] **G4 — Confirm key custody.** Where the encryption key lives, who can
      retrieve it, and what happens if it is lost (answer: the backups are gone —
      this must be deliberate).
- [ ] **G5 — Approve retention depth** after measuring the first dump.
- [ ] **G6 — Approve the schedule** (systemd timer, daily 03:15 + jitter).
- [ ] **G7 — Run the drill in §7 on an isolated target** and record the result.
- [ ] **G8 — Only then** wire the destination probe into the Control Center and
      treat `verified: true` as meaningful.

---

## 11. Open decisions

1. **Destination** (§4.3): OCI alone, or OCI + R2 for account-level risk?
2. **PITR**: is Supabase PITR actually enabled, and on which plan? If it is,
   it changes the recovery point objective — but it still does not survive
   project loss, so it does not remove the need for an off-site dump.
3. **Migration journal** (F1): include the `drizzle` schema in the dump
   (preferred, ~10 lines) or write a synthetic journal record? The first is
   strictly more faithful.
4. **Dump size and retention** (§9.3) — decide after the first measurement.
5. **Encryption key custody** (§10 G4) — this is the one operational decision
   that cannot be postponed to an incident.
6. **TLS fix scope** (F2): fix `scripts/db-backup.mjs` and
   `scripts/db-restore.mjs` only, or also extend
   `deploy/production-fixes.json` so a future PR cannot reintroduce
   `rejectUnauthorized: false` in the backup path? The second is the durable fix.

---

## 12. What changed in the repository

| File | Change |
|---|---|
| `deploy/lib/backup/status.mjs` | New — read-only status collector and ledger reader |
| `deploy/lib/ops/execute.mjs` | Adds a read-only `backup()` method to the runtime |
| `deploy/ops.mjs` | Adds the `backup` command and `backup.status` broker action |
| `deploy/tests/backup-status.test.mjs` | New — 23 tests |
| `deploy/tests/ops.test.mjs` | 2 broker tests for backup status |
| `docs/backup-recovery-readiness.md` | This document |

Not changed: `scripts/db-backup.mjs`, `scripts/db-restore.mjs`, any credential,
any Supabase setting, any schedule. The dump fixes in §5 are proposed, not
applied, because they change backup semantics and belong behind G3.
