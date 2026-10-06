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
import { cookies } from "next/headers";
import { requireAgeVerifiedUser } from "./requireAgeVerified";
import {
  GUEST_COOKIE,
  GUEST_COOKIE_MAX_AGE_SECONDS,
  GUEST_ID_PREFIX,
  isGuestId,
} from "../guestIdentity";

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
 * Read the caller's existing guest id, or null when they hold none (or the
 * cookie was forged). Never mutates the request.
 */
export async function readGuestId(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(GUEST_COOKIE)?.value;
  if (!raw || typeof raw !== "string" || !raw.includes(".")) return null;

  const [id, signature] = raw.split(".");
  if (!isGuestId(id)) return null;
  if (!(await verifySignature(id, signature))) return null;
  return id;
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
  store.set(GUEST_COOKIE, `${id}.${await sign(id)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE_SECONDS,
  });
  return id;
}

/**
 * The gate for FREE PRACTICE (vs AI) routes.
 *
 * Signed in  → the caller goes through the normal 18+ age gate, unchanged.
 * Signed out → the caller is issued a guest identity and allowed in.
 *
 * `create` must be true only on the route that STARTS a practice match; every
 * follow-up route of that match reads the cookie instead of minting a new one,
 * so a stray request can never spawn a second guest identity.
 */
export async function requirePracticePlayer({
  create = false,
}: { create?: boolean } = {}): Promise<PracticePlayer> {
  const { userId } = await auth();
  if (userId) {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) {
      return { response: gate.response, playerId: null, isGuest: false };
    }
    return { response: null, playerId: gate.userId ?? userId, isGuest: false };
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
