// tests/guest-realtime.test.mjs
//
// Phase 3F — guest Socket.IO compatibility.
//
// What is under test:
//   1. REGISTERED — the Clerk `verifyToken` path is still the account path.
//   2. GUEST      — identity comes from the HMAC-signed `grynd_guest` cookie
//                   and nothing else; a supplied id is never an identity.
//   3. SCOPE      — a guest socket may only join its own game's match rooms.
//   4. LIMITS     — repeated guest room joins are bounded per socket.
//   5. ORIGIN     — CORS/origin handling is untouched (no wildcard added).
//
// Run: node --import tsx --test tests/guest-realtime.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const {
  readCookieValue,
  verifyGuestCookie,
} = requireCjs("../realtime-server/guestAuth.js");

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const server = code("realtime-server/server.js");
const GUEST_ID = `guest_${"a".repeat(32)}`;
const ENV = { GUEST_SESSION_SECRET: "test-secret" };

function cookieFor(id, secret = ENV.GUEST_SESSION_SECRET) {
  const signature = crypto.createHmac("sha256", secret).update(id).digest("base64url");
  return `${id}.${signature}`;
}

test("registered sockets still authenticate with a Clerk token", () => {
  assert.match(server, /verifyToken\(token,/);
  assert.match(server, /socket\.data\.userId = verified\.sub/);
  assert.match(server, /secretKey: CLERK_SECRET_KEY/);
});

test("a valid signed cookie resolves to its guest id", () => {
  assert.equal(verifyGuestCookie(cookieFor(GUEST_ID), ENV), GUEST_ID);
  assert.equal(
    readCookieValue(`a=b; grynd_guest=${cookieFor(GUEST_ID)}; c=d`, "grynd_guest"),
    cookieFor(GUEST_ID),
  );
});

test("forged, tampered and cross-guest cookies are refused", () => {
  const otherGuest = `guest_${"b".repeat(32)}`;
  const otherSignature = cookieFor(otherGuest).split(".")[1];

  assert.equal(verifyGuestCookie(`${GUEST_ID}.${otherSignature}`, ENV), null, "cross-guest signature");
  assert.equal(verifyGuestCookie(`${GUEST_ID}.${"A".repeat(43)}`, ENV), null, "invented signature");
  assert.equal(verifyGuestCookie(cookieFor(GUEST_ID, "other-secret"), ENV), null, "wrong secret");
  assert.equal(verifyGuestCookie(`${GUEST_ID}`, ENV), null, "unsigned id");
  assert.equal(verifyGuestCookie("user_2registered", ENV), null, "a Clerk id is not a guest");
  assert.equal(verifyGuestCookie(`guest_${"a".repeat(31)}${cookieFor(GUEST_ID).split(".")[1]}`, ENV), null, "malformed id");
  assert.equal(verifyGuestCookie(cookieFor(GUEST_ID), {}), null, "no configured secret fails closed");
  assert.equal(verifyGuestCookie(undefined, ENV), null);
});

test("a guest socket is identified only by the signed cookie", () => {
  const guestAuth = code("realtime-server/guestAuth.js");
  assert.match(guestAuth, /grynd_guest/);
  assert.match(guestAuth, /createHmac\("sha256", secret\)/);
  assert.match(guestAuth, /timingSafeEqual/);
  assert.match(server, /require\("\.\/guestAuth"\)/);
  assert.match(server, /verifyGuestCookie\(/);
  assert.match(server, /socket\.data\.isGuest = true/);
  // No handshake/query/payload field may set a guest identity.
  assert.doesNotMatch(server, /handshake\.auth\?\.guest/);
  assert.doesNotMatch(server, /handshake\.query\.guest/);
  assert.doesNotMatch(server, /socket\.data\.userId = (?:payload|data|msg)\./);
});

test("the guest middleware runs before Clerk and defers when a token exists", () => {
  const guestMiddleware = server.indexOf("verifyGuestCookie(");
  const clerkMiddleware = server.indexOf("verifyToken(token,");
  assert.ok(guestMiddleware > 0 && clerkMiddleware > guestMiddleware);
  assert.match(server, /if \(socket\.handshake\.auth\?\.token\) return next\(\);/);
});

test("a guest socket may only join dominoes match rooms, with a join budget", () => {
  assert.match(server, /startsWith\("dominoes:match:"\)/);
  assert.match(server, /allowGuestRoomJoin\(socket\)/);
  assert.match(server, /win\.count <= 60/);
});

test("origin and CORS handling were not loosened", () => {
  assert.match(server, /function isOriginAllowed\(origin\)/);
  assert.match(server, /if \(isOriginAllowed\(origin\)\) return callback\(null, true\)/);
  assert.doesNotMatch(server, /origin:\s*true/);
  assert.doesNotMatch(server, /origin:\s*["']\*["']/);
});
