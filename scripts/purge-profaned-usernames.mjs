#!/usr/bin/env node
/**
 * scripts/purge-profaned-usernames.mjs
 *
 * One-off sweep: give every existing account whose display name trips the
 * username filter a fresh, neutral handle.
 *
 * WHY THIS EXISTS: src/lib/moderation/profanity.ts stops a profane name at
 * signup and on rename, but the filter is forward-looking. Whatever is already
 * in `users.name` keeps rendering on the public leaderboard — which is how a
 * slur ended up sitting at rank 1 in front of signed-out visitors. That row has
 * to be dealt with separately, and this is that step.
 *
 * WHY NOT SQL: the rule lives in TypeScript. Re-writing it as a regex in SQL
 * would create a second source of truth that silently drifts from what the app
 * actually enforces (and the allowlist — "ClassicGamer", "PeacockFan",
 * "Scunthorpe" — is exactly the part that would rot). This imports the same
 * findProfanity() the routes use, so the sweep can never rename someone the app
 * would let through, or miss someone it would stop.
 *
 * `search_name` is updated alongside `name`: it is the folded match key
 * /api/friends/search reads (src/lib/searchName.ts), and leaving it behind would
 * keep the old handle findable.
 *
 * DRY RUN BY DEFAULT — it prints exactly what it would change and writes
 * nothing. Pass --apply to perform the renames.
 *
 *   npm run db:purge-bad-names              # dry run (read-only)
 *   npm run db:purge-bad-names -- --apply   # actually rename
 *
 * Optional: --actor=<clerkId> records who ran it in the admin audit log.
 */

import { getPool } from "../src/db/pool.ts";
import { findProfanity } from "../src/lib/moderation/profanity.ts";
import { randomCleanName } from "../src/lib/moderation/randomName.ts";
import { searchNameFor } from "../src/lib/searchName.ts";
import { adminAuditLog } from "../src/lib/security/adminAuditLog.ts";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ACTOR =
  argv.find((arg) => arg.startsWith("--actor="))?.slice("--actor=".length) ||
  "system:purge-profaned-usernames";

/**
 * Pad a column so the dry-run table stays readable.
 *
 * Never truncates: the whole point of the dry run is that an operator can read
 * back every name it is about to change, so a long one is allowed to push the
 * columns out of alignment rather than being cut off.
 */
const pad = (value, width) => String(value ?? "").padEnd(width);

function printPlan(plan) {
  const idWidth = 8;
  const oldWidth = 28;
  console.log(
    `  ${pad("id", idWidth)}  ${pad("current name", oldWidth)}  ${pad("matched", 14)}  new name`,
  );
  console.log(`  ${"-".repeat(idWidth)}  ${"-".repeat(oldWidth)}  ${"-".repeat(14)}  ${"-".repeat(20)}`);
  for (const row of plan) {
    console.log(
      `  ${pad(row.id, idWidth)}  ${pad(row.name, oldWidth)}  ${pad(row.match, 14)}  ${row.next}`,
    );
  }
}

const pool = getPool();

try {
  // Every account is loaded deliberately: the filter needs the raw names to
  // judge them, and the generator needs the full set of handles to guarantee it
  // never mints a duplicate.
  const { rows } = await pool.query(
    "SELECT id, clerk_id, name FROM users WHERE name IS NOT NULL AND name <> '' ORDER BY id",
  );

  const taken = new Set(rows.map((row) => String(row.name).trim().toLowerCase()));

  const plan = [];
  for (const row of rows) {
    const match = findProfanity(row.name);
    if (!match) continue;

    const next = randomCleanName({ taken });
    // Free the old handle and reserve the new one, so two offenders cannot be
    // renamed into the same name.
    taken.delete(String(row.name).trim().toLowerCase());
    taken.add(next.toLowerCase());
    plan.push({ id: row.id, clerk_id: row.clerk_id, name: row.name, match, next });
  }

  if (plan.length === 0) {
    console.log(`Scanned ${rows.length} account(s) — no profane display names found.`);
    process.exit(0);
  }

  console.log(`Scanned ${rows.length} account(s); ${plan.length} need a new name:\n`);
  printPlan(plan);
  console.log("");

  if (!APPLY) {
    console.log("DRY RUN — nothing was written. Re-run with --apply to rename the accounts above.");
    process.exit(0);
  }

  // One transaction: a partially applied sweep would leave the board in a worse
  // state than before it ran.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of plan) {
      await client.query(
        "UPDATE users SET name = $1, search_name = $2 WHERE id = $3",
        [row.next, searchNameFor(row.next), row.id],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Audit AFTER the commit, so the log can never claim a rename that rolled
  // back. adminAuditLog swallows its own write failures by design.
  for (const row of plan) {
    await adminAuditLog("admin_purge_profaned_username", {
      clerkId: ACTOR,
      targetClerkId: row.clerk_id,
      details: { previousName: row.name, matched: row.match, newName: row.next },
    });
  }

  console.log(`Renamed ${plan.length} account(s). Audit entries written as "${ACTOR}".`);
} catch (err) {
  console.error("[purge-profaned-usernames] Failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
