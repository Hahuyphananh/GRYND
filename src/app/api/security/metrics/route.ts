import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { listAbuseMetrics } from "../../../../lib/security/abuseMetrics";
import { isAdmin } from "../../../../lib/auth/isAdmin";
import { hasRecentMfa } from "../../../../lib/auth/requireMfa";
import {
  ADMIN_MFA_COOKIE,
  USER_MFA_COOKIE,
  verifyAdminMfaToken,
  verifyUserMfaToken,
} from "../../../../lib/auth/adminMfa";
import { auditLog } from "../../../../lib/security/auditLog";

/**
 * GET /api/security/metrics — the abuse counters for the operations dashboard.
 *
 * This path is NOT under /api/admin, so the proxy's admin gate (auth + admin
 * role + MFA step-up) does not cover it. It re-checks the role itself — and
 * it now requires the same second factor as every other admin surface: the
 * counters identify players and networks, and a stolen admin session must not
 * be enough to read them.
 */
export async function GET() {
  const { userId, factorVerificationAge } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 },
    );
  }

  const jar = await cookies();
  const mfaSatisfied =
    hasRecentMfa(factorVerificationAge) ||
    (await verifyAdminMfaToken(jar.get(ADMIN_MFA_COOKIE)?.value, userId)) ||
    (await verifyUserMfaToken(jar.get(USER_MFA_COOKIE)?.value, userId));

  if (!mfaSatisfied) {
    auditLog("security_metrics_mfa_required", { userId });
    return NextResponse.json(
      { success: false, error: "MFA required for admin access." },
      { status: 403 },
    );
  }

  const metrics = listAbuseMetrics();
  return NextResponse.json(
    { success: true, metrics },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
