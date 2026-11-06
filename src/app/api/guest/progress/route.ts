// src/app/api/guest/progress/route.ts
//
// GET /api/guest/progress — the authenticated GUEST's own practice record.
//
// AUTHORISATION: `requirePracticePlayer()` resolves the caller from the
// HMAC-signed `grynd_guest` cookie (src/lib/auth/guestSession.ts). Its
// `playerId` is the ONLY identity this route uses; there is no `guestId`
// parameter, body, header or client-storage read anywhere in the handler, so a
// caller cannot ask for somebody else's progression.
//
// A signed-in visitor gets 403 and is sent to their account statistics
// (/api/user-stats) instead — this endpoint is guest-only and MUST NOT become a
// second door into account data. A signed-out visitor with no cookie (or a
// forged/expired one) gets the gate's own 401.
//
// READ-ONLY: one response, no mutation, no profile creation. A guest who has
// never finished a supported practice match gets an empty record, not a row.

import { NextResponse } from "next/server";

import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import {
  DEFAULT_HISTORY_LIMIT,
  loadGuestProgress,
} from "../../../../lib/guest/practiceProgress";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;

  if (!gate.isGuest || !gate.playerId) {
    return NextResponse.json(
      {
        success: false,
        error: "Guest session required",
        // Signed-in players keep using their existing account statistics.
        reason: "signed_in_use_account_stats",
      },
      { status: 403 },
    );
  }

  try {
    const data = await loadGuestProgress(gate.playerId, {
      limit: DEFAULT_HISTORY_LIMIT,
    });
    return NextResponse.json(
      { success: true, data },
      // Per-identity data must never be cached by a shared proxy or the browser.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // A read failure is reported as a failure; it is never disguised as an
    // empty history, which would look like lost progress.
    console.error(
      "[guest/progress] read failed",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      { success: false, error: "Unable to load guest progress" },
      { status: 500 },
    );
  }
}
