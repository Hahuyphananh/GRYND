// Diff schema.ts (the app's source of truth) against the union of all
// migration SQL files. Reports tables/columns that exist in the schema but
// are NOT created by any migration — i.e. candidate "missing migrations".
//
// Usage: npx tsx scripts/check-schema-vs-migrations.mjs
import fs from "node:fs";
import path from "node:path";
import * as schema from "../src/db/schema.js";
import { Table } from "drizzle-orm/table";

const migrationsDir = path.resolve("src/db/migrations");
const sqlFiles = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// 1. Collect every table + column created anywhere in the migrations:
//    - table names from CREATE TABLE
//    - inline columns from CREATE TABLE ( ... ) blocks
//    - columns from ALTER TABLE ... ADD [COLUMN]
const migrationTables = new Map(); // name -> Set(columns)

function ensureTable(name) {
  if (!migrationTables.has(name)) migrationTables.set(name, new Set());
  return migrationTables.get(name);
}

for (const file of sqlFiles) {
  const text = fs.readFileSync(path.join(migrationsDir, file), "utf8");

  // CREATE TABLE "name" ( ... )
  for (const m of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(([\s\S]*?)\)\s*;?/g)) {
    const table = m[1];
    const body = m[2];
    ensureTable(table);
    // Inline column definitions: `"col" type ...` at line starts (skip
    // table-level constraints which start with CONSTRAINT / UNIQUE / PRIMARY
    // / FOREIGN / CHECK / INDEX).
    for (const cm of body.matchAll(/^\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/gm)) {
      ensureTable(table).add(cm[1]);
    }
  }

  // ALTER TABLE ... ADD COLUMN "col"
  for (const m of text.matchAll(/ALTER TABLE\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+ADD(?:\s+COLUMN)?\s+(?:IF NOT EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/g)) {
    ensureTable(m[1]).add(m[2]);
  }
}

// 2. Introspect schema.ts via drizzle internals.
const schemaTables = new Map(); // name -> Set(columns)
for (const [key, value] of Object.entries(schema)) {
  if (value && typeof value === "object" && value[Table.Symbol.Name] && value[Table.Symbol.Columns]) {
    const name = value[Table.Symbol.Name];
    const cols = new Set();
    for (const c of Object.values(value[Table.Symbol.Columns])) {
      if (c && typeof c === "object" && typeof c.name === "string") {
        cols.add(c.name);
      }
    }
    schemaTables.set(name, cols);
  }
}

console.log(`schema.ts tables: ${schemaTables.size} | migration-created tables: ${migrationTables.size}`);
console.log("");

// 3. Diff.
let missing = 0;
for (const [table, cols] of [...schemaTables.entries()].sort()) {
  const migrated = migrationTables.get(table);
  if (!migrated) {
    console.log(`MISSING TABLE: ${table} (in schema, never created by a migration)`);
    missing++;
    continue;
  }
  const missingCols = [...cols].filter((c) => !migrated.has(c)).sort();
  if (missingCols.length) {
    console.log(`MISSING COLUMNS on ${table}: ${missingCols.join(", ")}`);
    missing++;
  }
}
console.log("");
console.log(missing === 0 ? "OK: every schema table/column exists in the migration chain." : `Found ${missing} schema items missing from migrations.`);

// Also list migration tables that no longer exist in schema (informational).
const orphaned = [...migrationTables.keys()].filter((t) => !schemaTables.has(t));
if (orphaned.length) {
  console.log(`\n(info) migration-only tables (dropped from schema or renamed): ${orphaned.length}`);
  console.log(orphaned.join(", "));
}
