/**
 * solitaire-product-dashboard.test.mjs
 *
 * Guards the product dashboard's structure:
 *   * admin page gate + API authorisation order (PM token only when configured);
 *   * funnel stages use the Phase 1 taxonomy, never invented event names;
 *   * no sample/fabricated data in the source;
 *   * every section carries an explicit unavailable path;
 *   * metric definitions are shipped with the payload.
 *
 * Run:  node --import tsx --test tests/solitaire-product-dashboard.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { SOLITAIRE_EVENTS } from "../src/lib/solitaire-analytics.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const PAGE = "src/app/admin/analytics/solitaire/page.tsx";
const CLIENT = "src/app/admin/analytics/solitaire/ProductDashboardClient.tsx";
const ROUTE = "src/app/api/admin/analytics/solitaire/route.ts";
const LIB = "src/lib/analytics/solitaireProduct.ts";

test("the product page re-checks the admin gate", () => {
  const src = read(PAGE);
  assert.match(src, /await requireAdminPage\(\)/);
  assert.match(src, /robots:\s*\{\s*index:\s*false/);
});

test("the API accepts PM or admin, and only tries PM when it is configured", () => {
  const src = read(ROUTE);
  assert.match(src, /verifyPmRequest\(req\)/);
  assert.match(src, /!process\.env\.PM_API_KEY\?\.trim\(\)/);
  const authAt = src.indexOf("await auth()");
  const adminAt = src.indexOf("isAdmin(userId)");
  assert.ok(authAt > -1 && adminAt > authAt);
  assert.match(src, /status:\s*401/);
  assert.match(src, /status:\s*403/);
});

test("funnel stages are Phase 1 taxonomy events", () => {
  const src = read(LIB);
  const events = [
    "landing_page_viewed",
    "signup_completed",
    "onboarding_started",
    "onboarding_completed",
    "solitaire_game_started",
    "solitaire_game_completed",
    "ranked_queue_started",
    "ranked_match_completed",
  ];
  const known = new Set(Object.values(SOLITAIRE_EVENTS));
  for (const event of events) {
    assert.ok(known.has(event), `${event} must exist in the taxonomy`);
    assert.ok(src.includes(`event: "${event}"`), `${event} must appear as a funnel stage`);
  }
  // Ordered funnel: each stage requires the previous timestamp.
  assert.match(src, /s\$\{index \+ 1\} >= s\$\{prior \+ 1\}/);
});

test("no fabricated sample data in the dashboard sources", () => {
  for (const path of [LIB, CLIENT]) {
    const src = read(path);
    // The banner may say "never filled with sample data"; an actual fixture
    // identifier is what must not exist.
    // Prose is allowed; an identifier holding invented figures is not.
    assert.doesNotMatch(src, /\b(sample|mock|dummy|fake)(Data|_data)\b/, path);
    assert.doesNotMatch(src, /\bexample\.com\b/, path);
  }
});

test("every section can report itself unavailable with a reason", () => {
  const src = read(LIB);
  assert.match(src, /available: false; value: null; reason: string/);
  assert.match(src, /async function section\s*<T>/);
  // Six sections are isolated, so one failing source cannot blank the page.
  const isolated = src.match(/section\(/g) ?? [];
  assert.ok(isolated.length >= 6, `expected >=6 isolated sections, found ${isolated.length}`);
});

test("metric definitions are part of the payload", () => {
  const src = read(LIB);
  for (const key of [
    "dau",
    "wau",
    "mau",
    "signups",
    "games_started",
    "games_completed",
    "queue_attempt",
    "wait_time",
    "recorded_human",
    "retention",
  ]) {
    assert.ok(src.includes(`${key}:`), `definition for ${key} is required`);
  }
});

test("matchmaking never counts a recorded opponent as a live human", () => {
  const src = read(LIB);
  assert.match(src, /solitaire_ghost_%'.*live_human|live_human[\s\S]{0,200}solitaire_ghost_%/);
  assert.match(src, /recorded_human:/);
  assert.match(src, /aiMatches/);
});

test("the client never carries credentials or reads env secrets", () => {
  const src = read(CLIENT);
  assert.doesNotMatch(src, /POSTHOG_PERSONAL_API_KEY|PM_API_KEY|phx_/);
  assert.match(src, /fetch\(`\/api\/admin\/analytics\/solitaire/);
});
