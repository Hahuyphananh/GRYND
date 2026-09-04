/**
 * Backfill: encrypt existing plaintext sensitive columns at rest.
 *
 * Encrypts every row that predates field-level encryption (i.e. values NOT
 * already prefixed with `enc:v1:`) in:
 *
 *   * contact_messages.message
 *   * contact_message_replies.reply
 *   * player_reports.details
 *
 * Runs against the shared Postgres pool (DATABASE_URL / POSTGRES_URL, loaded
 * from .env or .env.local like the rest of the app). Idempotent: rows whose
 * value already starts with `enc:v1:` are skipped, so re-running is safe.
 *
 * Usage:
 *   npm run backfill:field-encryption                 # real run
 *   npm run backfill:field-encryption -- --dry-run    # count only, no writes
 *   npm run backfill:field-encryption -- --table player_reports
 *
 * REQUIRED: FIELD_ENCRYPTION_KEY must be set (same value the app uses) —
 * the script exits 1 without it. Decryption/display never needs to run for
 * this to work; the app reads back through decryptFieldSafe().
 */

import dotenv from "dotenv";
import { pathToFileURL } from "node:url";
import { getNeonSql } from "../src/db/neon.ts";
import { encryptField } from "../src/lib/security/fieldEncryption.ts";

// Local secrets live in .env.local (gitignored); load .env as a fallback and
// let .env.local win when both exist.
dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const KEY_ENV = "FIELD_ENCRYPTION_KEY";
const PREFIX = "enc:v1:";

// Column names come from this fixed allowlist only — never from user input —
// so string interpolation is safe.
const TARGETS = [
  { table: "contact_messages", column: "message", nullable: false },
  { table: "contact_message_replies", column: "reply", nullable: false },
  { table: "player_reports", column: "details", nullable: true },
];

function parseFlags(argv) {
  const flags = {
    dryRun: argv.includes("--dry-run"),
    only: null,
    batchSize: 500,
  };
  const onlyIdx = argv.indexOf("--table");
  if (onlyIdx !== -1 && argv[onlyIdx + 1]) flags.only = argv[onlyIdx + 1];
  const batchIdx = argv.indexOf("--batch");
  if (batchIdx !== -1 && argv[batchIdx + 1]) {
    const n = Number(argv[batchIdx + 1]);
    if (Number.isFinite(n) && n > 0) flags.batchSize = Math.min(n, 5000);
  }
  return flags;
}

async function backfillTable(sql, { table, column, nullable }, flags) {
  const whereClause = nullable
    ? `${column} IS NOT NULL AND ${column} NOT LIKE '${PREFIX}%'`
    : `${column} NOT LIKE '${PREFIX}%'`;

  let cursor = 0;
  let updated = 0;
  let scanned = 0;
  // Keep going until a batch comes back short (means we've reached the end).
  for (;;) {
    const rows = await sql.query(
      `SELECT id, ${column} AS val FROM ${table} ` +
        `WHERE id > $1 AND ${whereClause} AND ${column} <> '' ` +
        `ORDER BY id ASC LIMIT $2`,
      [cursor, flags.batchSize],
    );

    if (!rows || rows.length === 0) break;
    scanned += rows.length;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      if (flags.dryRun) continue;
      const ciphertext = encryptField(row.val);
      if (ciphertext === null) continue; // defensive; '' already filtered
      await sql.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [
        ciphertext,
        row.id,
      ]);
      updated += 1;
    }

    if (rows.length < flags.batchSize) break;
    if (updated % 500 === 0 && !flags.dryRun) {
      console.log(`  ${table}: ${updated} rows encrypted so far…`);
    }
  }

  return { table, scanned, updated };
}

async function run() {
  const flags = parseFlags(process.argv.slice(2));

  if (!process.env[KEY_ENV]) {
    console.error(
      `[backfill] ${KEY_ENV} is not set. ` +
        `Set it to the same base64 32-byte key the app uses ` +
        `(openssl rand -base64 32) — the script refuses to run without it.`,
    );
    process.exit(1);
  }

  const targets = flags.only
    ? TARGETS.filter((t) => t.table === flags.only)
    : TARGETS;
  if (targets.length === 0) {
    console.error(`[backfill] Unknown --table "${flags.only}".`);
    process.exit(1);
  }

  console.log(
    `[backfill] ${flags.dryRun ? "DRY-RUN (no writes)" : "ENCRYPTING"}…`,
  );
  for (const t of targets) {
    console.log(`[backfill] target: ${t.table}.${t.column}`);
  }

  const sql = getNeonSql();
  const summary = [];
  for (const target of targets) {
    const result = await backfillTable(sql, target, flags);
    summary.push(result);
    console.log(
      `[backfill] ${result.table}: ${result.scanned} plaintext row(s) ` +
        `${flags.dryRun ? "would be" : "encrypted →"} ${result.updated}`,
    );
  }

  const total = summary.reduce((acc, r) => acc + r.scanned, 0);
  console.log(`[backfill] done — ${total} row(s) processed.`);
  if (flags.dryRun) {
    console.log("[backfill] Re-run without --dry-run to write.");
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  run().catch((err) => {
    console.error("[backfill] Failed:", err);
    process.exit(1);
  });
}

export { TARGETS };
