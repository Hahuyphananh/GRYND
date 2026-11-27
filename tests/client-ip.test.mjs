// tests/client-ip.test.mjs
//
// THE rate limiter, the audit log and the MFA attempt counter all key on the
// client IP. That value must come only from a hop a proxy we control wrote.
//
// The regression these tests pin: the proxy used to return the FIRST entry of
// X-Forwarded-For, which is whatever the caller sent, so a client could rotate
// it per request and never hit an IP limit.
//
// Run with: node --import tsx --test tests/client-ip.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  clientIpFromHeaders,
  normalizeIp,
  trustedProxyCount,
} from "../src/lib/security/clientIp.ts";

const headers = (values) => new Headers(values);
const ENV = {}; // default: one trusted proxy

test("the rightmost forwarded hop wins, not the client-supplied one", () => {
  assert.equal(
    clientIpFromHeaders(
      headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }),
      ENV,
    ),
    "203.0.113.9",
  );

  // Rotating the left entry changes nothing.
  assert.equal(
    clientIpFromHeaders(
      headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" }),
      ENV,
    ),
    "203.0.113.9",
  );
});

test("a single-hop header is used as-is", () => {
  assert.equal(
    clientIpFromHeaders(headers({ "x-forwarded-for": "198.51.100.7" }), ENV),
    "198.51.100.7",
  );
});

test("TRUSTED_PROXY_COUNT moves the trusted position", () => {
  // Cloudflare + Vercel: the client address is two hops in from the right.
  assert.equal(
    clientIpFromHeaders(
      headers({ "x-forwarded-for": "198.51.100.7, 172.70.0.5" }),
      { TRUSTED_PROXY_COUNT: "2" },
    ),
    "198.51.100.7",
  );

  // Nonsense values fall back to exactly one hop, never to zero.
  assert.equal(trustedProxyCount({ TRUSTED_PROXY_COUNT: "0" }), 1);
  assert.equal(trustedProxyCount({ TRUSTED_PROXY_COUNT: "nope" }), 1);
});

test("Cloudflare's own header wins when present", () => {
  assert.equal(
    clientIpFromHeaders(
      headers({
        "cf-connecting-ip": "203.0.113.44",
        "x-forwarded-for": "1.1.1.1, 10.0.0.1",
      }),
      ENV,
    ),
    "203.0.113.44",
  );
});

test("x-real-ip is the fallback, and junk never becomes a key", () => {
  assert.equal(
    clientIpFromHeaders(headers({ "x-real-ip": "192.0.2.10" }), ENV),
    "192.0.2.10",
  );
  assert.equal(
    clientIpFromHeaders(headers({ "x-real-ip": "evil value" }), ENV),
    "unknown",
  );
  assert.equal(clientIpFromHeaders(headers({}), ENV), "unknown");
  assert.equal(
    clientIpFromHeaders(headers({ "x-forwarded-for": "not-an-ip" }), ENV),
    "unknown",
  );
});

test("ports and IPv6 brackets are normalised away", () => {
  assert.equal(normalizeIp("203.0.113.9:51234"), "203.0.113.9");
  assert.equal(normalizeIp("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(normalizeIp("[2001:db8::1]"), "2001:db8::1");
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8::1");
  assert.equal(normalizeIp(""), null);
  assert.equal(normalizeIp("1.2.3.4; DROP TABLE users"), null);
});
