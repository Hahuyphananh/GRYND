// src/lib/rooms/api.ts
//
// Shared plumbing for the /api/rooms/* routes: the age/auth gate, the uniform
// error shape, and the rate limits. Kept in ONE place so every route answers a
// denial the same way (and the UI can localise on `code` instead of parsing a
// message).
//
// WHY THE AGE GATE IS HERE: src/proxy.ts only guards page navigations — every
// /api/* path is public to the middleware — so each route that starts, joins or
// answers a game must verify the caller itself. Rooms lead straight into a game,
// so every MUTATING room route calls requireAgeVerifiedUser() (the same 18+ gate
// every game API uses) and every read route only requires a session. Inviting is
// gated too: it is a mutation that only a player who could be seated in the
// match has any use for.
//
// RATE LIMITS (abuse, not gameplay):
//   create    12 / hour   — creating rooms is cheap for us and rare for a player;
//   challenge 20 / hour   — a free feature, but not a notification cannon;
//   invite    60 / hour   — inviting several friends into one room is normal;
//   join      30 / minute — the guard on guessing a room code.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { readGuestId } from "../auth/guestSession";
import { requirePvpPlayer } from "../auth/guestPvp";
import { consumeRateLimit, type LimitConfig } from "../security/rateLimit";

/** The uniform failure body. `code` is stable; `error` is a fallback string. */
export function apiError(status: number, code: string, error: string) {
  return NextResponse.json({ success: false, code, error }, { status });
}

/** The shape every store result shares when it failed. */
export interface FailureLike {
  status?: number;
  code?: string;
  message?: string;
}

/** A store failure as an HTTP response. */
export function failureResponse(failure: FailureLike) {
  return apiError(
    failure.status ?? 400,
    failure.code ?? "room_denied",
    failure.message ?? "This action is not allowed",
  );
}

/**
 * Authenticate a mutating room request.
 *
 * TWO verified identities are admitted (Phase 3D):
 *   * an ACCOUNT — Clerk session + the same 18+ age gate as before;
 *   * a GUEST   — the HMAC-signed `grynd_guest` cookie, read by
 *                 `requirePvpPlayer` from the cookie store only. A body,
 *                 query or header id is never an identity.
 *
 * Account-only room actions (inviting a friend, friend challenges) re-check
 * `actor.isGuest` in their routes; the rules module refuses them as well.
 */
export async function requireRoomActor(): Promise<
  | { response: Response; userId: null; isGuest: false }
  | { response: null; userId: string; isGuest: boolean }
> {
  const player = await requirePvpPlayer();
  if (player.response) {
    return { response: player.response, userId: null, isGuest: false };
  }
  return { response: null, userId: player.playerId as string, isGuest: player.isGuest };
}

/**
 * Authenticate a room READ.
 *
 * Accounts keep exactly the old read rule — any Clerk session, no age gate (the
 * 18+ gate applies to playing, and a player may read an invitation before
 * answering it). Guests may read with their signed cookie. Neither path can
 * name another identity.
 */
export async function requireRoomViewer(): Promise<
  | { response: Response; userId: null; isGuest: false }
  | { response: null; userId: string; isGuest: boolean }
> {
  const { userId } = await auth();
  if (userId) return { response: null, userId, isGuest: false };

  const guestId = await readGuestId();
  if (!guestId) {
    return {
      response: apiError(401, "unauthenticated", "Unauthorized"),
      userId: null,
      isGuest: false,
    };
  }
  return { response: null, userId: guestId, isGuest: true };
}

/**
 * Consume one token from a limiter. Returns a 429 response when the caller is
 * over the limit, otherwise null.
 */
export async function enforceRateLimit(
  key: string,
  config: LimitConfig,
): Promise<Response | null> {
  try {
    const result = await consumeRateLimit(key, config);
    if (!result.allowed) {
      const retryAfter = Math.max(Math.ceil((result.resetAt - Date.now()) / 1000), 1);
      return NextResponse.json(
        {
          success: false,
          code: "rate_limited",
          error: "Too many requests — please slow down",
          retryAfter,
        },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  } catch {
    // A limiter outage must not take the feature down: rooms are still
    // authorized by membership, friendship and code secrecy.
  }
  return null;
}

export const ROOM_LIMITS = {
  create: { windowMs: 60 * 60 * 1000, max: 12 },
  challenge: { windowMs: 60 * 60 * 1000, max: 20 },
  invite: { windowMs: 60 * 60 * 1000, max: 60 },
  join: { windowMs: 60 * 1000, max: 30 },
} as const;

/** The route segment for a room id, validated before it reaches the store. */
export function readRoomId(value: unknown): string {
  return String(value ?? "").trim();
}
