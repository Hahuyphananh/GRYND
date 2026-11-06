// src/app/api/guest/claim/route.ts
//
// GET  /api/guest/claim — what would claiming do for this account + browser?
// POST /api/guest/claim — claim this browser's guest practice record.
//
// AUTHORISATION: both handlers require a Clerk session (`auth()`), and the
// guest identity is read ONLY from the HMAC-signed `grynd_guest` cookie
// (`readGuestId`). There is no guest id in the URL, body, headers or query, so
// a caller cannot claim somebody else's record. Signed-out requests get 401.
//
// WHAT IT DOES NOT DO
//
// No rating, trophy, coin, quest, wager or leaderboard code is imported here or
// in src/lib/guest/claim.ts. Claiming preserves practice rows as unrated
// provenance and never rewrites the account's existing statistics. On any
// failure the guest cookie is left exactly as it was, so the visitor can retry.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { readGuestId } from "../../../../lib/auth/guestSession";
import {
  claimGuestProgression,
  getClaimState,
  type GuestClaimOutcome,
} from "../../../../lib/guest/claim";
import { consumeRateLimit } from "../../../../lib/security/rateLimit";

export const dynamic = "force-dynamic";

/** Claim writes are rare; this only bounds abuse of the authenticated path. */
const CLAIM_RATE_LIMIT = { windowMs: 60 * 1000, max: 10 } as const;

function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function outcomeResponse(outcome: GuestClaimOutcome): NextResponse {
  switch (outcome.status) {
    case "claimed":
      return noStore({ success: true, data: outcome }, 201);
    case "already_claimed":
      return noStore({ success: true, data: outcome }, 200);
    case "no_progress":
      return noStore({ success: true, data: outcome }, 200);
    case "invalid_identity":
      return noStore(
        { success: false, code: "invalid_identity", error: "Invalid guest session" },
        400,
      );
    case "guest_already_claimed":
      return noStore(
        {
          success: false,
          code: "guest_already_claimed",
          error: "This guest record is already linked to an account.",
        },
        409,
      );
    case "account_already_claimed":
      return noStore(
        {
          success: false,
          code: "account_already_claimed",
          error: "This account is already linked to a guest record.",
        },
        409,
      );
  }
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return noStore(
      { success: false, code: "unauthenticated", error: "Sign in to claim guest progress." },
      401,
    );
  }

  // No cookie means there is simply nothing this browser could offer.
  const guestId = await readGuestId();
  if (!guestId) {
    return noStore({ success: true, data: { status: "no_guest" } }, 200);
  }

  try {
    const state = await getClaimState({ userId, guestId });
    return noStore({ success: true, data: state }, 200);
  } catch (error) {
    console.error(
      "[guest/claim] status read failed",
      error instanceof Error ? error.message : error,
    );
    return noStore(
      { success: false, code: "claim_status_failed", error: "Unable to read claim status" },
      500,
    );
  }
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return noStore(
      { success: false, code: "unauthenticated", error: "Sign in to claim guest progress." },
      401,
    );
  }

  const guestId = await readGuestId();
  if (!guestId) {
    return noStore(
      {
        success: false,
        code: "guest_session_required",
        error: "No guest session found in this browser.",
      },
      401,
    );
  }

  const limit = await consumeRateLimit(`guest-claim:${userId}`, CLAIM_RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      { success: false, code: "rate_limited", error: "Too many attempts — please slow down." },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(Math.max(Math.ceil((limit.resetAt - Date.now()) / 1000), 1)),
        },
      },
    );
  }

  try {
    const outcome = await claimGuestProgression({ userId, guestId });
    return outcomeResponse(outcome);
  } catch (error) {
    // A failed claim is retryable: the transaction rolled back and the guest
    // cookie is untouched, so nothing was partially transferred.
    console.error(
      "[guest/claim] claim failed",
      error instanceof Error ? error.message : error,
    );
    return noStore(
      {
        success: false,
        code: "claim_failed",
        error: "We couldn't link your guest progress. Your practice record is still saved.",
      },
      500,
    );
  }
}
