// tests/dedupe-fetch.test.mjs
//
// Unit tests for src/lib/dedupeFetch.js — the helper that lets the profile's
// three /api/titles loaders (loadTitles, loadVipTitles, loadStreakTitles) share
// one in-flight response instead of sending the same request three times.
//
// Run: node --test tests/dedupe-fetch.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { fetchDeduped, releaseDeduped } from "../src/lib/dedupeFetch.js";

function jsonResponse(payload, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => payload };
}

/** Replace global fetch for the duration of one test. */
function stubFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init, calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("fetchDeduped: three concurrent identical calls issue a single request", async () => {
  const stub = stubFetch(async () => jsonResponse({ success: true, level: 7 }));

  try {
    const [first, second, third] = await Promise.all([
      fetchDeduped("/api/titles", { credentials: "include" }),
      fetchDeduped("/api/titles", { credentials: "include" }),
      fetchDeduped("/api/titles", { credentials: "include" }),
    ]);

    assert.equal(stub.calls.length, 1, "the network must be hit once, not three times");
    assert.equal(stub.calls[0].url, "/api/titles");
    assert.deepEqual(first.data, { success: true, level: 7 });
    assert.equal(second.response, first.response, "callers share the same response object");
    assert.deepEqual(third.data, { success: true, level: 7 });
  } finally {
    stub.restore();
  }
});

test("fetchDeduped: a settled response is not reused on the next call", async () => {
  const stub = stubFetch(async () => jsonResponse({ success: true, selectedTitle: "Rookie" }));

  try {
    await fetchDeduped("/api/titles", { credentials: "include" });
    assert.equal(stub.calls.length, 1);

    // No TTL cache on purpose: the profile refetches right after an equip, and a
    // cached response there would show the pre-change title.
    const again = await fetchDeduped("/api/titles", { credentials: "include" });

    assert.equal(stub.calls.length, 2, "a second call must revalidate");
    assert.deepEqual(again.data, { success: true, selectedTitle: "Rookie" });
  } finally {
    stub.restore();
  }
});

test("fetchDeduped: different request shapes are never shared", async () => {
  const stub = stubFetch(async () => jsonResponse({ success: true }));

  try {
    await Promise.all([
      fetchDeduped("/api/titles", { credentials: "include" }),
      fetchDeduped("/api/titles", { method: "POST", credentials: "include" }),
      fetchDeduped("/api/user-stats", { credentials: "include" }),
    ]);

    assert.equal(stub.calls.length, 3, "each distinct url/init pair gets its own request");
  } finally {
    stub.restore();
  }
});

test("fetchDeduped: a rejection reaches every caller and is not cached", async () => {
  let attempt = 0;
  const stub = stubFetch(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("network down");
    return jsonResponse({ success: true, recovered: true });
  });

  try {
    const results = await Promise.allSettled([
      fetchDeduped("/api/titles", { credentials: "include" }),
      fetchDeduped("/api/titles", { credentials: "include" }),
    ]);

    assert.equal(stub.calls.length, 1, "a failure is shared like any other outcome");
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, /network down/);
    }

    // The failed entry must have been released, so the next call retries.
    const retry = await fetchDeduped("/api/titles", { credentials: "include" });
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(retry.data, { success: true, recovered: true });
  } finally {
    stub.restore();
  }
});

test("releaseDeduped: drops an in-flight entry so the next call refetches", async () => {
  // One resolver per call, so a request can be held open on purpose.
  const resolvers = [];
  const stub = stubFetch(
    () =>
      new Promise((resolve) => {
        resolvers.push((label) => resolve(jsonResponse({ success: true, call: label })));
      }),
  );

  try {
    const pending = fetchDeduped("/api/titles", { credentials: "include" });
    assert.equal(stub.calls.length, 1);

    releaseDeduped("/api/titles");

    const second = fetchDeduped("/api/titles", { credentials: "include" });
    assert.equal(stub.calls.length, 2, "the released entry must not be reused");

    resolvers[0]("first");
    resolvers[1]("second");

    const [first, retried] = await Promise.all([pending, second]);
    assert.equal(first.data.call, "first");
    assert.equal(retried.data.call, "second");
  } finally {
    stub.restore();
  }
});
