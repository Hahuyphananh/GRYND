// src/app/api/admin/stripe-sync/route.ts
//
// POST — admin: ensure every enabled token package has a real Stripe Product +
// one-time Price, and persist the ids. Idempotent (already-synced rows reused).
//
// Gated twice, like the other admin mutations: proxy.ts enforces isAdmin + MFA
// for any /api/admin/* path, and this handler re-checks isAdmin + persists to
// the admin audit log.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "../../../../lib/auth/isAdmin";
import { syncAllTokenPackagesToStripe } from "../../../../lib/stripe/packages";
import { adminAuditLog } from "../../../../lib/security/adminAuditLog";

export const runtime = "nodejs";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { success: false, error: "Stripe is not configured" },
      { status: 503 }
    );
  }

  try {
    const result = await syncAllTokenPackagesToStripe();
    await adminAuditLog("admin_stripe_sync", {
      clerkId: userId,
      details: { count: result.count },
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[admin/stripe-sync] Failed:", err);
    return NextResponse.json(
      { success: false, error: "Stripe product sync failed" },
      { status: 500 }
    );
  }
}
