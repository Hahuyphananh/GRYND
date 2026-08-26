/**
 * Logout hygiene — unit tests for:
 *   • src/lib/security/sessionCleanup.ts   (client-side artifact sweep)
 *   • src/app/api/auth/clear-session/route.ts (HttpOnly cookie deletion)
 *
 * Runs outside a browser / Next.js server. The client helper is exercised
 * against fake web APIs (window/document/fetch), the route handler against
 * a mocked `next/headers` cookie jar:
 *
 *   node --import tsx --experimental-test-module-mocks --test tests/session-cleanup.test.mjs
 *
 * (or: npm run test:session-cleanup)
 *
 * Covered paths:
 *   • no-op without a browser window (SSR guard)
 *   • auth-related sessionStorage/localStorage keys removed
 *   • device preferences (theme, consent, tour, PB, …) preserved
 *   • csrf_token cookie expired with the right attributes
 *   • keepalive POST to /api/auth/clear-session, failures swallowed
 *   • storage throwing (private mode) is swallowed
 *   • clear-session route deletes admin_mfa + Clerk cookies with Max-Age=0
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";


// ════════════════════════════════════════════════════════════════════════
// Fake browser environment
// ════════════════════════════════════════════════════════════════════════

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

function installBrowserGlobals({ session = {}, local = {}, fetchImpl } = {}) {
  const fetchCalls = [];
  globalThis.window = {
    location: { protocol: "https:" },
    sessionStorage: makeStorage(session),
    localStorage: makeStorage(local),
  };
  globalThis.document = { cookie: "" };
  globalThis.fetch = (url, opts) => {
    fetchCalls.push({ url, opts });
    if (fetchImpl) return fetchImpl(url, opts);
    return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
  };
  return { fetchCalls };
}

// ════════════════════════════════════════════════════════════════════════
// Client helper
// ════════════════════════════════════════════════════════════════════════

test("client cleanup: no-op without a browser window (SSR guard)", async () => {
  delete globalThis.window;
  delete globalThis.document;
  const { clearClientSessionArtifacts, clearSessionOnServer, clearSessionArtifacts } =
    await import("../src/lib/security/sessionCleanup.ts");

  // Must not throw and must not touch anything.
  clearClientSessionArtifacts();
  clearSessionOnServer();
  clearSessionArtifacts();
});

test("client cleanup: removes auth-related storage, keeps device preferences", async () => {
  const { clearClientSessionArtifacts } = await import(
    "../src/lib/security/sessionCleanup.ts"
  );

  installBrowserGlobals({
    session: {
      "admin:user_123": "true",
      "navmeta:user_123": '{"level":42}',
      "navmeta:user_123:t": "1700000000000",
      "precision:localSeat": "1", // match-scoped — must survive
    },
    local: {
      "hexDuelAiSessionId:user_123": "tok_abc",
      "grynd_cookie_consent": "accepted", // device pref — must survive
      "grynd_theme": "dark", // device pref — must survive
      "grynd_lang": "en", // device pref — must survive
      "precision:personalBest": "900", // device pref — must survive
      "grynd_tour_user_123": "done", // onboarding state — must survive
    },
  });

  clearClientSessionArtifacts();

  assert.equal(globalThis.window.sessionStorage.getItem("admin:user_123"), null);
  assert.equal(globalThis.window.sessionStorage.getItem("navmeta:user_123"), null);
  assert.equal(globalThis.window.sessionStorage.getItem("navmeta:user_123:t"), null);
  assert.equal(globalThis.window.sessionStorage.getItem("precision:localSeat"), "1");

  assert.equal(globalThis.window.localStorage.getItem("hexDuelAiSessionId:user_123"), null);
  assert.equal(globalThis.window.localStorage.getItem("grynd_cookie_consent"), "accepted");
  assert.equal(globalThis.window.localStorage.getItem("grynd_theme"), "dark");
  assert.equal(globalThis.window.localStorage.getItem("grynd_lang"), "en");
  assert.equal(globalThis.window.localStorage.getItem("precision:personalBest"), "900");
  assert.equal(globalThis.window.localStorage.getItem("grynd_tour_user_123"), "done");
});

test("client cleanup: sweeps leftovers from ALL users on the device", async () => {
  const { clearClientSessionArtifacts } = await import(
    "../src/lib/security/sessionCleanup.ts"
  );

  installBrowserGlobals({
    session: {
      "admin:user_a": "true",
      "navmeta:user_b": "x",
    },
    local: {
      "hexDuelAiSessionId:user_a": "tok_a",
      "hexDuelAiSessionId:user_b": "tok_b",
    },
  });

  clearClientSessionArtifacts();

  assert.equal(globalThis.window.sessionStorage.length, 0);
  assert.equal(globalThis.window.localStorage.length, 0);
});

test("client cleanup: expires the csrf_token cookie with safe attributes", async () => {
  const { clearClientSessionArtifacts } = await import(
    "../src/lib/security/sessionCleanup.ts"
  );

  installBrowserGlobals({ session: {}, local: {} });

  clearClientSessionArtifacts();

  assert.match(globalThis.document.cookie, /^csrf_token=; Max-Age=0; Path=\/; SameSite=Lax; Secure$/);
});

test("client cleanup: fires keepalive POST to clear-session; fetch failures are swallowed", async () => {
  const { clearSessionArtifacts, clearSessionOnServer } = await import(
    "../src/lib/security/sessionCleanup.ts"
  );

  // Failing fetch — must not throw (fire-and-forget defense in depth).
  installBrowserGlobals({
    session: { "admin:user_123": "true" },
    local: {},
    fetchImpl: () => Promise.reject(new Error("network down")),
  });
  clearSessionOnServer();
  clearSessionArtifacts();

  // Successful fetch — assert the exact request.
  installBrowserGlobals({ session: {}, local: {} });
  const { fetchCalls } = installBrowserGlobals({ session: {}, local: {} });
  clearSessionArtifacts();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/api/auth/clear-session");
  assert.equal(fetchCalls[0].opts.method, "POST");
  assert.equal(fetchCalls[0].opts.credentials, "include");
  assert.equal(fetchCalls[0].opts.keepalive, true);
  assert.equal(fetchCalls[0].opts.headers["Content-Type"], "application/json");
  assert.equal(fetchCalls[0].opts.body, "{}");
});

test("client cleanup: storage APIs throwing (private mode) is swallowed", async () => {
  const { clearClientSessionArtifacts } = await import(
    "../src/lib/security/sessionCleanup.ts"
  );

  const throwingStorage = {
    get length() {
      return 1;
    },
    key: () => "admin:user_123",
    removeItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  globalThis.window = {
    location: { protocol: "https:" },
    sessionStorage: throwingStorage,
    localStorage: throwingStorage,
  };
  globalThis.document = { cookie: "" };

  // Must not throw.
  clearClientSessionArtifacts();
});

// ════════════════════════════════════════════════════════════════════════
// Clear-session route
// ════════════════════════════════════════════════════════════════════════

test("logout cookies: clears admin_mfa + Clerk cookies with Max-Age=0", async () => {
  // The deletion logic lives in the pure logoutCookies module (the route is
  // a thin shell around it), so it is tested directly with a fake jar — no
  // Next.js runtime needed.
  const {
    LOGOUT_COOKIES,
    applyLogoutCookieDeletions,
  } = await import("../src/lib/security/logoutCookies.ts");

  const sets = [];
  applyLogoutCookieDeletions({
    set: (name, value, options) => sets.push({ name, value, options }),
  });

  const names = sets.map((s) => s.name);
  for (const expected of LOGOUT_COOKIES) {
    assert.ok(names.includes(expected), `expected cookie "${expected}" to be cleared`);
  }
  for (const expected of [
    "admin_mfa",
    "__session",
    "__client",
    "__client_uat",
    "__clerk_db_jwt",
    "__clerk_fingerprint",
    "csrf_token",
  ]) {
    assert.ok(names.includes(expected), `expected cookie "${expected}" to be cleared`);
  }

  for (const s of sets) {
    assert.equal(s.value, "");
    assert.equal(s.options.maxAge, 0);
    assert.equal(s.options.path, "/");
    assert.equal(s.options.sameSite, "lax");
  }
});
