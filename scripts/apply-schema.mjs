#!/usr/bin/env node
/**
 * Reset the target database's public schema and apply a schema dump
 * produced by scripts/dump-schema.mjs. Runs inside a single transaction so
 * a failure rolls everything back.
 *
 * Usage: TARGET_URL="postgresql://..." node scripts/apply-schema.mjs [schema.sql]
 */
import fs from "node:fs";
import pg from "pg";

const { Client } = pg;

const url = process.env.TARGET_URL || process.env.SUPA_URL;
const file = process.argv[2] || "neon_schema.sql";

if (!url) {
  console.error("Usage: TARGET_URL=... node scripts/apply-schema.mjs [schema.sql]");
  process.exit(1);
}

const sql = fs.readFileSync(file, "utf8");

// Accumulate lines into statements: a statement ends when a line ends
// with `;`. Handles multi-line CREATE TABLE bodies and one-liners alike.
const statements = [];
let buf = [];
for (const raw of sql.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("--")) continue;
  buf.push(line);
  if (line.endsWith(";")) {
    statements.push(buf.join("\n"));
    buf = [];
  }
}
if (buf.length) statements.push(buf.join("\n"));

console.log(`Applying ${statements.length} statements from ${file}…`);

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  await client.query("BEGIN");
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  for (let i = 0; i < statements.length; i++) {
    try {
      await client.query(statements[i]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`FAILED at statement ${i + 1} of ${statements.length}:`);
      console.error(statements[i].slice(0, 500));
      console.error("—", err.message);
      process.exit(1);
    }
  }
  await client.query("COMMIT");
  console.log("Schema applied successfully.");
} catch (err) {
  await client.query("ROLLBACK");
  console.error("FAILED — transaction rolled back:", err.message);
  console.error("Statement:", err.query || "(unknown)");
  process.exit(1);
} finally {
  await client.end();
}
