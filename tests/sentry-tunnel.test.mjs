/**
 * Sentry tunnel route — src/app/sentry-tunnel/route.ts
 *
 * `withSentryConfig` is configured with `tunnelRoute: "/monitoring"`, so the
 * browser posts envelopes same-origin. While this handler file exists, the
 * SDK rewrites /monitoring HERE instead of emitting its own external rewrite
 * (which is what answered 500 in production). The contract this pins:
 *
 *   • only a Sentry SaaS DSN host is accepted — foreign hosts, lookalike hosts
 *     and non-numeric project ids are refused with 400 and NO outbound request
 *     is made, because the DSN comes from the request body and this route must
 *     not be usable as an SSRF relay
 *   • a well-formed envelope is forwarded VERBATIM to the DSN's own ingest URL
 *     (regional and region-less hosts), with the Sentry envelope content type
 *   • success answers 200, an upstream failure 502
 *   • the handler stays where @sentry/nextjs looks for it: if the file is moved
 *     or renamed, /monitoring silently reverts to the external rewrite.
 *
 * Run: node --import tsx --test tests/sentry-tunnel.test.mjs
 * (or: npm run test:sentry-tunnel)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { POST } from "../src/app/sentry-tunnel/route.ts";

const SENTRY_ENVELOPE = "application/x-sentry-envelope";
const VALID_DSN =
  "https://4c4bf15252867e3e45a423dbd691ad49@o4511487520538624.ingest.us.sentry.io/4511487533318144";

/** A Sentry envelope: JSON header line (carrying the DSN), then items. */
const envelopeFor = (dsn) =>
  `${JSON.stringify({
    event_id: "0123456789abcdef0123456789abcdef",
    sent_at: "2026-11-16T00:00:00.000Z",
    dsn,
  })}\n{"type":"event"}\n{"message":"boom"}`;

const post = (body) =>
  new Request("http://localhost/monitoring", { method: "POST", body });

/** Replace fetch with a spy that records the outbound call. */
function spyOnFetch({ status = 200, throws = false } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (throws) throw new Error("network down");
    return new Response(null, { status });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("refuses every DSN that is not a Sentry SaaS ingest host, without calling fetch", async () => {
  const fetchSpy = spyOnFetch();
  try {
    const refused = [
      "https://key@169.254.169.254/123", // cloud metadata endpoint
      "http://localhost:8080/123", // loopback
      "https://evil.example.com/123", // arbitrary host
      "https://o1.ingest.us.sentry.io.evil.com/123", // lookalike suffix
      "https://o1.ingest.us.sentry.io/not-a-project", // non-numeric project
      "https://o1.ingest.us.sentry.io/", // missing project
      "not-a-url",
    ];

    for (const dsn of refused) {
      const response = await POST(post(envelopeFor(dsn)));
      assert.equal(response.status, 400, `${dsn} must be refused with 400`);
    }

    assert.equal(
      fetchSpy.calls.length,
      0,
      "a refused envelope must never reach fetch (no SSRF)",
    );
  } finally {
    fetchSpy.restore();
  }
});

test("refuses malformed envelopes and envelopes that carry no DSN", async () => {
  const fetchSpy = spyOnFetch();
  try {
    const bodies = [
      "",
      "not json\n{}",
      "[]\n{}", // valid JSON, but not an object header
      `${JSON.stringify({ event_id: "x" })}\n{}`, // no dsn field
      `${JSON.stringify({ dsn: 12345 })}\n{}`, // dsn is not a string
    ];

    for (const body of bodies) {
      const response = await POST(post(body));
      assert.equal(
        response.status,
        400,
        `${JSON.stringify(body)} must be refused with 400`,
      );
    }

    assert.equal(fetchSpy.calls.length, 0);
  } finally {
    fetchSpy.restore();
  }
});

test("forwards a valid envelope verbatim to its regional ingest URL", async () => {
  const fetchSpy = spyOnFetch();
  try {
    const body = envelopeFor(VALID_DSN);
    const response = await POST(post(body));

    assert.equal(response.status, 200);
    assert.equal(fetchSpy.calls.length, 1);

    const [{ url, init }] = fetchSpy.calls;
    assert.equal(
      url,
      "https://o4511487520538624.ingest.us.sentry.io/api/4511487533318144/envelope/",
    );
    assert.equal(init.method, "POST");
    assert.equal(init.headers["content-type"], SENTRY_ENVELOPE);
    assert.equal(init.body, body, "the envelope must be forwarded untouched");
  } finally {
    fetchSpy.restore();
  }
});

test("builds the region-less ingest URL for a DSN without a region", async () => {
  const fetchSpy = spyOnFetch();
  try {
    const response = await POST(
      post(envelopeFor("https://key@o123.ingest.sentry.io/456")),
    );

    assert.equal(response.status, 200);
    assert.equal(
      fetchSpy.calls[0].url,
      "https://o123.ingest.sentry.io/api/456/envelope/",
    );
  } finally {
    fetchSpy.restore();
  }
});

test("answers 502 when Sentry rejects the envelope or is unreachable", async () => {
  for (const options of [{ status: 500 }, { status: 429 }, { throws: true }]) {
    const fetchSpy = spyOnFetch(options);
    try {
      const response = await POST(post(envelopeFor(VALID_DSN)));
      assert.equal(
        response.status,
        502,
        `upstream ${JSON.stringify(options)} must surface as 502`,
      );
    } finally {
      fetchSpy.restore();
    }
  }
});

test("stays where the Sentry SDK looks for the tunnel handler", () => {
  // The SDK only switches /monitoring to this handler (instead of its external
  // rewrite) while the file exists at src/app/sentry-tunnel/route.*.
  const require = createRequire(import.meta.url);
  // The SDK keeps that module out of its `exports` map, so load it from the
  // resolved package root (build/cjs/config/...) rather than a subpath import.
  const tunnelModule = join(
    dirname(require.resolve("@sentry/nextjs")),
    "config",
    "withSentryConfig",
    "tunnel.js",
  );
  assert.ok(existsSync(tunnelModule), `SDK tunnel module missing: ${tunnelModule}`);
  const tunnel = require(tunnelModule);

  const handler = tunnel.findTunnelRouteHandlerFile(undefined, process.cwd());
  assert.equal(
    String(handler).replace(/\\/g, "/"),
    "src/app/sentry-tunnel/route.ts",
    "the handler must stay at the path the SDK probes",
  );

  const injected = tunnel.getTunnelRouteInjectedValues(
    {},
    { tunnelRoute: "/monitoring" },
    process.cwd(),
  );
  assert.equal(injected._sentryRewritesTunnelPath, "/monitoring");
  assert.equal(injected._sentryTunnelRouteMode, "handler");
});
