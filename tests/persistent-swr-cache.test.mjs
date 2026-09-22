import assert from "node:assert/strict";
import test from "node:test";

import {
  CACHE_PREFIX,
  clearPersistentCache,
  createPersistentSwrCache,
  getCacheTimestamp,
  isPersistableKey,
} from "../src/lib/cache/persistentSwrCache.js";

/** Minimal localStorage stand-in, with a settable quota. */
function makeStorage({ quota = Infinity } = {}) {
  const store = new Map();
  let used = 0;
  return {
    get length() {
      return store.size;
    },
    key(i) {
      return [...store.keys()][i] ?? null;
    },
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      const next = used - (store.get(k)?.length ?? 0) + String(v).length;
      if (next > quota) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      used = next;
      store.set(k, String(v));
    },
    removeItem(k) {
      used -= store.get(k)?.length ?? 0;
      store.delete(k);
    },
    clear() {
      store.clear();
      used = 0;
    },
    _store: store,
  };
}

function withWindow(storage) {
  const previous = globalThis.window;
  globalThis.window = { localStorage: storage };
  return () => {
    globalThis.window = previous;
  };
}

test("hydrates previously persisted values", () => {
  const storage = makeStorage();
  const restore = withWindow(storage);
  storage.setItem(
    `${CACHE_PREFIX}/api/leaderboard/all-time`,
    JSON.stringify({ t: Date.now(), v: { items: [{ rank: 1 }] } }),
  );

  const cache = createPersistentSwrCache();
  assert.deepEqual(cache.get("/api/leaderboard/all-time"), { items: [{ rank: 1 }] });
  restore();
});

test("drops entries older than the TTL on hydrate", () => {
  const storage = makeStorage();
  const restore = withWindow(storage);
  storage.setItem(
    `${CACHE_PREFIX}/api/old`,
    JSON.stringify({ t: Date.now() - 25 * 60 * 60 * 1000, v: { stale: true } }),
  );

  const cache = createPersistentSwrCache();
  assert.equal(cache.get("/api/old"), undefined);
  assert.equal(storage.getItem(`${CACHE_PREFIX}/api/old`), null);
  restore();
});

test("persists public keys but keeps user-scoped keys in memory only", () => {
  const storage = makeStorage();
  const restore = withWindow(storage);
  const cache = createPersistentSwrCache();

  cache.set("/api/leaderboard/all-time?limit=50", { items: [] });
  cache.set("/api/get-user-tokens", { data: { balance: 999 } });

  assert.ok(storage.getItem(`${CACHE_PREFIX}/api/leaderboard/all-time?limit=50`));
  assert.equal(storage.getItem(`${CACHE_PREFIX}/api/get-user-tokens`), null);
  // Still readable in-session.
  assert.deepEqual(cache.get("/api/get-user-tokens"), { data: { balance: 999 } });

  assert.equal(isPersistableKey("/api/get-user-tokens"), false);
  assert.equal(isPersistableKey("/api/membership/status"), false);
  assert.equal(isPersistableKey("/api/leaderboard/all-time"), true);
  restore();
});

test("clearPersistentCache wipes only app-owned keys", () => {
  const storage = makeStorage();
  const restore = withWindow(storage);
  storage.setItem("theme", "dark");
  const cache = createPersistentSwrCache();
  cache.set("/api/leaderboard/all-time", { items: [] });

  clearPersistentCache();

  assert.equal(storage.getItem("theme"), "dark");
  assert.equal(storage.getItem(`${CACHE_PREFIX}/api/leaderboard/all-time`), null);
  restore();
});

test("survives a quota error without throwing", () => {
  const storage = makeStorage({ quota: 120 });
  const restore = withWindow(storage);
  const cache = createPersistentSwrCache();

  for (let i = 0; i < 30; i++) {
    assert.doesNotThrow(() => cache.set(`/api/thing/${i}`, { i }));
  }
  // Value is always available from memory even when it can't be persisted.
  assert.deepEqual(cache.get("/api/thing/29"), { i: 29 });
  restore();
});

test("getCacheTimestamp reports when a key was written", () => {
  const storage = makeStorage();
  const restore = withWindow(storage);
  const cache = createPersistentSwrCache();
  const before = Date.now();
  cache.set("/api/leaderboard/all-time", { items: [] });

  const stamp = getCacheTimestamp("/api/leaderboard/all-time");
  assert.ok(stamp >= before && stamp <= Date.now() + 1000);
  assert.equal(getCacheTimestamp("/api/get-user-tokens"), null);
  restore();
});

test("no window (SSR) yields an inert but usable in-memory cache", () => {
  const previous = globalThis.window;
  delete globalThis.window;
  const cache = createPersistentSwrCache();
  cache.set("/api/x", { ok: true });
  assert.deepEqual(cache.get("/api/x"), { ok: true });
  assert.equal(getCacheTimestamp("/api/x"), null);
  assert.doesNotThrow(() => clearPersistentCache());
  globalThis.window = previous;
});
