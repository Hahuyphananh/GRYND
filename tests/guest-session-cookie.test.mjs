// tests/guest-session-cookie.test.mjs
//
// Phase 1A — GUEST IDENTITY RELIABILITY.
//
// The guest model (src/lib/auth/guestSession.ts) hands a signed-out visitor a
// signed `guest_<uuid>` id in an HttpOnly `grynd_guest` cookie so they can play
// the free vs-AI practice modes. The cookie's `Secure` attribute used to be
// derived from `NODE_ENV` alone, which made a production build served over
// plain HTTP unusable: the browser drops a `Secure` cookie from an insecure
// origin, so every request minted a NEW guest id.
//
// These tests drive the REAL module through a faked cookie jar and header store
// (only `next/headers` and Clerk are mocked), so the attributes actually
// written, the signature checks actually performed, and the gate actually
// returned are what is asserted — not a copy of the source.
//
// Run: node --import tsx --test --experimental-test-module-mocks tests/guest-session-cookie.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GUEST_COOKIE = "grynd_guest";
const GUEST_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, unchanged
const USER_ID = "user_signed_in";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// tsx loads src/lib/auth/guestSession.ts as CommonJS, so its `@clerk/nextjs/server`
// import resolves to the package's CJS entry while this test file sees the ESM
// one. Node's mock registry keys on the resolved file, so Clerk is mocked under
// both. (See the note in tests/speed-typing-security.test.mjs: `@clerk/backend`
// itself is never mocked — nothing here touches it.)
const CLERK_SERVER_CJS = pathToFileURL(
  createRequire(import.meta.url).resolve("@clerk/nextjs/server"),
).href;

// ── Fakes ───────────────────────────────────────────────────────────────────
// `jar` is one browser's cookie storage; `writes` records every Set-Cookie the
// module asks for (that is how cookie attributes are observed without HTTP).
let jar = new Map();
let writes = [];
let request = { forwardedProto: "https", userId: null, gate: "ok" };

function newBrowser() {
  jar = new Map();
  writes = [];
}

function cookieStore() {
  return {
    get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name, value, options) => {
      jar.set(name, value);
      writes.push({ name, value, options });
    },
  };
}

function headerStore() {
  const store = new Headers({ host: "grynd.test" });
  if (request.forwardedProto) store.set("x-forwarded-proto", request.forwardedProto);
  return store;
}

function installMocks(t) {
  t.mock.module("next/headers", {
    namedExports: {
      cookies: async () => cookieStore(),
      headers: async () => headerStore(),
    },
  });
  // Clerk decides whether the caller is signed in; a practice route must treat
  // both kinds of caller correctly, so it is the only thing a test switches.
  const clerkServer = { namedExports: { auth: async () => ({ userId: request.userId }) } };
  t.mock.module("@clerk/nextjs/server", clerkServer);
  t.mock.module(CLERK_SERVER_CJS, clerkServer);
  t.mock.module("../src/lib/auth/requireAgeVerified.ts", {
    namedExports: {
      requireAgeVerifiedUser: async () => {
        if (request.gate === "blocked") {
          return {
            response: Response.json(
              { success: false, error: "Age verification required" },
              { status: 403 },
            ),
            userId: null,
          };
        }
        return { response: null, userId: request.userId };
      },
    },
  });
}

const guestSession = () => import("../src/lib/auth/guestSession.ts");

function reset(forwardedProto = "https") {
  newBrowser();
  request = { forwardedProto, userId: null, gate: "ok" };
}

// ── Cookie attributes ───────────────────────────────────────────────────────

test("an HTTPS request gets a Secure guest cookie with the unchanged attributes", async (t) => {
  installMocks(t);
  reset("https");
  const { resolveGuestId } = await guestSession();

  const id = await resolveGuestId({ create: true });

  assert.match(id, /^guest_[0-9a-f]{32}$/, "the guest id format must not change");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, GUEST_COOKIE);
  assert.equal(writes[0].value.split(".")[0], id);
  assert.deepEqual(writes[0].options, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: GUEST_MAX_AGE,
  });
});

test("an HTTP request gets the same cookie WITHOUT Secure", async (t) => {
  installMocks(t);
  reset("http");
  const { resolveGuestId } = await guestSession();

  await resolveGuestId({ create: true });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].options, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: GUEST_MAX_AGE,
  });
  // Everything except `Secure` is identical to the HTTPS case.
  assert.equal(writes[0].options.httpOnly, true);
  assert.equal(writes[0].options.sameSite, "lax");
  assert.equal(writes[0].options.path, "/");
  assert.equal(writes[0].options.maxAge, GUEST_MAX_AGE);
});

test("with no scheme header the previous production default is kept", async (t) => {
  installMocks(t);
  reset(null);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const { resolveGuestId } = await guestSession();

  await resolveGuestId({ create: true });

  assert.equal(
    writes[0].options.secure,
    true,
    "a runtime that reports no scheme must not silently downgrade production",
  );
});

test("the scheme helper reads the first proxy hop and ignores junk", async () => {
  const { httpsFromForwardedProto, isHttpsRequest } = await import("../src/lib/auth/adminMfa.ts");

  assert.equal(httpsFromForwardedProto(() => "https"), true);
  assert.equal(httpsFromForwardedProto(() => "http"), false);
  assert.equal(httpsFromForwardedProto(() => "HTTPS, http"), true);
  assert.equal(httpsFromForwardedProto(() => "http, https"), false);
  assert.equal(httpsFromForwardedProto(() => null), null);
  assert.equal(httpsFromForwardedProto(() => "gopher"), null);

  // The existing request-based helper keeps its behaviour: the proxy header
  // wins over the URL's protocol.
  assert.equal(
    isHttpsRequest({ headers: new Headers({ "x-forwarded-proto": "http" }), url: "https://grynd.test/api" }),
    false,
  );
  assert.equal(
    isHttpsRequest({ headers: new Headers({ "x-forwarded-proto": "https" }), url: "http://localhost/api" }),
    true,
  );
});

// ── Identity stability ──────────────────────────────────────────────────────

test("a guest keeps one identity across repeated requests and tabs", async (t) => {
  installMocks(t);
  reset();
  const { resolveGuestId, readGuestId } = await guestSession();

  const first = await resolveGuestId({ create: true });
  assert.equal(await readGuestId(), first);
  assert.equal(await resolveGuestId(), first);
  assert.equal(await resolveGuestId({ create: false }), first);
  assert.equal(writes.length, 1, "a follow-up request must not re-issue the cookie");
  assert.equal(jar.get(GUEST_COOKIE).split(".")[0], first);
});

test("different browsers get independent guest identities", async (t) => {
  installMocks(t);
  const { resolveGuestId } = await guestSession();

  reset();
  const a = await resolveGuestId({ create: true });
  newBrowser();
  const b = await resolveGuestId({ create: true });

  assert.notEqual(a, b);
  assert.match(a, /^guest_/);
  assert.match(b, /^guest_/);
});

// ── Forgery rejection ───────────────────────────────────────────────────────

test("a tampered signature is rejected and never authenticates a guest", async (t) => {
  installMocks(t);
  reset();
  const { resolveGuestId, readGuestId, requirePracticePlayer } = await guestSession();

  await resolveGuestId({ create: true });
  const [id, signature] = jar.get(GUEST_COOKIE).split(".");
  const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  jar.set(GUEST_COOKIE, `${id}.${flipped}`);

  assert.equal(await readGuestId(), null);
  assert.equal(await resolveGuestId(), null);

  const gate = await requirePracticePlayer();
  assert.equal(gate.response?.status, 401);
  assert.equal(gate.playerId, null);
  assert.equal(gate.isGuest, false);
});

test("a signature bound to another guest id does not transfer ownership", async (t) => {
  installMocks(t);
  reset();
  const { resolveGuestId, readGuestId } = await guestSession();

  const first = await resolveGuestId({ create: true });
  newBrowser();
  const second = await resolveGuestId({ create: true });
  const secondSignature = jar.get(GUEST_COOKIE).split(".")[1];

  // Reuse the second visitor's genuine signature on the first person's id.
  jar.set(GUEST_COOKIE, `${first}.${secondSignature}`);

  assert.notEqual(first, second);
  assert.equal(await readGuestId(), null, "the HMAC is over the id, not just a token");
});

test("an invalid guest id is rejected even when its signature is valid", async (t) => {
  installMocks(t);
  reset();
  const { readGuestId, requirePracticePlayer, serializeGuestCookie } = await guestSession();

  for (const badId of [
    "",
    "guest_",
    "user_2abc",
    "guest_with space",
    `guest_${"a".repeat(80)}`,
    "guest_abc!",
  ]) {
    jar.set(GUEST_COOKIE, await serializeGuestCookie(badId));
    assert.equal(await readGuestId(), null, `"${badId}" must never be a guest identity`);
  }

  const gate = await requirePracticePlayer();
  assert.equal(gate.response?.status, 401);
  assert.equal(gate.isGuest, false);
});

// ── Missing cookie ──────────────────────────────────────────────────────────

test("a missing cookie neither authenticates nor mints a guest", async (t) => {
  installMocks(t);
  reset();
  const { readGuestId, resolveGuestId, requirePracticePlayer } = await guestSession();

  assert.equal(await readGuestId(), null);
  assert.equal(await resolveGuestId(), null);
  assert.equal(await resolveGuestId({ create: false }), null);
  assert.equal(writes.length, 0, "create:false must never set the cookie");

  const gate = await requirePracticePlayer();
  assert.equal(gate.response?.status, 401);
  assert.deepEqual(await gate.response.json(), {
    success: false,
    error: "Unauthorized",
    reason: "unauthenticated",
  });
  assert.equal(writes.length, 0);
});

// ── Practice access + registered users ──────────────────────────────────────

test("a guest is admitted to practice and keeps the seat on follow-up requests", async (t) => {
  installMocks(t);
  reset();
  const { requirePracticePlayer } = await guestSession();

  const entry = await requirePracticePlayer({ create: true });
  assert.equal(entry.response, null);
  assert.equal(entry.isGuest, true);
  assert.match(entry.playerId, /^guest_[0-9a-f]{32}$/);
  assert.equal(writes.length, 1);

  const followUp = await requirePracticePlayer();
  assert.equal(followUp.response, null);
  assert.equal(followUp.isGuest, true);
  assert.equal(followUp.playerId, entry.playerId);
  assert.equal(writes.length, 1, "follow-up routes read the cookie, they do not mint one");
});

test("a signed-in player is unchanged and never gets a guest identity", async (t) => {
  installMocks(t);
  reset();

  // A guest cookie already in the browser must not override the account.
  const { requirePracticePlayer } = await guestSession();
  const guestEntry = await requirePracticePlayer({ create: true });
  assert.equal(guestEntry.isGuest, true);

  request.userId = USER_ID;
  const signedIn = await requirePracticePlayer({ create: true });
  assert.deepEqual(signedIn, { response: null, playerId: USER_ID, isGuest: false });
  assert.equal(writes.length, 1, "a signed-in caller is never issued a guest cookie");

  // The age gate still runs for a signed-in caller.
  request.gate = "blocked";
  const blocked = await requirePracticePlayer({ create: true });
  assert.equal(blocked.response?.status, 403);
  assert.equal(blocked.playerId, null);
  assert.equal(blocked.isGuest, false);
  assert.equal(writes.length, 1);
});

test("the Secure flag is wired to the request scheme, not NODE_ENV", () => {
  const src = read("src/lib/auth/guestSession.ts");
  assert.match(src, /guestCookieOptions\(await guestCookieSecure\(\)\)/);
  assert.match(src, /httpsFromForwardedProto/);
  assert.doesNotMatch(
    src,
    /secure:\s*process\.env\.NODE_ENV/,
    "the cookie's Secure attribute must follow the request scheme",
  );
  // The identity format and the signing algorithm are untouched.
  assert.match(src, /`\$\{GUEST_ID_PREFIX\}\$\{crypto\.randomUUID\(\)\.replace\(\/-\/g, ""\)\}`/);
  assert.match(src, /"HMAC", hash: "SHA-256"/);
});
