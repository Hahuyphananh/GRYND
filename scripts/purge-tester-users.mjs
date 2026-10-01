#!/usr/bin/env node
/**
 * scripts/purge-tester-users.mjs
 *
 * One-off sweep: delete throwaway "tester" accounts (and everything they own)
 * from the local database so they disappear from the leaderboards too.
 *
 * WHY THIS EXISTS: QA / manual-test accounts (tester@example.com, "Test User",
 * demo logins, …) are real rows in `users`. The leaderboards read live account
 * and rating tables, so those rows rank in front of real players. This removes
 * them properly — through the SAME purge the delete-account flow uses
 * (`deleteUserLocalData`) — instead of deleting the `users` row and leaving
 * orphaned matches, bets and ratings behind.
 *
 * MATCHING (edit TESTER_EMAIL_PATTERNS / TESTER_NAME_PATTERNS below if the
 * heuristic misses one):
 *   • email:   starts with "tester", @example.com/org/net, @test.*, +test@
 *   • name:    Tester…, Test User, Test, Demo…, QA-prefixed
 *
 * `deleteUserLocalData` also erases the account's `player_ratings` /
 * `rating_events` (the tables the Elo boards read), so the leaderboard updates
 * on the next read — no second step.
 *
 * DRY RUN BY DEFAULT — prints exactly which accounts it would delete and writes
 * nothing. Pass --apply to actually delete.
 *
 *   npm run db:purge-testers              # dry run (read-only)
 *   npm run db:purge-testers -- --apply   # actually delete
 *
 * Optional: --actor=<clerkId> records who ran it in the admin audit log.
 */

import { getPool } from "../src/db/pool.ts";
import { deleteUserLocalData } from "../src/lib/security/deleteUserData.ts";
import { adminAuditLog } from "../src/lib/security/adminAuditLog.ts";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ACTOR =
  argv.find((arg) => arg.startsWith("--actor="))?.slice("--actor=".length) ||
  "system:purge-tester-users";

/** Email shapes that only ever belong to throwaway/test signups. */
const TESTER_EMAIL_PATTERNS = [
  /^tester/i,
  /@example\.(com|org|net)$/i,
  /@test\./i,
  /\+test@/i,
];

/** Display-name shapes that only ever belong to throwaway/test signups. */
const TESTER_NAME_PATTERNS = [
  /^tester/i,
  /^test\s*user/i,
  /^test$/i,
  /^demo(?!nstration)/i,
  /^qa[\s_-]/i,
];

function isTester(row) {
  const email = String(row.email ?? "");
  const name = String(row.name ?? "").trim();
  if (TESTER_EMAIL_PATTERNS.some((re) => re.test(email))) return true;
  if (TESTER_NAME_PATTERNS.some((re) => re.test(name))) return true;
  return false;
}

const pad = (value, width) => String(value ?? "").padEnd(width);

const pool = getPool();

try {
  const { rows } = await pool.query(
    "SELECT id, clerk_id, name, email FROM users ORDER BY id",
  );

  const targets = rows.filter(isTester);

  if (targets.length === 0) {
    console.log(`Scanned ${rows.length} account(s) — no tester accounts found.`);
    process.exit(0);
  }

  console.log(`Scanned ${rows.length} account(s); ${targets.length} look like testers:\n`);
  console.log(`  ${pad("id", 8)}  ${pad("name", 26)}  email`);
  console.log(`  ${"-".repeat(8)}  ${"-".repeat(26)}  ${"-".repeat(30)}`);
  for (const row of targets) {
    console.log(`  ${pad(row.id, 8)}  ${pad(row.name, 26)}  ${row.email}`);
  }
  console.log("");

  if (!APPLY) {
    console.log(
      "DRY RUN — nothing was written. Re-run with --apply to delete the accounts above.",
    );
    process.exit(0);
  }

  let removed = 0;
  for (const row of targets) {
    // The shared purge (delete-account flow) erases the account, its matches,
    // bets, ratings and presence in one transaction — leaving no orphans for
    // the leaderboard to pick up. A single failure is logged and the sweep
    // continues, so one bad row cannot block the rest.
    try {
      const deleted = await deleteUserLocalData(row.clerk_id);
      if (deleted) removed += 1;
      await adminAuditLog("admin_purge_tester_user", {
        clerkId: ACTOR,
        targetClerkId: row.clerk_id,
        details: { userId: row.id, name: row.name, email: row.email, deleted },
      });
    } catch (err) {
      console.error(`  failed to purge ${row.email}:`, err?.message ?? err);
    }
  }

  console.log(`Deleted ${removed}/${targets.length} tester account(s). Audit entries written as "${ACTOR}".`);
} catch (err) {
  console.error("[purge-tester-users] Failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
