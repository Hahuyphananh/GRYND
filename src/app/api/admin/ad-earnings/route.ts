// GET /api/admin/ad-earnings?days=7
//
// Admin-only read of publisher earnings from HilltopAds, ExoClick and Adcash.
// Gated twice, like the other admin reads: proxy.ts enforces isAdmin + MFA for
// any /api/admin/* path, and this handler re-checks isAdmin so a direct call
// can never rely on the proxy alone.
//
// The response contains aggregated numbers and short diagnostics only. API
// tokens, account ids and provider URLs stay on the server.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { isAdmin } from "../../../../lib/auth/isAdmin";
import { loadAdEarnings } from "../../../../lib/advertising/earnings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseDays(raw: string | null): number {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(value)) return 7;
  return Math.min(120, Math.max(1, value));
}

export async function GET(req: NextRequest) {
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

  const days = parseDays(new URL(req.url).searchParams.get("days"));
  const report = await loadAdEarnings(days);

  return NextResponse.json(
    { success: true, ...report },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
