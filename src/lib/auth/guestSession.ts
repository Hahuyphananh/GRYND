// src/lib/auth/guestSession.ts
//
// SERVER-side guest session: issue, read and verify the signed guest id that
// lets a signed-out visitor play the free "vs AI" practice modes.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE
//
//  1. A guest is only ever a PRACTICE player. `requirePracticePlayer()` is the
//     only way to obtain a guest identity, and it is deliberately NOT
//     `requireAgeVerifiedUser()`: it is the AI-practice call sites that switch
//     to it. Matchmaking / wagering routes keep the age gate, so a guest can
//     never create or join a PvP match. Practice routes are still safe to open
//     because every store authorises by SEAT — a guest id that holds no seat
//     gets the same 403 a signed-in stranger gets.
//
//  2. A guest is never a real account. The id is `guest_<uuid>` (see
//     src/lib/guestIdentity.ts), it has no `users` row, and every identity /
//     reward lookup in the app keys off the Clerk `user_` prefix — so a guest
//     resolves to no rating, no trophies and no stats by construction.
//
// Cookie format: `guest_<uuid>.<hmac>` signed with the same secret family the
// self-hosted MFA cookie uses, so a tampered or invented guest id is rejected
// (guests earn nothing, but an unsigned owner id would still let one visitor
// drive another visitor's practice match).

import { auth } from "@clerk/nextjs/server";
import { cookies, headers } from "next/headers";
import { httpsFromForwardedProto } from "./adminMfa";
import { requireAgeVerifiedUser } from "./requireAgeVerified";
import {
  GUEST_COOKIE,
  GUEST_COOKIE_MAX_AGE_SECONDS,
  GUEST_ID_PREFIX,
  isGuestId,
} from "../guestIdentity";
import { readPlatformGuest } from "../platform/session";

export { GUEST_COOKIE, isGuestId };

export type PracticePlayer = {
  /** A rejection to return, or null when the caller may play. */
  response: Response | null;
  /** Clerk user id for a signed-in player, `guest_<uuid>` for a guest. */
  playerId: string | null;
  /** True when `playerId` is a synthetic guest id. */
  isGuest: boolean;
};

function getSecret(): string {
  return (
    process.env.GUEST_SESSION_SECRET ||
    process.env.GAME_SESSION_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.CLERK_SECRET_KEY ||
    "development-only-insecure-secret"
  );
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: string): Promise<string> {
  const key = await getKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64urlEncode(new Uint8Array(sig));
}

/** Constant-time compare of a cookie signature against the expected one. */
async function verifySignature(payload: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  let provided: Uint8Array;
  try {
    provided = b64urlDecode(signature);
  } catch {
    return false;
  }
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", await getKey(), new TextEncoder().encode(payload)),
  );
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided[i] ^ expected[i];
  return diff === 0;
}

function newGuestId(): string {
  return `${GUEST_ID_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Attributes of the guest cookie: HttpOnly, SameSite=Lax, Path=/ and the same
 * 30-day lifetime as before. Only `Secure` varies, and it follows the request
 * scheme (see `guestCookieSecure`) instead of `NODE_ENV`: a production build
 * served over plain HTTP used to be handed a `Secure` cookie the browser
 * dropped, so every request minted a NEW guest id and the same visitor could
 * not hold one practice seat.
 */
export function guestCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE_SECONDS,
  };
}

/**
 * True when the guest cookie must carry `Secure`: HTTPS requests always,
 * plain-HTTP requests never (the browser refuses a `Secure` cookie from an
 * insecure origin, and a non-`Secure` one from a secure origin is rejected
 * too, so the flag has to follow the actual scheme).
 *
 * The scheme comes from the same trusted-proxy rule the auth helpers use
 * (`httpsFromForwardedProto` in ./adminMfa). `NODE_ENV === "production"` is
 * kept only as the fallback for a runtime that reports no scheme at all, so a
 * deployment that cannot be observed is never silently downgraded.
 */
export async function guestCookieSecure(): Promise<boolean> {
  try {
    const store = await headers();
    const detected = httpsFromForwardedProto((name) => store.get(name));
    if (detected !== null) return detected;
  } catch {
    // No request scope (only route handlers call this). Use the old default.
  }
  return process.env.NODE_ENV === "production";
}

/** The signed cookie value for a guest id: `<guest id>.<hmac>`. */
export async function serializeGuestCookie(guestId: string): Promise<string> {
  return `${guestId}.${await sign(guestId)}`;
}

/**
 * Validate a raw `grynd_guest` value. Returns the guest id only when the id is
 * well formed AND its HMAC matches; anything else — tampered, invented, wrong
 * prefix, truncated — is null. Never mints, never mutates.
 */
export async function readGuestIdFromCookieValue(raw: unknown): Promise<string | null> {
  if (!raw || typeof raw !== "string" || !raw.includes(".")) return null;

  const [id, signature] = raw.split(".");
  if (!isGuestId(id)) return null;
  if (!(await verifySignature(id, signature))) return null;
  return id;
}

/**
 * Read the caller's existing guest id, or null when they hold none (or the
 * cookie was forged). Never mutates the request.
 */
export async function readGuestId(): Promise<string | null> {
  const store = await cookies();
  return readGuestIdFromCookieValue(store.get(GUEST_COOKIE)?.value);
}

/**
 * Read the caller's guest id, minting (and setting) one when absent.
 *
 * Only the practice ENTRY routes pass `create: true`: a visitor who never
 * pressed "Play vs AI" should not accumulate session state, and the follow-up
 * routes of a practice match must require the cookie the entry route issued.
 */
export async function resolveGuestId({ create = false }: { create?: boolean } = {}): Promise<
  string | null
> {
  const existing = await readGuestId();
  if (existing) return existing;
  if (!create) return null;

  const id = newGuestId();
  const store = await cookies();
  store.set(
    GUEST_COOKIE,
    await serializeGuestCookie(id),
    guestCookieOptions(await guestCookieSecure()),
  );
  return id;
}

/**
 * The gate for FREE PRACTICE (vs AI) routes.
 *
 * Signed in  → the caller goes through the normal 18+ age gate, unchanged.
 * Embedded  → a verified platform bearer token, ONLY when the route names the
 *             game it belongs to (`platformGame`). The token is checked against
 *             the platform_sessions row: expiry, revocation and game scope.
 * Signed out → the caller is issued a guest identity and allowed in.
 *
 * `create` must be true only on the route that STARTS a practice match; every
 * follow-up route of that match reads the cookie instead of minting a new one,
 * so a stray request can never spawn a second guest identity.
 *
 * `platformGame` must be set ONLY on routes of an embedded game. Without it a
 * platform token is ignored entirely, so unrelated practice APIs cannot be
 * driven by an embed session.
 */
export async function requirePracticePlayer({
  create = false,
  platformGame,
}: { create?: boolean; platformGame?: string } = {}): Promise<PracticePlayer> {
  const { userId } = await auth();
  if (userId) {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) {
      return { response: gate.response, playerId: null, isGuest: false };
    }
    return { response: null, playerId: gate.userId ?? userId, isGuest: false };
  }

  // Embedded session: bearer token, never a cookie. Checked BEFORE any guest
  // cookie is read or minted, so an embed can never touch the browser's
  // standalone guest identity (and therefore never claim its progression).
  if (platformGame) {
    const platform = await readPlatformGuest(platformGame);
    if (platform) {
      return { response: null, playerId: platform.guestId, isGuest: true };
    }
  }

  const guestId = await resolveGuestId({ create });
  if (!guestId) {
    return {
      response: Response.json(
        { success: false, error: "Unauthorized", reason: "unauthenticated" },
        { status: 401 },
      ),
      playerId: null,
      isGuest: false,
    };
  }
  return { response: null, playerId: guestId, isGuest: true };
}
