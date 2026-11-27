#!/usr/bin/env node
/**
 * 18+ age gate — read-only impact report.
 *
 * Answers one question before `API_AGE_GATE=enforce` is turned on in a live
 * deployment: who does this rule stop, and how many people is that?
 *
 * STRICTLY READ-ONLY. The whole report runs inside `BEGIN ... READ ONLY`, so a
 * bug here cannot write. `SET LOCAL statement_timeout` bounds a slow scan. The
 * output is aggregate counts only — no user ids, emails or birth dates — which
 * is what makes it safe to paste into a launch thread.
 *
 * What the numbers mean (matching the gate's real behaviour):
 *
 *   blocked     age < MINIMUM_AGE. The proxy redirects these accounts to
 *               /access-denied and the game APIs return 403 immediately.
 *   needs_dob   age IS NULL and the account is NOT grandfathered. The proxy
 *               sends them to /complete-profile; they are not turned away yet.
 *   legacy      age IS NULL and created before LEGACY_AGE_GATE_CUTOFF. These
 *               in-flight accounts are exempt until the cutoff is set to "off".
 *   implausible age outside 0..120. Not blocked by the gate (they are >= 18),
 *               but they are bad data worth looking at separately.
 *
 * Usage:
 *   npm run db:age-gate-impact
 *   npm run db:age-gate-impact -- --json
 *
 * DATABASE_URL (or POSTGRES_URL) and DATABASE_SSL_CA_PATH are read exactly as
 * the app reads them, through the shared pool, so the report uses the same
 * verified TLS path as production traffic.
 */

import { getPool } from "../../src/db/pool";
import { MINIMUM_AGE } from "../../src/lib/ageVerification";
import { getLegacyAgeCutoff } from "../../src/lib/auth/requireAgeVerified";

const asJson = process.argv.includes("--json");

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  if (!url) {
    console.error(
      "DATABASE_URL (or POSTGRES_URL) is not set — point it at the database to report on.",
    );
    process.exit(1);
  }

  // Host and database only: never echo credentials into a log or a ticket.
  let where = "(unparseable connection string)";
  try {
    const parsed = new URL(url);
    where = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    // reported above; the connection itself will fail clearly if it is unusable
  }

  const cutoff = getLegacyAgeCutoff();
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const totals = (
      await client.query<{
        total: string;
        underage: string;
        adult: string;
        no_age: string;
        implausible: string;
      }>(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE age IS NOT NULL AND age < $1)::int AS underage,
           count(*) FILTER (WHERE age >= $1)::int AS adult,
           count(*) FILTER (WHERE age IS NULL)::int AS no_age,
           count(*) FILTER (WHERE age < 0 OR age > 120)::int AS implausible
         FROM users`,
        [MINIMUM_AGE],
      )
    ).rows[0];

    const legacy = cutoff
      ? (
          await client.query<{ legacy: string }>(
            `SELECT count(*)::int AS legacy
             FROM users
             WHERE age IS NULL AND created_at < $1`,
            [cutoff],
          )
        ).rows[0].legacy
      : null;

    const buckets = (
      await client.query<{ bucket: string; n: string }>(
        `SELECT bucket, count(*)::int AS n FROM (
           SELECT CASE
             WHEN age IS NULL        THEN 'no date of birth'
             WHEN age < 13           THEN 'under 13'
             WHEN age < 18           THEN '13-17'
             WHEN age < 25           THEN '18-24'
             WHEN age < 35           THEN '25-34'
             WHEN age < 45           THEN '35-44'
             WHEN age < 55           THEN '45-54'
             WHEN age < 65           THEN '55-64'
             ELSE                         '65+'
           END AS bucket
           FROM users
         ) b
         GROUP BY bucket`,
      )
    ).rows;

    await client.query("ROLLBACK");

    const num = (v: string | null | undefined): number => Number(v ?? 0);
    const total = num(totals.total);
    const underage = num(totals.underage);
    const noAge = num(totals.no_age);
    const legacyCount = legacy === null ? 0 : num(legacy);
    const needsDob = Math.max(0, noAge - legacyCount);
    const pct = (n: number): string =>
      total === 0 ? "0.0%" : `${((n / total) * 100).toFixed(1)}%`;

    const report = {
      database: where,
      minimum_age: MINIMUM_AGE,
      legacy_cutoff: cutoff ? cutoff.toISOString() : null,
      total_accounts: total,
      blocked_now: underage,
      needs_date_of_birth: needsDob,
      legacy_exempt: legacyCount,
      implausible_age: num(totals.implausible),
      buckets: Object.fromEntries(
        buckets
          .sort((a, b) => Number(b.n) - Number(a.n))
          .map((b) => [b.bucket, Number(b.n)]),
      ),
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log("GRYND — 18+ age gate impact (read-only)");
    console.log(`  database            ${where}`);
    console.log(`  minimum age         ${MINIMUM_AGE}`);
    console.log(
      `  legacy cutoff       ${cutoff ? cutoff.toISOString() : "off (nobody exempt)"}`,
    );
    console.log(`  accounts            ${total}`);
    console.log("");
    console.log(`  blocked now         ${underage}  (${pct(underage)})  -> /access-denied`);
    console.log(`  needs a date of birth ${needsDob}  (${pct(needsDob)})  -> /complete-profile`);
    console.log(`  legacy exempt       ${legacyCount}  (${pct(legacyCount)})`);
    console.log(`  implausible age     ${report.implausible_age}`);
    console.log("");
    console.log("  distribution");
    for (const b of buckets.sort((a, b) => Number(b.n) - Number(a.n))) {
      console.log(`    ${String(b.bucket).padEnd(18)} ${b.n}`);
    }
    console.log("");
    if (underage > 0) {
      console.log(
        `  ${underage} account(s) lose access the moment API_AGE_GATE=enforce.`,
      );
      console.log(
        "  To measure first instead, deploy with API_AGE_GATE=log and read the",
      );
      console.log("  [age-gate] would reject lines before switching.");
    } else {
      console.log("  No recorded under-18 accounts: enforce is a no-op for today's data.");
    }
    if (legacyCount > 0) {
      console.log(
        `  ${legacyCount} account(s) with no date of birth are still exempt; set`,
      );
      console.log(
        "  LEGACY_AGE_GATE_CUTOFF=off once they have completed /complete-profile.",
      );
    }
  } catch (error) {
    // Best effort: the transaction is read-only either way.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "age-gate impact report failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
