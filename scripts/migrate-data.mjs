#!/usr/bin/env node
/**
 * Copy all public tables from a source Postgres database to a target one.
 *
 * Designed for the Neon → Supabase migration. Schema must already exist on
 * the target (run `npm run db:migrate` against the target first, or
 * drizzle-kit push). This script copies DATA ONLY, in foreign-key order,
 * fixes up sequences, and verifies row counts per table.
 *
 * Usage:
 *   NEON_URL="postgresql://..." SUPA_URL="postgresql://..." node scripts/migrate-data.mjs
 *
 * Optional: TABLE_FILTER="users,user_stats" to copy a subset.
 */
import pg from "pg";

const { Client } = pg;

const sourceUrl = process.env.NEON_URL || process.env.SOURCE_URL;
const targetUrl = process.env.SUPA_URL || process.env.TARGET_URL;
const tableFilter = process.env.TABLE_FILTER
  ? new Set(process.env.TABLE_FILTER.split(",").map((s) => s.trim()))
  : null;

if (!sourceUrl || !targetUrl) {
  console.error("Usage: NEON_URL=... SUPA_URL=... node scripts/migrate-data.mjs");
  process.exit(1);
}

function makeClient(url) {
  let host = "";
  try {
    host = new URL(url).hostname || "";
  } catch {}
  const isLocal = /localhost|127\.0\.0\.1|::1/.test(host);
  return new Client({
    connectionString: url,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
}

const source = makeClient(sourceUrl);
const target = makeClient(targetUrl);

async function listTables(client) {
  const { rows } = await client.query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename NOT LIKE 'pg_%' AND tablename <> '__drizzle_migrations'
     ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename).filter((t) => !tableFilter || tableFilter.has(t));
}

/** Topological order: parents (no FK) first, children last. */
async function orderByDependencies(client, tables) {
  const fk = await client.query(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
     FROM information_schema.table_constraints tc
     JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
  );
  const childrenOf = new Map();
  const parentsOf = new Map();
  for (const r of fk.rows) {
    if (r.parent === r.child) continue;
    if (!childrenOf.has(r.child)) childrenOf.set(r.child, new Set());
    childrenOf.get(r.child).add(r.parent);
    if (!parentsOf.has(r.parent)) parentsOf.set(r.parent, new Set());
    parentsOf.get(r.parent).add(r.child);
  }
  const remaining = new Set(tables);
  const ordered = [];
  let guard = 0;
  while (remaining.size && guard++ < tables.length * 2) {
    let progressed = false;
    for (const t of [...remaining]) {
      const deps = [...(childrenOf.get(t) || [])].filter((d) => remaining.has(d));
      if (deps.length === 0) {
        ordered.push(t);
        remaining.delete(t);
        progressed = true;
      }
    }
    if (!progressed) {
      // Cycle (rare, e.g. self-referencing) — dump the rest as-is.
      ordered.push(...remaining);
      remaining.clear();
    }
  }
  return ordered;
}

async function copyTable(client, table, tx) {
  const count = await client.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
  if (count.rows[0].n === 0) {
    console.log(`  ${table}: empty, skipped`);
    return 0;
  }

  const cols = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  const colNames = cols.rows.map((r) => r.column_name);
  const isJsonCol = new Set(
    cols.rows
      .filter((r) => r.data_type === "json" || r.data_type === "jsonb")
      .map((r) => r.column_name),
  );
  // pg serializes JS arrays as Postgres array literals, which json/jsonb
  // columns reject. Stringify any object/array value destined for a JSON
  // column (there are no true array-typed columns in this schema).
  const prep = (col, v) =>
    v !== null && isJsonCol.has(col) && typeof v === "object"
      ? JSON.stringify(v)
      : v;

  const BATCH = 500;
  let copied = 0;
  // Single-column primary key lets us page efficiently and correctly.
  // Composite or missing PK → fetch the whole table in one shot.
  const pk = await client.query(
    `SELECT a.attname, i.indkey FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = '"${table}"'::regclass AND i.indisprimary`,
  );
  const pkCol = pk.rows.length === 1 ? pk.rows[0].attname : null;

  const selectCols = colNames.map((c) => `"${c}"`).join(", ");
  const insertCols = selectCols;
  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(", ");

  let lastPk = null;
  while (true) {
    const where = lastPk != null && pkCol ? ` WHERE "${pkCol}" > ${lastPk}` : "";
    const q = `SELECT ${selectCols} FROM "${table}"${where} ORDER BY ${pkCol ? `"${pkCol}"` : "1"} LIMIT ${BATCH}`;
    const { rows } = await client.query(q);
    if (!rows.length) break;
    if (pkCol != null) lastPk = rows[rows.length - 1][pkCol];
    for (const row of rows) {
      await tx.query(
        `INSERT INTO "${table}" (${insertCols}) VALUES (${placeholders})
         ON CONFLICT DO NOTHING`,
        colNames.map((c) => prep(c, row[c])),
      );
    }
    copied += rows.length;
    if (rows.length < BATCH) break;
  }
  console.log(`  ${table}: ${copied} rows copied`);
  return copied;
}

async function fixSequences(client, tables) {
  for (const table of tables) {
    const seqs = await client.query(
      `SELECT pg_get_serial_sequence('"${table}"', a.attname) AS seq, a.attname
       FROM pg_attribute a
       WHERE a.attrelid = '"${table}"'::regclass
         AND pg_get_serial_sequence('"${table}"', a.attname) IS NOT NULL`,
    );
    for (const s of seqs.rows) {
      await client.query(
        `SELECT setval('${s.seq}', COALESCE((SELECT MAX("${s.attname}") FROM "${table}"), 1))`,
      );
    }
  }
}

await source.connect();
await target.connect();

try {
  const tables = await listTables(source);
  console.log(`Source tables (${tables.length}): ${tables.join(", ")}`);
  const ordered = await orderByDependencies(source, tables);

  console.log("Copy order:", ordered.join(" → "));

  let total = 0;
  for (const table of ordered) {
    try {
      await target.query("BEGIN");
      const n = await copyTable(source, table, target);
      await target.query("COMMIT");
      total += n;
    } catch (err) {
      await target.query("ROLLBACK");
      console.error(`  ${table}: FAILED — ${err.message}`);
      // Skip; verify step below will show the gap.
    }
  }
  await fixSequences(target, ordered);

  console.log(`\nTotal rows copied: ${total}`);

  // ── Verification: row counts source vs target ─────────────────────────
  console.log("\nVerifying row counts (source vs target):");
  const mismatches = [];
  for (const table of ordered) {
    const s = await source.query(`SELECT COUNT(*)::int AS n FROM "${table}"`).catch(() => ({ rows: [{ n: -1 }] }));
    const t = await target.query(`SELECT COUNT(*)::int AS n FROM "${table}"`).catch(() => ({ rows: [{ n: -1 }] }));
    const a = s.rows[0].n;
    const b = t.rows[0].n;
    const ok = a === b;
    if (!ok) mismatches.push(`${table}: source=${a} target=${b}`);
    console.log(`  ${ok ? "✔" : "✘"} ${table}: ${a} → ${b}`);
  }

  if (mismatches.length) {
    console.error("\nMISMATCHES:\n" + mismatches.join("\n"));
    process.exitCode = 2;
  } else {
    console.log("\nAll tables verified — data migration complete. 🎉");
  }
} finally {
  await source.end();
  await target.end();
}
