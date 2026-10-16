#!/usr/bin/env node
/**
 * Record every migration in src/db/migrations as already applied on the
 * target database (used after restoring a schema dump, where the schema
 * came from the live source DB rather than the migration chain).
 *
 * Usage: TARGET_URL="postgresql://..." node scripts/mark-migrations-applied.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const url = process.env.TARGET_URL || process.env.SUPA_URL;
if (!url) {
  console.error("Usage: TARGET_URL=... node scripts/mark-migrations-applied.mjs");
  process.exit(1);
}

const journal = JSON.parse(
  fs.readFileSync(path.resolve("src/db/migrations/meta/_journal.json"), "utf8"),
);

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
await client.query(
  `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
     id serial PRIMARY KEY,
     hash text NOT NULL,
     created_at bigint
   )`,
);

let inserted = 0;
for (const entry of journal.entries) {
  const file = path.resolve("src/db/migrations", `${entry.tag}.sql`);
  const query = fs.readFileSync(file, "utf8");
  const hash = crypto.createHash("sha256").update(query).digest("hex");
  await client.query(
    `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [hash, entry.when],
  );
  inserted++;
}

const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM "drizzle"."__drizzle_migrations"`);
console.log(`Recorded ${inserted} migration hashes; table now has ${rows[0].n} rows.`);
await client.end();
