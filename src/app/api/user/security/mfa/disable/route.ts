// POST /api/user/security/mfa/disable — turn the self-hosted second factor
// off. Refuses unless the current session already satisfies it (Clerk factor
// or a valid user-MFA cookie), so a hijacker who just stole the password
// can't disable the factor that is protecting the account.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { users } from "../../../../../../db/schema";
import {
  USER_MFA_COOKIE,
  verifyUserMfaToken,
} from "../../../../../../lib/auth/adminMfa";
import { hasRecentMfa } from "../../../../../../lib/auth/requireMfa";
import { cacheDelete } from "../../../../../../lib/redis/cache";
import { CacheKeys } from "../../../../../../lib/redis/keys";
import { auditLog } from "../../../../../../lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { userId, factorVerificationAge } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const cookie = req.cookies.get(USER_MFA_COOKIE)?.value;
  const satisfied =
    hasRecentMfa(factorVerificationAge) ||
    (await verifyUserMfaToken(cookie, userId));

  if (!satisfied) {
    return NextResponse.json(
      {
        success: false,
        error: "Verify a code first — disabling a second factor requires proof you control this session.",
      },
      { status: 403 },
    );
  }

  await db
    .update(users)
    .set({ mfaEnabled: false })
    .where(eq(users.clerkId, userId));

  await cacheDelete(CacheKeys.userMfa(userId)).catch(() => {});

  auditLog("user_mfa_disabled", { userId, ip: null });

  const res = NextResponse.json({ success: true, mfaEnabled: false });
  res.cookies.set(USER_MFA_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}