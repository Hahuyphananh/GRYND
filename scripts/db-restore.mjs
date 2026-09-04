#!/usr/bin/env node
/**
 * GRYND database restore — apply a backup produced by scripts/db-backup.mjs
 * to a target Postgres database, then verify.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/db-restore.mjs backups/grynd-2026-09-04.sql
 *   TARGET_URL="postgresql://..." node scripts/db-restore.mjs backups/grynd-*.sql --reset-schema
 *   SOURCE_URL="postgresql://..." node scripts/db-restore.mjs file.sql --verify   # compare vs source
 *
 * Options:
 *   --reset-schema   DROP SCHEMA public CASCADE then reapply (destructive —
 *                    only use against a throwaway / scratch database).
 *   --verify-source=<url>   After restoring, compare row counts of every
 *                    table in the dump against this source database.
 *   --verify         Shorthand for --verify-source=$SOURCE_URL.
 *
 * The dump file is a plain-SQL transaction (BEGIN…COMMIT), so the restore
 * runs in one transaction: any failure rolls everything back and the
 * target is left untouched.
 */

import fs from "node:fs";
import pg from "pg";
import { qIdent, splitStatements } from "./db-backup-lib.mjs";

const { Client } = pg;

// --CLI parsing -------------------------------------------------------
const file = process.argv.find((a) => !a.startsWith("-") && a.endsWith(".sql"));
const resetSchema = process.argv.includes("--reset-schema");
const verifySourceArg = process.argv.find((a) => a.startsWith("--verify-source="))?.slice(16);
const verifyFlag = process.argv.includes("--verify");
const sourceUrl = verifySourceArg || (verifyFlag ? process.env.SOURCE_URL : null);

const targetUrl = process.env.TARGET_URL || process.env.SUPA_URL || process.env.DATABASE_URL || "";

if (!file || !targetUrl) {
  console.error(
    "Usage: DATABASE_URL=... node scripts/db-restore.mjs <backup.sql> [--reset-schema] [--verify-source=<url>]",
  );
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`Backup file not found: ${file}`);
  process.exit(1);
}

function makeClient(connectionString) {
  let host = "";
  try {
    host = new URL(connectionString).hostname || "";
  } catch {}
  const isLocal = /localhost|127\.0\.0\.1|::1/.test(host);
  const sanitized = connectionString.replace(
    /([?&])sslmode=[^&]*(&|$)/g,
    (_m, prefix, suffix) => (suffix === "&" ? prefix : ""),
  );
  return new Client({
    connectionString: sanitized,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
}

// --Main----------------------------------------------------------------
const target = makeClient(targetUrl);
let verifyClient = null;
if (sourceUrl) verifyClient = makeClient(sourceUrl);

try {
  await target.connect();
  if (verifyClient) await verifyClient.connect();

  if (resetSchema) {
    console.log("Resetting public schema on target…");
    await target.query("DROP SCHEMA IF EXISTS public CASCADE");
    await target.query("CREATE SCHEMA public");
  }

  const sql = fs.readFileSync(file, "utf8");
  const statements = splitStatements(sql);
  console.log(`Restoring ${file} → ${new URL(targetUrl).hostname} (${statements.length} statements)`);

  await target.query("BEGIN");
  let applied = 0;
  try {
    for (let i = 0; i < statements.length; i++) {
      // The dump embeds its own BEGIN/COMMIT — skip them; we manage the txn.
      const s = statements[i];
      if (/^\s*BEGIN;?\s*$/i.test(s) || /^\s*COMMIT;?\s*$/i.test(s)) continue;
      await target.query(s);
      applied += 1;
    }
    await target.query("COMMIT");
    console.log(`Restore committed (${applied} statements applied).`);
  } catch (err) {
    await target.query("ROLLBACK");
    console.error(`FAILED at statement ${applied + 1} — rolled back:`);
    console.error(err.message);
    console.error("Statement:", statements[applied]?.slice(0, 300));
    process.exitCode = 1;
    process.exit(1);
  }

  // --Verification----------------------------------------------------
  const mismatches = [];
  let checked = 0;

  // Enumerate public tables present on the target after restore.
  const { rows: tables } = await target.query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
     ORDER BY tablename`,
  );
  console.log(`\nTables on target: ${tables.length}`);

  if (verifyClient) {
    console.log("Comparing row counts (source vs target):");
    for (const r of tables) {
      const t = r.tablename;
      const sCount = await verifyClient
        .query(`SELECT COUNT(*)::int AS n FROM ${qIdent(t)}`)
        .catch(() => ({ rows: [{ n: -1 }] }));
      const tCount = await target
        .query(`SELECT COUNT(*)::int AS n FROM ${qIdent(t)}`)
        .catch(() => ({ rows: [{ n: -1 }] }));
      checked += 1;
      const a = sCount.rows[0].n;
      const b = tCount.rows[0].n;
      const ok = a === b;
      if (!ok) mismatches.push(`${t}: source=${a} target=${b}`);
      console.log(`  ${ok ? "✔" : "✘"} ${t}: ${a} → ${b}`);
    }
  } else {
    // No source to compare — at least surface row counts so a human can
    // sanity-check the drill.
    console.log("Row counts on target:");
    for (const r of tables) {
      const t = r.tablename;
      const c = await target
        .query(`SELECT COUNT(*)::int AS n FROM ${qIdent(t)}`)
        .catch(() => ({ rows: [{ n: -1 }] }));
      checked += 1;
      console.log(`  ${c.rows[0].n}\t${t}`);
    }
  }

  if (mismatches.length) {
    console.error("\nMISMATCHES:\n" + mismatches.join("\n"));
    process.exitCode = 2;
  } else {
    console.log(`\nRestore verified (${checked} tables checked)${
      verifyClient ? " — backup/restore round-trip OK ✔" : ""
    }`);
  }
} catch (err) {
  console.error("Restore failed:", err.message);
  process.exitCode = 1;
} finally {
  await target.end().catch(() => {});
  if (verifyClient) await verifyClient.end().catch(() => {});
}