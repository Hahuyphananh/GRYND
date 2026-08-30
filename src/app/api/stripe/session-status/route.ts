// src/app/api/stripe/session-status/route.ts
//
// GET ?session_id=... — after the user returns from Stripe Checkout, tells the
// Shop whether that session has been fulfilled (tokens credited) and how many.
//
// Security:
//   * auth-required,
//   * a session is only ever reported for the AUTHENTICATED user who created
//     it (we filter by caller clerkId), so one user can't probe another's
//     session ids,
//   * returns display data only; the authoritative credit lives in the webhook.
//     Duplicate crediting is impossible regardless of refreshes — fulfilment is
//     guarded by the unique session row + the webhook's idempotent credit.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { stripeCheckoutSessions } from "../../../../db/schema";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const sessionId = new URL(req.url).searchParams.get("session_id") || "";
  if (!sessionId) {
    return NextResponse.json({ success: false, error: "session_id is required" }, { status: 400 });
  }

  const row = await db
    .select({
      sessionId: stripeCheckoutSessions.sessionId,
      clerkId: stripeCheckoutSessions.clerkId,
      tokenAmount: stripeCheckoutSessions.tokenAmount,
      packageKey: stripeCheckoutSessions.packageKey,
      paymentStatus: stripeCheckoutSessions.paymentStatus,
      fulfilled: stripeCheckoutSessions.fulfilled,
    })
    .from(stripeCheckoutSessions)
    .where(eq(stripeCheckoutSessions.sessionId, sessionId))
    .limit(1)
    .then((r) => r[0]);

  // Unknown session OR a session belonging to someone else is reported as
  // "not found" — no cross-user information leak.
  if (!row || row.clerkId !== userId) {
    return NextResponse.json({ success: true, fulfilled: false });
  }

  return NextResponse.json({
    success: true,
    fulfilled: row.fulfilled,
    tokenAmount: Number(row.tokenAmount),
    packageKey: row.packageKey,
    paymentStatus: row.paymentStatus,
  });
}
