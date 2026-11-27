/**
 * admin-analytics-dashboard.test.mjs
 *
 * The dashboard is an admin surface over a third-party API key, so the things
 * that must not regress are structural, not cosmetic:
 *
 *   * the page re-checks the admin gate (defense in depth, like every admin page);
 *   * the route returns 401 before 403, and 403 for non-admins;
 *   * the personal API key is read on the server only and never appears in a
 *     client component;
 *   * the event list is the taxonomy itself — no second hardcoded list that can
 *     drift;
 *   * HogQL is built from safe tokens with the range bounded;
 *   * `signup_completed` is emitted by the Clerk webhook (after the insert) and
 *     no longer by the client sync handoff.
 *
 * Run:  node --import tsx --test tests/admin-analytics-dashboard.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const PAGE = "src/app/admin/analytics/page.tsx";
const CLIENT = "src/app/admin/analytics/AnalyticsDashboardClient.tsx";
const ROUTE = "src/app/api/admin/analytics/route.ts";
const LIB = "src/lib/analytics/solitaireDashboard.ts";

test("the page calls the shared admin gate", () => {
  const src = read(PAGE);
  assert.match(src, /requireAdminPage\(\)/);
  assert.match(src, /robots:\s*\{\s*index:\s*false/);
});

test("the API route authenticates, then authorises", () => {
  const src = read(ROUTE);
  const authAt = src.indexOf("await auth()");
  const adminAt = src.indexOf("isAdmin(userId)");
  assert.ok(authAt > -1, "route must read the Clerk session");
  assert.ok(adminAt > authAt, "admin check must follow authentication");
  assert.match(src, /status:\s*401/);
  assert.match(src, /status:\s*403/);
  assert.match(src, /Cache-Control": "no-store"/);
});

test("the personal API key never reaches a client bundle", () => {
  const client = read(CLIENT);
  // The banner may NAME the variables; it must never read them or carry a key.
  assert.doesNotMatch(client, /process\.env\.POSTHOG_PERSONAL|process\.env\.POSTHOG_PROJECT_ID|phx_/);
  assert.match(client, /fetch\(`\/api\/admin\/analytics/);
  const lib = read(LIB);
  assert.doesNotMatch(lib, /NEXT_PUBLIC_POSTHOG_PERSONAL/);
});

test("the dashboard derives its event list from the taxonomy", () => {
  const lib = read(LIB);
  assert.match(lib, /import \{ SOLITAIRE_EVENTS \} from "\.\.\/solitaire-analytics"/);
  assert.match(lib, /Object\.values\(SOLITAIRE_EVENTS\)/);
  // No second hardcoded list: a couple of representative names must NOT be
  // literal in the query layer.
  assert.doesNotMatch(lib, /"solitaire_game_started"/);
  assert.doesNotMatch(lib, /"ranked_match_completed"/);
});

test("HogQL is built from the taxonomy with a bounded range", () => {
  const lib = read(LIB);
  assert.match(lib, /INTERVAL \$\{days\} DAY/);
  assert.match(lib, /parseRange/);
  assert.match(lib, /DASHBOARD_RANGES: readonly DashboardRange\[\] = \[7, 30, 90\]/);
});

test("unconfigured PostHog degrades instead of throwing", async () => {
  const { dashboardConfig, loadAnalyticsSnapshot } = await import(
    "../src/lib/analytics/solitaireDashboard.ts"
  );
  const saved = {
    key: process.env.POSTHOG_PERSONAL_API_KEY,
    project: process.env.POSTHOG_PROJECT_ID,
  };
  delete process.env.POSTHOG_PERSONAL_API_KEY;
  delete process.env.POSTHOG_PROJECT_ID;
  try {
    assert.equal(dashboardConfig().configured, false);
    const snapshot = await loadAnalyticsSnapshot(7);
    assert.equal(snapshot.configured, false);
    assert.deepEqual(snapshot.totals, {});
    assert.ok(snapshot.events.includes("solitaire_game_started"));
    assert.equal(snapshot.error, undefined);
  } finally {
    if (saved.key !== undefined) process.env.POSTHOG_PERSONAL_API_KEY = saved.key;
    if (saved.project !== undefined) process.env.POSTHOG_PROJECT_ID = saved.project;
  }
});

test("signup_completed is authoritative: webhook, not the client", () => {
  const webhook = read("src/app/api/webhooks/clerk/route.js");
  assert.match(webhook, /captureSolitaireServerEvent\(SOLITAIRE_EVENTS\.signupCompleted, id/);
  // Only when the insert actually created the row.
  const insertAt = webhook.indexOf("const insertedRows = await db");
  const guardAt = webhook.indexOf("if (insertedRows?.length)");
  const emitAt = webhook.indexOf("SOLITAIRE_EVENTS.signupCompleted");
  assert.ok(insertAt > -1 && guardAt > insertAt && emitAt > guardAt, "emit must be guarded by the insert");

  const sync = read("src/app/sync/PageClient.tsx");
  assert.doesNotMatch(sync, /posthog\.capture\(/);
  assert.doesNotMatch(sync, /getAcquisitionParams/);
});
