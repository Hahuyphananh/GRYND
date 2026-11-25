/**
 * The /monitoring rewrite must stay INTERNAL.
 *
 * `withSentryConfig` has two tunnel modes. In "rewrite" mode it emits a
 * beforeFiles rule from /monitoring straight to
 * `https://o<org>.ingest.<region>.sentry.io/api/<project>/envelope/` — an
 * external hop that answered 500 in production. In "handler" mode (active
 * while src/app/sentry-tunnel/route.* exists) it emits `/monitoring` →
 * `/sentry-tunnel` instead, and our own route relays the envelope.
 *
 * This pins both places the wiring could silently flip back:
 *   • the rewrites `next.config.js` generates (what a build consumes)
 *   • the built `.next/routes-manifest.json` (what the server actually serves)
 *
 * Run: node --import tsx --test tests/sentry-tunnel-rewrite.test.mjs
 * (or: npm run test:sentry-tunnel)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const MONITORING_SOURCE = /^\/monitoring\/?$/;
const SENTRY_HOST = /sentry\.io/i;
const HANDLER_DESTINATION = "/sentry-tunnel";

const flatten = (rewrites) =>
  Array.isArray(rewrites)
    ? rewrites
    : [
        ...(rewrites?.beforeFiles ?? []),
        ...(rewrites?.afterFiles ?? []),
        ...(rewrites?.fallback ?? []),
      ];

test("generated rewrites send /monitoring to the local handler, never to sentry.io", async () => {
  const config = require("../next.config.js");

  assert.equal(
    typeof config.rewrites,
    "function",
    "next.config.js lost its rewrites() function",
  );

  const rewrites = flatten(await config.rewrites());
  const monitoring = rewrites.filter((rule) =>
    MONITORING_SOURCE.test(String(rule.source)),
  );

  assert.ok(monitoring.length >= 1, "no /monitoring rewrite was generated");

  for (const rule of monitoring) {
    assert.equal(
      rule.destination,
      HANDLER_DESTINATION,
      `the /monitoring rewrite points at ${rule.destination} — the tunnel reverted to its external form`,
    );
    assert.equal(
      rule.has,
      undefined,
      "the rewrite has the SDK's external-tunnel signature (o/p query matchers)",
    );
  }

  const external = rewrites.filter((rule) =>
    SENTRY_HOST.test(String(rule.destination)),
  );
  assert.deepEqual(
    external,
    [],
    "a rewrite still points at sentry.io; /monitoring must be relayed by src/app/sentry-tunnel/route.ts",
  );
});

const MANIFEST = ".next/routes-manifest.json";

test(
  "the built routes manifest keeps /monitoring internal",
  {
    skip: existsSync(MANIFEST)
      ? false
      : `no production build found (${MANIFEST}) — run \`npm run build\` to check the manifest`,
  },
  () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const beforeFiles = manifest.rewrites?.beforeFiles ?? [];
    const monitoring = beforeFiles.filter((rule) =>
      MONITORING_SOURCE.test(String(rule.source)),
    );

    assert.ok(
      monitoring.length >= 1,
      "the built manifest has no /monitoring rewrite (was it built with tunnelRoute unset?)",
    );

    for (const rule of monitoring) {
      assert.equal(
        rule.destination,
        HANDLER_DESTINATION,
        `the built manifest sends /monitoring to ${rule.destination}`,
      );
    }

    const external = beforeFiles.filter((rule) =>
      SENTRY_HOST.test(String(rule.destination)),
    );
    assert.deepEqual(
      external,
      [],
      "the built manifest sends browser envelopes to sentry.io again (external tunnel)",
    );
  },
);
