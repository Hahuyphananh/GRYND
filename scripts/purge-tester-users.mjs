#!/usr/bin/env node
/**
 * scripts/purge-tester-users.mjs
 *
 * Delete throwaway "tester" accounts (and everything they own) so they
 * disappear from the leaderboards too. Works against whatever `DATABASE_URL`
 * points at — including Supabase. It connects as the `postgres` role, which
 * BYPASSES Row Level Security, so rows the Supabase table editor refuses to
 * delete (RLS / FK ordering) are removed here through the app's own
 * transactional purge.
 *
 * WHY THIS EXISTS: QA / manual-test accounts (tester@example.com, "Test User",
 * demo logins, …) are real rows in `users`. The leaderboards read live account
 * and rating tables, so those rows rank in front of real players. This removes
 * them properly — through the SAME purge the delete-account flow uses
 * (`deleteUserLocalData`) — instead of deleting the `users` row and leaving
 * orphaned matches, bets and ratings behind.
 *
 * USAGE
 *   npm run db:purge-testers                       # dry run, heuristic match
 *   npm run db:purge-testers -- --apply            # delete the heuristic matches
 *
 * Explicit targeting (recommended when you want to remove exactly what you see):
 *   --email=<addr>       delete this account (repeatable)
 *   --clerk-id=<id>      delete by Clerk id   (repeatable)
 *   --file=<path>        a text file, one email or Clerk id per line,
 *                        blank lines and `#` comments ignored
 *   --exclude=<addr>     never delete this email/Clerk id (repeatable)
 *   --also-heuristic     with explicit targets, ALSO delete heuristic matches
 *   --list-skipped       also print accounts the matcher did NOT select, so
 *                        you can spot testers the heuristic misses
 *   --apply              actually delete (default is a read-only dry run)
 *   --actor=<clerkId>    records who ran it in the admin audit log
 *
 * Examples:
 *   npm run db:purge-testers -- --email=a@test.com --email=b@test.com --apply
 *   npm run db:purge-testers -- --file=testers.txt --apply
 *
 * MATCHING (edit TESTER_EMAIL_PATTERNS / TESTER_NAME_PATTERNS below if the
 * heuristic misses one):
 *   • email:   starts with "tester", @example.com/org/net, @test.*, +test@
 *   • name:    Tester…, Test User, Test, Demo…, QA-prefixed
 *
 * AFTER RUNNING: leaderboard pages are Redis-cached, so flush that cache (or
 * wait for the TTL) or the old rows can still render on the board.
 *
 * DRY RUN BY DEFAULT — prints exactly which accounts it would delete and writes
 * nothing. Pass --apply to actually delete.
 */

import { readFileSync, existsSync } from "node:fs";
import { getPool } from "../src/db/pool.ts";
import { deleteUserLocalData } from "../src/lib/security/deleteUserData.ts";
import { adminAuditLog } from "../src/lib/security/adminAuditLog.ts";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ALSO_HEURISTIC = argv.includes("--also-heuristic");
const LIST_SKIPPED = argv.includes("--list-skipped");
const ACTOR =
  argv.find((arg) => arg.startsWith("--actor="))?.slice("--actor=".length) ||
  "system:purge-tester-users";

/** Collect every `--name=value` occurrence. */
function flagValues(name) {
  const prefix = `--${name}=`;
  return argv
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length).trim())
    .filter(Boolean);
}

/** Email shapes that only ever belong to throwaway/test signups. */
const TESTER_EMAIL_PATTERNS = [
  /^tester/i,
  /\+clerk_test@/i, // Clerk's built-in test-user marker (e.g. name+clerk_test@…)
  /@example\.(com|org|net)$/i,
  /@test\./i,
  /\+test@/i,
  /-test\.(dev|local|test|invalid)$/i, // dedicated *.dev/.local test domains
];

/** Display-name shapes that only ever belong to throwaway/test signups. */
const TESTER_NAME_PATTERNS = [
  /^tester/i,
  /^test\s*user/i,
  /^test$/i,
  /\btest\b/i, // a standalone "Test" token, e.g. "CodebuffP1 Test"
  /^demo(?!nstration)/i,
  /^qa[\s_-]/i,
];

// Machine accounts the app creates for local practice bots. These are NOT
// deleted by this sweep: their matches reference them by Clerk id, so removing
// them can take real game history with them. Handle them deliberately.
const BOT_EMAIL_PATTERN = /@grynd\.local$/i;

function isTester(row) {
  const email = String(row.email ?? "");
  const name = String(row.name ?? "").trim();
  if (BOT_EMAIL_PATTERN.test(email)) return false;
  if (TESTER_EMAIL_PATTERNS.some((re) => re.test(email))) return true;
  if (TESTER_NAME_PATTERNS.some((re) => re.test(name))) return true;
  return false;
}

// ── Explicit targets ────────────────────────────────────────────────────────
const explicitEmails = new Set(flagValues("email").map((v) => v.toLowerCase()));
const explicitClerkIds = new Set(flagValues("clerk-id"));
const excludeEmails = new Set(flagValues("exclude").map((v) => v.toLowerCase()));
const excludeClerkIds = new Set();

const fileArg = argv.find((arg) => arg.startsWith("--file="));
if (fileArg) {
  const path = fileArg.slice("--file=".length);
  if (!existsSync(path)) {
    console.error(`--file=${path} does not exist.`);
    process.exit(1);
  }
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.includes("@")) explicitEmails.add(line.toLowerCase());
    else explicitClerkIds.add(line);
  }
}

// `--exclude` may carry an email or a Clerk id.
for (const value of flagValues("exclude")) {
  if (value.includes("@")) excludeEmails.add(value.toLowerCase());
  else excludeClerkIds.add(value);
}

const hasExplicit = explicitEmails.size > 0 || explicitClerkIds.size > 0;
const isExcluded = (row) =>
  excludeEmails.has(String(row.email ?? "").toLowerCase()) ||
  excludeClerkIds.has(row.clerk_id);
const matchesExplicit = (row) =>
  explicitEmails.has(String(row.email ?? "").toLowerCase()) ||
  explicitClerkIds.has(row.clerk_id);

const pad = (value, width) => String(value ?? "").padEnd(width);

const pool = getPool();

try {
  const { rows } = await pool.query(
    "SELECT id, clerk_id, name, email FROM users ORDER BY id",
  );

  const targets = rows.filter((row) => {
    if (isExcluded(row)) return false;
    if (!hasExplicit) return isTester(row);
    return matchesExplicit(row) || (ALSO_HEURISTIC && isTester(row));
  });

  // Surface explicit targets that matched nothing — usually a typo.
  if (hasExplicit) {
    for (const email of explicitEmails) {
      if (!rows.some((row) => String(row.email ?? "").toLowerCase() === email)) {
        console.warn(`  ! no account found for email ${email}`);
      }
    }
    for (const clerkId of explicitClerkIds) {
      if (!rows.some((row) => row.clerk_id === clerkId)) {
        console.warn(`  ! no account found for clerk id ${clerkId}`);
      }
    }
  }

  const printSkipped = () => {
    if (!LIST_SKIPPED) return;
    const skipped = rows.filter((row) => !targets.includes(row));
    console.log(`Not selected (${skipped.length}) — review for missed testers:\n`);
    console.log(`  ${pad("id", 8)}  ${pad("name", 26)}  email`);
    console.log(`  ${"-".repeat(8)}  ${"-".repeat(26)}  ${"-".repeat(30)}`);
    for (const row of skipped) {
      console.log(`  ${pad(row.id, 8)}  ${pad(row.name, 26)}  ${row.email}`);
    }
    console.log("");
  };

  if (targets.length === 0) {
    console.log(`Scanned ${rows.length} account(s) — nothing to delete.\n`);
    printSkipped();
    process.exit(0);
  }

  const mode = hasExplicit ? "explicit target(s)" : "heuristic tester match(es)";
  console.log(`Scanned ${rows.length} account(s); ${targets.length} ${mode}:\n`);
  console.log(`  ${pad("id", 8)}  ${pad("name", 26)}  email`);
  console.log(`  ${"-".repeat(8)}  ${"-".repeat(26)}  ${"-".repeat(30)}`);
  for (const row of targets) {
    console.log(`  ${pad(row.id, 8)}  ${pad(row.name, 26)}  ${row.email}`);
  }
  console.log("");

  printSkipped();

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

  console.log(`Deleted ${removed}/${targets.length} account(s). Audit entries written as "${ACTOR}".`);
  console.log(
    "Reminder: leaderboard pages are Redis-cached — flush the cache (admin) or wait for the TTL.",
  );
} catch (err) {
  console.error("[purge-tester-users] Failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
