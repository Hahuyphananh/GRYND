// src/lib/auth/guestPvp.ts
//
// The PvP identity gate (Phase 3B): a verified ACCOUNT or a verified GUEST, and
// nothing else.
//
// WHY IT EXISTS: the practice gate (`requirePracticePlayer`) opens free vs-AI
// play to guests, while every matchmaking route still calls Clerk `auth()` and
// therefore 401s a guest. Guest PvP needs ONE gate that:
//
//   * keeps the signed-in path byte-for-byte identical (Clerk session + the same
//     18+ age gate every game API uses),
//   * resolves a signed-out caller ONLY from the HMAC-signed `grynd_guest`
//     cookie (`resolveGuestId`) — never from a body, query, header or storage,
//   * reports 401 when there is no valid cookie (missing, expired, forged),
//   * applies a per-identity rate limit to the guest path,
//   * keeps the two identity spaces disjoint: a guest id is `guest_<hex>` and
//     an account id is a Clerk `user_…`, so a guest can never name an account
//     and an account can never be a guest seat.
//
// ACCOUNT-ONLY features must keep using `requireAgeVerifiedUser`: this module
// must never be the gate on wallets, rewards, profile edits or private-room
// administration. `isVerifiedGuest` below is exported so those surfaces can
// reject a guest seat defensively as well.

import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "./requireAgeVerified";
import { isGuestId, resolveGuestId } from "./guestSession";
import { consumeRateLimit, type LimitConfig } from "../security/rateLimit";

/** Guest-PvP-specific limits. Account traffic keeps its existing limits. */
export const PVP_GUEST_RATE_LIMITS = {
  /** Enqueue / cancel: 20 per minute per guest identity. */
  write: { windowMs: 60 * 1000, max: 20 },
  /** Queue reads: generous, but bounded. */
  read: { windowMs: 60 * 1000, max: 120 },
} as const;

export type PvpPlayer = {
  /** A rejection to return, or null when the caller may proceed. */
  response: Response | null;
  /** Clerk id for an account, `guest_<hex>` for a guest. */
  playerId: string | null;
  /** True only when `playerId` came from the verified guest cookie. */
  isGuest: boolean;
};

function tooManyRequests(resetAt: number): Response {
  const retryAfter = Math.max(Math.ceil((resetAt - Date.now()) / 1000), 1);
  return Response.json(
    { success: false, code: "rate_limited", error: "Too many requests — please slow down" },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

/**
 * Resolve the caller for a PvP route.
 *
 * `create` must be true ONLY on the route that starts a guest session; every
 * follow-up request reads the cookie the first one issued, so a stray request
 * cannot mint a new identity.
 */
export async function requirePvpPlayer({
  create = false,
  rateLimit,
}: {
  create?: boolean;
  rateLimit?: { name: string; config: LimitConfig };
} = {}): Promise<PvpPlayer> {
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
        { success: false, error: "Unauthorized", reason: "guest_session_required" },
        { status: 401 },
      ),
      playerId: null,
      isGuest: false,
    };
  }

  // Limited by the SERVER-resolved guest id, in a namespace that cannot collide
  // with an account's limiter key.
  if (rateLimit) {
    const result = await consumeRateLimit(
      `pvp:guest:${rateLimit.name}:${guestId}`,
      rateLimit.config,
    );
    if (!result.allowed) {
      return { response: tooManyRequests(result.resetAt), playerId: null, isGuest: false };
    }
  }

  return { response: null, playerId: guestId, isGuest: true };
}

/**
 * Defensive guard for ACCOUNT-ONLY surfaces: true when `playerId` is a guest, so
 * the caller must refuse. Never used to AUTHORIZE anything.
 */
export function isVerifiedGuest(playerId: unknown): boolean {
  return isGuestId(playerId);
}
