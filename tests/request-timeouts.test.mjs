/**
 * request-timeouts.test.mjs
 *
 * Guards the ONE failure mode that turns a self-hosted box into a hung server:
 * an outbound call on the request path with no deadline.
 *
 * The symptom this pins down is not an error — it is SILENCE. With an
 * unreachable Upstash/Redis endpoint, `fetch` never settles, so the request that
 * awaited it sends zero bytes, logs nothing, and the browser shows a spinner
 * forever while `/_next/static` and the proxy's redirects keep answering. That
 * is indistinguishable from a dead Next.js server, and it is what made every
 * page and every API route look broken after the Oracle migration.
 *
 * Three independent call sites had that shape, and each now has a bound:
 *
 *   1. `withRedis` / the Upstash client — the shared cache. src/proxy.ts reads
 *      the user's MFA and age flags through it BEFORE a page may render, so a
 *      hung cache hung every signed-in page. The client carries a per-request
 *      abort signal, and the wrapper races the same deadline so a caller is
 *      always released.
 *   2. `consumeRateLimit` — plain `fetch` calls to Upstash, run before EVERY
 *      `/api/*` handler. It now uses one deadline and falls back to the
 *      in-memory limiter, which must keep enforcing limits.
 *   3. `/api/health` — the endpoint a deploy is diagnosed with. It must ANSWER
 *      (503 + which dependency is bad), never hang.
 *
 * Run: node --import tsx --test --experimental-test-module-mocks tests/request-timeouts.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

// ── 0. Event-loop discipline (why every await below goes through settlesWithin)
//
// No assertion in this file may depend on some OTHER handle to keep Node's
// event loop alive while it is awaiting. The deadline the code under test
// installs is `AbortSignal.timeout()`, and that timer is UNREF'D: it cannot hold
// the loop open on its own.
//
//   $ node -e 'await new Promise(r => AbortSignal.timeout(300).addEventListener("abort", r))'
//   Warning: Detected unsettled top-level await ...   (exits 13)
//
// So a test that awaits a promise which only settles when that signal aborts is
// left pending with a loop that is free to drain. node:test reacts to that by
// cancelling the test — "Promise resolution is still pending but the event loop
// has already resolved" — and cancels every test after it in the file. That is
// exactly how one such await in the rate-limit test took the health and
// source-audit tests down with it: the cancellation was collateral, not those
// tests' own failure.
//
// `settlesWithin` closes that hole twice over:
//   - it races the promise against a plain REF'D `setTimeout`, so the loop is
//     held for exactly as long as the assertion legitimately needs and the
//     deadline under test can actually fire;
//   - if the promise still has not settled, the test FAILS with a named error
//     instead of hanging or being cancelled, so a missing deadline in the
//     source under test is reported as the regression it is.
function settlesWithin(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label}: still pending after ${ms}ms — the deadline under test never released the caller`,
        ),
      );
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ── 1. The cache cannot hang a caller ─────────────────────────────────────

// A `fetch` that behaves like a blackholed host: it never resolves on its own,
// and only rejects when the request's own signal aborts.
const hangUntilAborted = (calls) =>
  function (url, init = {}) {
    calls.push({ url: String(url), signal: init.signal });
    return new Promise((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return; // no deadline => hangs forever, the old behaviour
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  };

test("cache: a blackholed Redis releases the caller instead of hanging", async () => {
  process.env.KV_REST_API_URL = "http://10.255.255.1";
  process.env.KV_REST_API_TOKEN = "test-token";

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangUntilAborted(calls);

  try {
    // Imported AFTER the stub and the env vars: the client reads them at
    // construction.
    const { REDIS_TIMEOUT_MS, withRedis } = await import(
      "../src/lib/redis/client.ts"
    );
    const { cacheGet } = await import("../src/lib/redis/cache.ts");

    assert.ok(
      Number.isFinite(REDIS_TIMEOUT_MS) && REDIS_TIMEOUT_MS > 0,
      "the cache must carry a finite deadline",
    );

    const startedAt = Date.now();
    const value = await settlesWithin(
      cacheGet("grynd:test:hung"),
      REDIS_TIMEOUT_MS + 2_000,
      "cacheGet against a blackholed cache",
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(value, null, "a hung cache reads as a miss, never as a throw");
    assert.ok(
      elapsed < REDIS_TIMEOUT_MS + 2_000,
      `cacheGet must give up at its deadline (took ${elapsed}ms)`,
    );

    // The socket-level half: the request actually carried an abort signal, so
    // the SDK's retry loop stops at the first abort instead of retrying a
    // blackholed host five times.
    assert.ok(calls.length >= 1, "the cache should have attempted one request");
    for (const call of calls) {
      assert.ok(
        call.signal instanceof AbortSignal,
        "every Redis request must carry an AbortSignal",
      );
    }

    // And the wrapper releases callers even if a transport ignores the signal.
    const directStartedAt = Date.now();
    const direct = await settlesWithin(
      withRedis(() => new Promise(() => {})),
      REDIS_TIMEOUT_MS + 2_000,
      "withRedis given a transport that never settles",
    );
    assert.equal(direct, null);
    assert.ok(
      Date.now() - directStartedAt < REDIS_TIMEOUT_MS + 2_000,
      "withRedis must bound the await it was given",
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

// ── 2. Rate limiting falls back to memory, and keeps limiting ─────────────

test("rate limit: a blackholed Redis falls back to the in-memory limiter", async () => {
  process.env.KV_REST_API_URL = "http://10.255.255.1";
  process.env.KV_REST_API_TOKEN = "test-token";

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangUntilAborted(calls);

  try {
    const { consumeRateLimit } = await import(
      "../src/lib/security/rateLimit.ts"
    );

    const config = { windowMs: 60_000, max: 2 };
    const key = `POST:/api/test:ip:blackholed-${Date.now()}`;

    const startedAt = Date.now();
    const first = await settlesWithin(
      consumeRateLimit(key, config),
      4_000,
      "consumeRateLimit against a blackholed Redis",
    );
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed < 4_000,
      `rate limiting must not wait on a dead host (took ${elapsed}ms)`,
    );
    assert.equal(first.allowed, true, "the first call is under the limit");
    assert.equal(first.limit, config.max);

    assert.ok(calls.length >= 1, "the remote limiter should have attempted a fetch");
    for (const call of calls) {
      assert.ok(
        call.signal instanceof AbortSignal,
        "the remote limiter's fetch must carry an AbortSignal",
      );
      assert.equal(
        call.signal.aborted,
        true,
        "the shared deadline must have fired, not merely been attached",
      );
    }

    // The fallback is not a bypass: the in-memory limiter still counts.
    const second = await settlesWithin(
      consumeRateLimit(key, config),
      4_000,
      "consumeRateLimit (second call)",
    );
    const third = await settlesWithin(
      consumeRateLimit(key, config),
      4_000,
      "consumeRateLimit (third call)",
    );
    assert.equal(second.allowed, true);
    assert.equal(third.allowed, false, "the limit is still enforced without Redis");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

// ── 3. The health check always answers ───────────────────────────────────

test("health: reports a stuck dependency instead of hanging the request", async (t) => {
  const never = () => new Promise(() => {});

  t.mock.module("../src/db/client.ts", {
    namedExports: { db: { execute: never } },
  });
  t.mock.module("../src/lib/redis/client.ts", {
    namedExports: {
      REDIS_TIMEOUT_MS: 1_500,
      getRedis: () => ({ ping: never }),
    },
  });

  const { GET } = await import("../src/app/api/health/route.ts");

  const startedAt = Date.now();
  // The route bounds each dependency with `withTimeout`, whose timer is ref'd,
  // so this await already holds the loop. The outer deadline keeps it honest:
  // if a check stops being bounded, this fails by name instead of hanging.
  const response = await settlesWithin(GET(), 15_000, "GET /api/health");
  const elapsed = Date.now() - startedAt;

  assert.ok(
    elapsed < 15_000,
    `a health check must answer even when both dependencies hang (took ${elapsed}ms)`,
  );
  assert.equal(response.status, 503, "an unreachable database fails the check");

  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.db, "timeout", "the stuck database is reported, not hidden");
  assert.equal(body.redis, "timeout", "the stuck cache is reported, not hidden");
  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
    "a health check must never be cached",
  );
});

// ── 4. The pin: no bare fetch/await on the request path ──────────────────

test("source: the request-path Redis calls all carry a deadline", async () => {
  const { readFileSync } = await import("node:fs");

  const client = readFileSync("src/lib/redis/client.ts", "utf8");
  assert.match(
    client,
    /signal:\s*\(\)\s*=>\s*AbortSignal\.timeout\(/,
    "the Redis client must carry a per-request AbortSignal (a factory, called once per request)",
  );
  assert.match(client, /withTimeout\(/, "withRedis must race the deadline too");

  const rateLimit = readFileSync("src/lib/security/rateLimit.ts", "utf8");
  const remoteLimiter = rateLimit.slice(
    rateLimit.indexOf("async function consumeRemoteRateLimit"),
    rateLimit.indexOf("function consumeInMemoryRateLimit"),
  );
  assert.match(remoteLimiter, /AbortSignal\.timeout\(/, "the remote limiter needs a deadline");
  const fetches = [...remoteLimiter.matchAll(/await fetch\(/g)].length;
  // CRLF-tolerant: the sources are checked out with Windows line endings here.
  const signalled = [...remoteLimiter.matchAll(/\r?\n\s+signal,\r?\n/g)].length;
  assert.ok(fetches > 0, "the remote limiter should still call fetch");
  assert.equal(
    signalled,
    fetches,
    "every remote-limiter fetch must pass the shared signal",
  );

  const health = readFileSync("src/app/api/health/route.ts", "utf8");
  assert.match(health, /withTimeout\(/, "both health checks must be bounded");
});
