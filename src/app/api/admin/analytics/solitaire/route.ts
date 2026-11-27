// GET /api/admin/analytics/solitaire?days=7|30|90
//
// Product & retention metrics. Two accepted credentials:
//   * an admin Clerk session (the on-site dashboard), or
//   * the existing PM bearer token (`PM_API_KEY`), so the internal PM tooling
//     can read the same numbers without a browser session.
//
// Authentication fails before authorisation; the PM check is only attempted
// when PM_API_KEY is configured, so an admin is never locked out on a host that
// does not run the PM integration.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { isAdmin } from "../../../../../lib/auth/isAdmin";
import { verifyPmRequest } from "../../../../../lib/security/pmAuth";
import { loadProductSnapshot } from "../../../../../lib/analytics/solitaireProduct";
import { DASHBOARD_RANGES } from "../../../../../lib/analytics/solitaireDashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseDays(value: string | null): number {
  const parsed = Number(value);
  return (DASHBOARD_RANGES as readonly number[]).includes(parsed) ? parsed : 30;
}

function pmAuthorised(req: NextRequest): boolean {
  if (!process.env.PM_API_KEY?.trim()) return false;
  return verifyPmRequest(req) === null;
}

export async function GET(req: NextRequest) {
  if (!pmAuthorised(req)) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!(await isAdmin(userId))) {
      return NextResponse.json(
        { success: false, error: "Forbidden. Admin access required" },
        { status: 403 },
      );
    }
  }

  const days = parseDays(new URL(req.url).searchParams.get("days"));
  try {
    const snapshot = await loadProductSnapshot(days);
    return NextResponse.json(
      { success: true, ...snapshot },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // The loader already isolates each section; reaching here means something
    // systemic (e.g. the database is unreachable).
    console.error("[admin:analytics:product] failed", error);
    return NextResponse.json(
      { success: false, error: "Analytics unavailable" },
      { status: 503 },
    );
  }
}
