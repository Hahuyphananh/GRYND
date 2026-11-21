// tests/security-high-priority.test.mjs
//
// Regression guards for the four HIGH findings of the 2026-11 security audit:
//
//   1. review JSON-LD was serialised inline, so an approved review body could
//      close the <script> tag (stored XSS on /reviews);
//   2. /api/system/notify accepted anonymous callers and interpolated their
//      HTML into the admin email;
//   3. /api/pm/* authenticated the literal string "Bearer undefined" when
//      PM_API_KEY was unset, and compared tokens with ===;
//   4. /api/sync-user re-linked a local account (balance, stats, is_admin) to a
//      different Clerk sign-in on an email match alone.
//
// The static assertions pin the shape; the PM gate is exercised directly
// because it is a pure function. Run with the TS loader:
//
//   node --import tsx --test tests/security-high-priority.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { verifyPmRequest } from "../src/lib/security/pmAuth.ts";
import {
  readBearerToken,
  timingSafeEqualString,
} from "../src/lib/security/bearerToken.ts";

const read = (path) => readFileSync(path, "utf8");

test("review structured data cannot escape its script tag", () => {
  const renderer = read("src/components/seo/JsonLd.tsx");
  assert.match(renderer, /\.replace\(\/<\/g/, "the shared renderer must escape <");

  const reviews = read("src/app/reviews/page.tsx");
  assert.match(reviews, /<JsonLd data=\{reviewJsonLd\} \/>/);
  assert.doesNotMatch(reviews, /dangerouslySetInnerHTML/);

  const home = read("src/app/page.jsx");
  assert.match(home, /<JsonLd data=\{ratingJsonLd\} \/>/);
  assert.doesNotMatch(home, /JSON\.stringify\(ratingJsonLd\)/);

  const layout = read("src/app/layout.tsx");
  assert.match(layout, /<JsonLd data=\{\[organizationJsonLd, buildWebsiteJsonLd\(\)\]\} \/>/);
  assert.doesNotMatch(layout, /JSON\.stringify\(organizationJsonLd\)/);
});

test("the internal PM endpoints fail closed without a configured key", () => {
  const previous = process.env.PM_API_KEY;
  try {
    delete process.env.PM_API_KEY;
    const unset = verifyPmRequest(
      new Request("http://localhost/api/pm/errors", {
        headers: { authorization: "Bearer undefined" },
      }),
    );
    assert.ok(unset, "an unset PM_API_KEY must be refused");
    assert.equal(unset.status, 503);

    process.env.PM_API_KEY = "pm-test-key";
    const wrong = verifyPmRequest(
      new Request("http://localhost/api/pm/errors", {
        headers: { authorization: "Bearer nope" },
      }),
    );
    assert.ok(wrong);
    assert.equal(wrong.status, 401);

    assert.equal(
      verifyPmRequest(
        new Request("http://localhost/api/pm/errors", {
          headers: { authorization: "Bearer pm-test-key" },
        }),
      ),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.PM_API_KEY;
    else process.env.PM_API_KEY = previous;
  }
});

test("both PM routes use the shared fail-closed gate", () => {
  for (const path of [
    "src/app/api/pm/errors/route.ts",
    "src/app/api/pm/analytics/route.ts",
  ]) {
    const source = read(path);
    assert.match(source, /verifyPmRequest\(request\)/, `${path} must use the gate`);
    assert.ok(
      !source.includes("process.env.PM_API_KEY"),
      `${path} must not compare the key inline`,
    );
  }
});

test("bearer comparison is constant-time and length-safe", () => {
  assert.equal(readBearerToken("Bearer abc"), "abc");
  assert.equal(readBearerToken("bearer  abc "), "abc");
  assert.equal(readBearerToken("Basic abc"), "");
  assert.equal(readBearerToken(null), "");
  assert.equal(timingSafeEqualString("abc", "abc"), true);
  assert.equal(timingSafeEqualString("abc", "abd"), false);
  assert.equal(timingSafeEqualString("", ""), false);
  assert.equal(timingSafeEqualString("abc", "abcd"), false);
});

test("system notifications are gated and HTML-escaped", () => {
  const route = read("src/app/api/system/notify/route.ts");
  // Use the call sites: the import line names the email helper too.
  const gate = route.indexOf("await authoriseSystemNotify(request)");
  const send = route.indexOf("await sendSystemNotificationEmail(");
  assert.ok(gate >= 0, "the route must gate the caller");
  assert.ok(send >= 0, "the route must send the email");
  assert.ok(gate < send, "the gate must run before the email is sent");
  assert.match(route, /isAdmin\(userId\)/);
  assert.match(route, /CRON_SECRET/);

  const email = read("src/lib/emails/system.ts");
  assert.match(email, /escapeHtml\(params\.description\)/);
  assert.match(email, /escapeHtml\(JSON\.stringify\(params\.metadata/);
  assert.match(email, /escapeHtml\(label\)/);
});

test("sync-user never transfers an account on an email match", () => {
  const source = read("src/app/api/sync-user/route.ts");
  assert.ok(
    !source.includes("re-associated with current Clerk account"),
    "the implicit re-link response must be gone",
  );
  assert.match(source, /sync_user_email_conflict/);
  assert.doesNotMatch(
    source,
    /\.set\(\{\s*clerkId,/,
    "the conflict path must not rewrite clerk_id",
  );
});
