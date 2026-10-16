#!/usr/bin/env node
/**
 * Re-sync every public-schema sequence to its owning table's MAX(id).
 *
 * WHY THIS EXISTS
 * ----------------
 * The Neon → Supabase data migration (scripts/migrate-data.mjs) copies rows
 * with explicit ids, then calls fixSequences() to bump each sequence past
 * the highest existing id. That step relied on pg_get_serial_sequence(),
 * which returns NULL when the sequence→column dependency (pg_depend 'a'
 * entry / OWNED BY) is missing — exactly the state produced by the schema
 * dump/restore. So it silently fixed NOTHING: every serial column kept its
 * fresh-install value (1 or 2) while the table already held hundreds of
 * rows. The next INSERT then collided with an existing primary key
 * (duplicate key value violates unique constraint "..._pkey"), 500ing
 * every game route that creates/joins a match or records a game.
 *
 * This script finds serial columns the resilient way — via the
 * information_schema nextval() default — and setval()s each sequence to
 * MAX(col). It is safe to run any number of times:
 *   * It only ever moves sequences FORWARD relative to MAX(col), never
 *     backward, so it can't re-introduce a collision.
 *   * Tables with no rows get nextval = 2 (setval(seq, 1, true)).
 *   * Orphaned sequences (no column references them) are skipped.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/fix-sequences.mjs
 * (reads DATABASE_URL from the environment, like the rest of the app)
 */
import "dotenv/config";
import pg from "pg";

const { Client } = pg;

async function main() {
  const connectionString =
    process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  if (!connectionString) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  // Mirror src/db/pool.ts: strip sslmode so the explicit ssl option wins
  // (Supabase pooler URLs carry sslmode=require, which pg would treat as
  // verify-full and reject the pooler's self-signed leaf cert).
  const sanitized = connectionString.replace(
    /([?&])sslmode=[^&]*(&|$)/g,
    (_m, prefix, suffix) => (suffix === "&" ? prefix : ""),
  );
  let host = "";
  try {
    host = new URL(sanitized).hostname || "";
  } catch {
    /* not a parseable URL — treat as local */
  }
  const isLocal = /localhost|127\.0\.0\.1|::1/.test(host);

  const client = new Client({
    connectionString: sanitized,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  // Every public column whose default pulls from a sequence.
  const { rows: serialCols } = await client.query(`
    SELECT table_schema, table_name, column_name, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_default LIKE 'nextval(%'
    ORDER BY table_name, ordinal_position
  `);

  console.log(`Found ${serialCols.length} serial column(s).`);

  let fixed = 0;
  const fixes = [];
  for (const col of serialCols) {
    const seqMatch = col.column_default.match(
      /nextval\('([^']+)'::regclass\)/,
    );
    if (!seqMatch) continue;
    const seqName = seqMatch[1];

    // Guard: skip orphaned sequences whose owning table no longer exists.
    const tableExists = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [col.table_schema, col.table_name],
    );
    if (tableExists.rowCount === 0) {
      console.log(
        `  - ${col.table_name}.${col.column_name}: table missing, skipped`,
      );
      continue;
    }

    const colExists = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [col.table_schema, col.table_name, col.column_name],
    );
    if (colExists.rowCount === 0) {
      console.log(
        `  - ${col.table_name}.${col.column_name}: column missing, skipped`,
      );
      continue;
    }

    // setval(seq, MAX(col) or 1, true) → first nextval = MAX(col) + 1.
    // Empty tables start at nextval = 2 (harmless, no rows). Only ever
    // moves the sequence forward relative to existing rows.
    await client.query(
      `SELECT setval($1, COALESCE((SELECT MAX(${client.escapeIdentifier(
        col.column_name,
      )}) FROM ${client.escapeIdentifier(
        col.table_schema,
      )}.${client.escapeIdentifier(col.table_name)}), 1), true)`,
      [seqName],
    );
    fixes.push(`${col.table_name}.${col.column_name} → ${seqName}`);
    fixed++;
  }

  console.log(`Fixed ${fixed} sequence(s):`);
  for (const f of fixes) console.log(`  ✔ ${f}`);

  // ── Verification: re-scan nextval vs MAX(col) ─────────────────────────
  console.log("\nVerifying…");
  const { rows: after } = await client.query(`
    SELECT table_name, column_name, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'
  `);
  let bad = 0;
  for (const col of after) {
    const seqMatch = col.column_default.match(/nextval\('([^']+)'::regclass\)/);
    if (!seqMatch) continue;
    const seqName = seqMatch[1];
    const maxRes = await client
      .query(
        `SELECT COALESCE(MAX(${client.escapeIdentifier(
          col.column_name,
        )}), 0) AS m FROM ${client.escapeIdentifier(col.table_name)}`,
      )
      .catch(() => ({ rows: [{ m: null }] }));
    if (maxRes.rows[0].m === null) continue;
    const seqRes = await client.query(
      `SELECT last_value, is_called FROM "${seqName}"`,
    );
    const last = Number(seqRes.rows[0].last_value);
    const next = seqRes.rows[0].is_called ? last + 1 : last;
    const maxId = Number(maxRes.rows[0].m);
    if (next <= maxId) {
      bad++;
      console.log(
        `  ✘ ${col.table_name}.${col.column_name}: max=${maxId} nextval=${next}`,
      );
    }
  }
  if (bad) {
    console.error(`\n${bad} sequence(s) still out of sync!`);
    process.exitCode = 1;
  } else {
    console.log("All sequences in sync. ✔");
  }

  await client.end();
}

main().catch((err) => {
  console.error("fix-sequences failed:", err?.message);
  process.exit(1);
});
