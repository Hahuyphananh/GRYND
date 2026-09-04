// GET /api/user/security — account-security status for the Settings page.
// Returns whether the self-hosted email-OTP second factor is enabled and the
// email address codes get sent to.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const [row] = await db
    .select({ email: users.email, mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);

  return NextResponse.json({
    success: true,
    mfaEnabled: row?.mfaEnabled ?? false,
    email: row?.email ?? null,
  });
}