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
import { requireAgeVerifiedUser } from "../auth/requireAgeVerified";
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
 * Authenticate + age-verify a mutating room request.
 *
 * Returns either a `response` to return as-is, or the verified `userId`.
 */
export async function requireRoomActor(): Promise<
  { response: Response; userId: null } | { response: null; userId: string }
> {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return { response: gate.response, userId: null };
  if (!gate.userId) {
    return { response: apiError(401, "unauthenticated", "Unauthorized"), userId: null };
  }
  return { response: null, userId: gate.userId };
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
