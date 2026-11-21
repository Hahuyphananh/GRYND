// tests/security-medium-priority.test.mjs
//
// Regression guards for the medium-severity findings of the 2026-11 audit:
//
//   1. /api/friends/search returned a `debug` object to every signed-in caller
//      — the folded query, an internal user id, a duplicate result array and,
//      on failure, the raw Postgres driver message;
//   2. Sentry's example API was an unauthenticated production endpoint whose
//      only behaviour is to throw, with a public page that calls it;
//   3. /api/admin/deploy-latest echoed the GitHub DeployError message to the
//      browser instead of an explainable code;
//   4. the fraud-alert email interpolated `reason` into HTML unescaped.
//
// Run with: node --test tests/security-medium-priority.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("friend search returns results, never internal diagnostics", () => {
  const route = read("src/app/api/friends/search/route.js");
  assert.doesNotMatch(route, /\bdebug\s*:/, "no debug object may leave the route");
  assert.doesNotMatch(
    route,
    /error\?\.message/,
    "a driver message must never reach the response",
  );

  const page = read("src/app/profil/PageClient.jsx");
  assert.doesNotMatch(
    page,
    /data\?\.debug/,
    "the profile page must not read the removed debug payload",
  );
});

test("the Sentry example surface cannot be reached in production", () => {
  const api = read("src/app/api/sentry-example-api/route.ts");
  assert.match(api, /process\.env\.NODE_ENV === "production"/);
  assert.match(api, /status: 404/);

  const proxy = read("src/proxy.ts");
  assert.match(proxy, /pathname === "\/sentry-example-page"/);
  assert.match(proxy, /pathname === "\/api\/sentry-example-api"/);
  assert.match(
    proxy,
    /new NextResponse\(null, \{ status: 404 \}\)/,
    "the guard must answer with a real 404 before rendering",
  );
});

test("the deploy endpoint does not echo GitHub's error text", () => {
  const route = read("src/app/api/admin/deploy-latest/route.ts");
  assert.doesNotMatch(route, /error:\s*error\.message/);
  assert.match(route, /PUBLIC_ERROR\[error\.code\]/);
  assert.match(route, /console\.error\("\[admin:deploy-latest\]", error\.code, error\.message\)/);
});

test("the fraud-alert email escapes its reason", () => {
  const email = read("src/lib/emails/behavior.ts");
  assert.match(email, /escapeHtml\(reason\)/);
});
