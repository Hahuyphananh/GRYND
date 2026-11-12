/**
 * admin-users-overview.test.mjs
 *
 * Guards the read-only audience dashboard on /admin/operations:
 *
 *   1. It reads the tables the product already maintains (presence, game
 *      presence, subscriptions, accounts) and nothing else.
 *   2. "Online" is bounded by the heartbeat window and "playing" by the same
 *      3-minute window the casino lobby uses, so an abandoned tab ages out and
 *      the two surfaces cannot disagree.
 *   3. PRO is counted from distinct subscribers whose status the entitlement
 *      check accepts — never from a client flag or a cached number.
 *   4. It is genuinely read-only: no insert/update/delete, no Stripe call.
 *   5. The operations page renders the section and degrades to "unavailable"
 *      instead of failing the whole page.
 *
 * The database reader itself is exercised by source/contract here, because the
 * repo's tests never connect to a database (same approach as the other admin
 * readers). The percentage helper is pure and is tested directly.
 *
 * Run: node --import tsx --test tests/admin-users-overview.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const READER = fs.readFileSync("src/lib/admin/usersOverview.ts", "utf8");
const PAGE = fs.readFileSync("src/app/admin/operations/page.tsx", "utf8");

const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const READER_CODE = stripComments(READER);

test("the audience reader uses the canonical presence and billing tables", () => {
  for (const table of [
    "userPresence",
    "userGamePresence",
    "tokenSubscriptions",
    "users",
  ]) {
    assert.match(READER_CODE, new RegExp(`\\b${table}\\b`), `${table} must be read`);
  }

  // The windows are the product's existing ones, imported rather than retyped.
  assert.match(READER_CODE, /ACTIVE_PLAYER_WINDOW_SECONDS/);
  assert.match(READER_CODE, /ACTIVE_SUBSCRIPTION_STATUSES/);
  assert.match(READER_CODE, /ONLINE_WINDOW_MINUTES\s*=\s*10/);
});

test("online and playing are bounded by their real windows", () => {
  // A row counts only while fresh — no "ever seen" totals.
  assert.match(
    READER_CODE,
    /gt\(userPresence\.lastSeen, onlineCutoff\)/,
    "online must be filtered on last_seen",
  );
  assert.match(
    READER_CODE,
    /gt\(userGamePresence\.lastSeenAt, playingCutoff\)/,
    "playing must be filtered on the game heartbeat",
  );
  assert.match(READER_CODE, /ONLINE_WINDOW_MINUTES \* 60_000/);
  assert.match(READER_CODE, /ACTIVE_PLAYER_WINDOW_SECONDS \* 1_000/);
});

test("PRO counts distinct subscribers in the entitlement statuses", () => {
  assert.match(
    READER_CODE,
    /count\(distinct \$\{tokenSubscriptions\.clerkId\}\)/,
    "one subscriber, one count — even with several rows per user",
  );
  assert.match(READER_CODE, /inArray\(tokenSubscriptions\.status/);
  // Growth comes from the account table itself, in UTC, not from a client day.
  assert.match(READER_CODE, /count\(\*\) filter \(where \$\{users\.createdAt\} >= \$\{dayStart\}\)/);
});

test("the reader never writes or calls out to Stripe", () => {
  assert.doesNotMatch(READER_CODE, /\.(insert|update|delete)\(/);
  assert.doesNotMatch(READER_CODE, /getStripe|stripe\./);
  assert.doesNotMatch(READER_CODE, /fetch\(/);
  // A failed read degrades instead of throwing into the page.
  assert.match(READER_CODE, /available: false/);
  assert.match(READER_CODE, /reason: "The audience tables could not be read\."/);
});

test("the operations page renders the audience section", () => {
  assert.match(PAGE, /getUsersOverview\(\)/);
  assert.match(PAGE, /<h2[^>]*>Audience<\/h2>/);
  for (const label of ["Online now", "Playing now", "GRYND PRO", "Top games right now"]) {
    assert.match(PAGE, new RegExp(label), `the page must show "${label}"`);
  }
  // Fetched alongside the existing readers, not instead of them.
  assert.match(PAGE, /getOperationsSnapshot\(\),\s*probeRealtime\(\),\s*getUsersOverview\(\),/);
  assert.doesNotMatch(PAGE, /use client/, "the operations page stays a server component");
});

test("MRR normalises every billing option to a monthly amount", async () => {
  const { monthlyValueCents, computeMrrCents, MRR_CURRENCY } = await import(
    "../src/lib/admin/usersOverview.ts"
  );

  // Published catalog: weekly 349, monthly 999, yearly 5999 (CAD cents).
  assert.equal(monthlyValueCents("monthly"), 999);
  assert.equal(monthlyValueCents("weekly"), Math.round((349 * 52) / 12));
  assert.equal(monthlyValueCents("yearly"), Math.round(5999 / 12));
  assert.equal(MRR_CURRENCY, "cad");

  const mrr = computeMrrCents({ weekly: 1, monthly: 2, yearly: 1 });
  assert.equal(mrr, 1512 + 999 * 2 + 500);
  // Unknown-interval and trialing/past-due counts never invent revenue.
  assert.equal(
    computeMrrCents({ weekly: 0, monthly: 0, yearly: 0 }),
    0,
  );
});

test("new-Pro and cancellation windows are bounded and counted per user", () => {
  assert.match(
    READER_CODE,
    /count\(distinct \$\{tokenSubscriptions\.clerkId\}\) filter \(where \$\{tokenSubscriptions\.createdAt\} >= \$\{dayStart\}\)/,
    "new Pro today must be a bounded, distinct count",
  );
  assert.match(READER_CODE, /gte\(tokenSubscriptions\.createdAt, weekStart\)/);
  assert.match(
    READER_CODE,
    /gte\(tokenSubscriptions\.updatedAt, canceledCutoff\)/,
    "cancellations come from the status the webhook stamps",
  );
  assert.match(READER_CODE, /eq\(tokenSubscriptions\.status, "canceled"\)/);
  assert.match(READER_CODE, /CHURN_WINDOW_DAYS = 30/);
});

test("the page shows revenue, new-Pro and cancellation figures", () => {
  for (const label of ["Pro MRR", "New Pro (7d)", "Canceled (30d)"]) {
    assert.ok(PAGE.includes(label), `the page must show "${label}"`);
  }
  assert.match(PAGE, /formatMoney\(\s*audience\.pro\.mrrCents/);
  assert.match(PAGE, /audience\.pro\.mrrByInterval\.monthly/);
});

test("the share-of-accounts helper never divides by zero", async () => {
  const { toPercent } = await import("../src/lib/admin/usersOverview.ts");

  assert.equal(toPercent(0, 0), 0);
  assert.equal(toPercent(5, 0), 0);
  assert.equal(toPercent(3, 7), 42.9);
  assert.equal(toPercent(1, 3), 33.3);
  assert.equal(toPercent(10, 10), 100);
  assert.equal(toPercent(NaN, 10), 0);
  assert.equal(toPercent(2, Infinity), 0);
});

test("the paid-but-not-Pro check joins paid checkouts to entitlement rows", () => {
  assert.match(READER_CODE, /eq\(stripeCheckoutSessions\.sessionMode, "subscription"\)/);
  assert.match(READER_CODE, /eq\(stripeCheckoutSessions\.paymentStatus, "paid"\)/);
  assert.match(READER_CODE, /leftJoin\(\s*tokenSubscriptions,/);
  assert.match(READER_CODE, /isNull\(tokenSubscriptions\.id\)/);
  assert.match(
    READER_CODE,
    /count\(distinct \$\{stripeCheckoutSessions\.sessionId\}\)/,
    "the incident count must be per checkout, not per joined row",
  );
  assert.match(READER_CODE, /PAYMENT_GUARD_DAYS = 7/);
  assert.ok(PAGE.includes("Paid but not Pro"), "the page must surface the check");
});

test("a subscription checkout is stamped paid by the webhook", () => {
  const webhook = fs.readFileSync(
    "src/app/api/webhooks/stripe/route.ts",
    "utf8",
  );
  assert.match(
    webhook,
    /await updateStatus\(session\.id, session\.payment_status \?\? "paid"\)/,
    "without this, a paid subscription is indistinguishable from an abandoned one",
  );
});

test("the daily snapshot is journaled and has a scheduled job", () => {
  const migration = fs.readFileSync(
    "src/db/migrations/0250_audience_daily_snapshots.sql",
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "audience_daily_snapshots"/);
  assert.match(migration, /"peak_online" integer NOT NULL/);

  const journal = JSON.parse(
    fs.readFileSync("src/db/migrations/meta/_journal.json", "utf8"),
  );
  assert.ok(
    journal.entries.some((entry) => entry.tag === "0250_audience_daily_snapshots"),
    "an unjournaled migration never runs",
  );

  const job = fs.readFileSync(
    "src/app/api/jobs/audience-snapshot/route.ts",
    "utf8",
  );
  assert.match(job, /verifyCronRequest\(request\)/);
  assert.match(job, /GREATEST\(/);
  assert.match(job, /ON CONFLICT \(day\) DO UPDATE/);

  const vercel = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
  assert.ok(
    vercel.crons.some((cron) => cron.path === "/api/jobs/audience-snapshot"),
    "the job must be scheduled, not just exist",
  );
});

test("the dashboard reads and renders the daily trend", () => {
  assert.match(READER_CODE, /audienceDailySnapshots/);
  assert.match(READER_CODE, /export async function getAudienceTrend/);
  assert.match(PAGE, /getAudienceTrend\(\)/);
  assert.ok(PAGE.includes("Last 14 days"), "the page must label the trend window");
});
