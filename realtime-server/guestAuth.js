// realtime-server/guestAuth.js
//
// The guest half of socket authentication (Phase 3F).
//
// A signed-out visitor holds the SAME HMAC-signed `grynd_guest` cookie the
// Next.js guest session issues (src/lib/auth/guestSession.ts): the value is
// `<guest_<32 hex>>.<base64url HMAC-SHA256(id)>`. This module verifies it with
// the same secret chain and a constant-time compare, and it is the ONLY place
// a guest socket identity is produced.
//
// It is a separate CommonJS module (not inline in server.js) so the verification
// can be exercised directly by tests without booting the realtime server, and so
// the Next.js side and the socket side have one small, readable contract.
//
// WHAT IT DOES NOT DO: mint identities, read a handshake/query field, check
// expiry (the cookie's 30-day lifetime is enforced by the browser, the HMAC
// proves the id was issued by us), or trust the cookie for authorization. A
// verified guest id is still only a claim of seat identity — every match room
// checks the seat server-side.

const { createHmac, timingSafeEqual } = require("node:crypto");

const GUEST_COOKIE = "grynd_guest";

// Deliberately stricter than "starts with guest_": the Next.js session mints
// exactly `guest_<32 hex>`, and nothing else may become a socket identity.
const GUEST_ID_PATTERN = /^guest_[0-9a-f]{32}$/;

// Same precedence as getSecret() in src/lib/auth/guestSession.ts. An empty
// chain means guest auth fails closed; registered auth is unaffected.
const SECRET_ENV_VARS = [
  "GUEST_SESSION_SECRET",
  "GAME_SESSION_SECRET",
  "NEXTAUTH_SECRET",
  "CLERK_SECRET_KEY",
];

function guestSessionSecret(env = process.env) {
  for (const name of SECRET_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** The named value from a raw Cookie header, or null. */
function readCookieValue(header, name) {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Verify a raw `grynd_guest` cookie value. Returns the guest id only when it is
 * well formed AND its HMAC matches; anything else is null. Never mints.
 */
function verifyGuestCookie(raw, env = process.env) {
  if (typeof raw !== "string" || !raw.includes(".")) return null;
  const [id, signature] = raw.split(".");
  if (!GUEST_ID_PATTERN.test(id) || !signature) return null;
  const secret = guestSessionSecret(env);
  if (!secret) return null;
  const expected = createHmac("sha256", secret).update(id).digest("base64url");
  const provided = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (provided.length !== wanted.length) return null;
  return timingSafeEqual(provided, wanted) ? id : null;
}

module.exports = {
  GUEST_COOKIE,
  GUEST_ID_PATTERN,
  guestSessionSecret,
  readCookieValue,
  verifyGuestCookie,
};
