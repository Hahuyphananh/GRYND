/**
 * proxy-self-rewrite.test.mjs — the Node-runtime proxy must never proxy to itself.
 *
 * WHAT WENT WRONG (production, reproduced locally): Clerk's middleware decorates
 * every request and then hands the render an `x-middleware-rewrite` pointing at
 * the request's OWN url (it does `new URL(req.url)`). On the Node runtime Next
 * decides "internal or external?" by comparing that url's origin with the origin
 * it built from the server's BIND address, so `http://localhost:3000/x` against a
 * `127.0.0.1:3000` bind reads as EXTERNAL: Next returns `finished: true` and
 * proxies the request to this same server with httpxy, which runs the middleware
 * again, which rewrites to itself again. The client receives zero bytes until the
 * 30s proxyTimeout, then a 500 "Internal Server Error", and the journal fills with
 * `MaxListenersExceededWarning … close listeners added to [ServerResponse]`.
 *
 * These tests pin the normaliser that turns that self-rewrite back into an
 * internal continuation, and pin that a rewrite to a REAL external host is left
 * alone (so genuine proxying still works).
 *
 * Run:  node --import tsx --test tests/proxy-self-rewrite.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { internalizeMiddlewareSelfRewrite } from "../src/lib/security/middlewareSelfRewrite.ts";

/** A response's headers, as Next hands them to the router. */
function headers(init = {}) {
  return new Headers(init);
}

test("clerk: a rewrite to the same url on the app's own origin becomes a continuation", () => {
  // Exactly the shape Clerk emits on a resume: same path, absolute loopback url,
  // with the auth decoration headers alongside it.
  const h = headers({
    "x-middleware-rewrite": "http://localhost:3000/casino/hillstrike",
    "x-middleware-override-headers": "host,x-clerk-auth-status",
    "x-middleware-request-x-clerk-auth-status": "signed-out",
  });

  assert.equal(internalizeMiddlewareSelfRewrite(h, "http://localhost:3000/casino/hillstrike"), true);

  assert.equal(h.get("x-middleware-rewrite"), null, "the external-looking rewrite is gone");
  assert.equal(
    h.get("x-middleware-next"),
    "1",
    "and the request continues to the page instead of being proxied or refreshed",
  );
  // The decorations the render reads must survive untouched.
  assert.equal(h.get("x-middleware-override-headers"), "host,x-clerk-auth-status");
  assert.equal(h.get("x-middleware-request-x-clerk-auth-status"), "signed-out");
});

test("clerk: the same rewrite is internalised even when the bind address differs", () => {
  // The production shape: Next builds the middleware request url from `localhost`
  // while `next start -H 127.0.0.1` binds the request's initUrl to 127.0.0.1.
  const h = headers({ "x-middleware-rewrite": "http://localhost:3000/settings" });

  assert.equal(internalizeMiddlewareSelfRewrite(h, "http://127.0.0.1:3000/settings"), true);
  assert.equal(h.get("x-middleware-rewrite"), null);
  assert.equal(h.get("x-middleware-next"), "1");
});

test("clerk: a rewrite to a different path is left untouched", () => {
  // Our own 404 sentinel: a real cross-path rewrite. It must NOT become a
  // continuation (the wrong page would render), and it must NOT be "cleaned"
  // to a relative value: `adapter.js` re-parses the header with
  // `new NextURL(value)`, which throws ERR_INVALID_URL on a relative input and
  // turns the rewrite into an instant 500. Leaving it absolute keeps the
  // pre-existing behaviour instead of inventing a new failure mode.
  const h = headers({ "x-middleware-rewrite": "http://localhost:3000/__unknown-game-slug" });

  assert.equal(internalizeMiddlewareSelfRewrite(h, "http://localhost:3000/games/typo"), false);
  assert.equal(h.get("x-middleware-rewrite"), "http://localhost:3000/__unknown-game-slug");
  assert.equal(h.get("x-middleware-next"), null, "a real rewrite is not a continuation");
});

test("clerk: a rewrite to a real external host is left alone", () => {
  // Sentry's tunnel and the PostHog ingestion rewrite are genuine proxies; the
  // fix must not touch them.
  for (const target of [
    "https://o123.ingest.sentry.io/api/456/envelope/?hsts=0",
    "https://us.i.posthog.com/e",
  ]) {
    const h = headers({ "x-middleware-rewrite": target });
    assert.equal(
      internalizeMiddlewareSelfRewrite(h, "http://localhost:3000/page"),
      false,
      `${target} is external`,
    );
    assert.equal(h.get("x-middleware-rewrite"), target);
    assert.equal(h.get("x-middleware-next"), null);
  }
});

test("clerk: a response with no rewrite is untouched", () => {
  const h = headers({ "x-middleware-next": "1" });
  assert.equal(internalizeMiddlewareSelfRewrite(h, "http://localhost:3000/"), false);
  assert.equal(h.get("x-middleware-next"), "1");
});

test("clerk: query strings are compared, so a rewrite that changes only them is kept", () => {
  const same = headers({ "x-middleware-rewrite": "http://localhost:3000/x?tab=2" });
  assert.equal(internalizeMiddlewareSelfRewrite(same, "http://localhost:3000/x?tab=2"), true);
  assert.equal(same.get("x-middleware-next"), "1");

  const changed = headers({ "x-middleware-rewrite": "http://localhost:3000/x?tab=3" });
  assert.equal(internalizeMiddlewareSelfRewrite(changed, "http://localhost:3000/x?tab=2"), false);
  assert.equal(changed.get("x-middleware-rewrite"), "http://localhost:3000/x?tab=3");
  assert.equal(changed.get("x-middleware-next"), null);
});

test("every rewrite that is kept stays absolute, because Next cannot parse a relative one", () => {
  // `adapter.js`: `const destination = new NextURL(rewrite, {...})`, and
  // NextURL does `new URL(String(url), String(base))`. A relative value (the
  // obvious-looking "fix") therefore throws ERR_INVALID_URL and every affected
  // request becomes a 500. Pin the invariant for all the kept cases.
  const cases = [
    ["http://localhost:3000/__unknown-game-slug", "http://localhost:3000/games/typo"],
    ["http://localhost:3000/x?tab=3", "http://localhost:3000/x?tab=2"],
    ["https://o123.ingest.sentry.io/api/456/envelope/?hsts=0", "http://localhost:3000/monitoring"],
  ];
  for (const [rewrite, requestUrl] of cases) {
    const h = headers({ "x-middleware-rewrite": rewrite });
    internalizeMiddlewareSelfRewrite(h, requestUrl);
    const kept = h.get("x-middleware-rewrite");
    assert.ok(kept, `${rewrite} must keep its rewrite`);
    assert.doesNotThrow(() => new URL(kept), `${kept} must stay absolute`);
  }
});

test("source: the proxy applies the normaliser to Clerk's response", () => {
  // The unit above is only half the contract — the proxy has to CALL it on the
  // one path that can emit the self-rewrite.
  const source = readFileSync("src/proxy.ts", "utf8");
  assert.ok(
    source.includes(
      "internalizeMiddlewareSelfRewrite(response.headers, req.url)",
    ),
    "src/proxy.ts must normalise Clerk's rewrite before returning it",
  );
  assert.ok(
    source.includes("await clerkProtectedMiddleware(req, event)"),
    "and it must be the response of the Clerk-protected middleware",
  );
});
