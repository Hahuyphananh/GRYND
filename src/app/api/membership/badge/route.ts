// src/app/api/membership/badge/route.ts
//
// GET — which badge the caller wears, as a LABEL ("PRO" | "FOUNDER" | null).
//
// The shared-result surfaces need the mark itself, not a boolean: a post that
// says "GRYND Founder" has to be backed by the same subscription rows the
// ladder badge is drawn from. Resolving it here keeps that authority on the
// server — the client asks, it never asserts.
//
// Auth-optional: a signed-out caller gets `badge: null` with a 200, so the
// share panel simply posts without a badge instead of treating a normal state
// as an error. Display data only; no entitlement is granted by this response.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getProBadgeFor } from "../../../../lib/proStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: true, signedIn: false, badge: null });
  }

  // Fail closed: an unreadable subscription table means "no badge" for this
  // post, never a mark the account might not have earned.
  const badge = await getProBadgeFor(userId).catch((error) => {
    console.error("[membership/badge] Failed to resolve badge:", error);
    return null;
  });

  return NextResponse.json({ success: true, signedIn: true, badge });
}
