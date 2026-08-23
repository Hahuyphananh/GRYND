import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "../../../../lib/auth/isAdmin";
import { adminAuditLog } from "../../../../lib/security/adminAuditLog";
import { isMaintenanceMode, setMaintenanceMode } from "../../../../lib/security/maintenance";

export const runtime = "nodejs";

/**
 * Admin-only runtime kill switch. GET returns the current maintenance
 * state; POST { enabled: boolean } flips it (no redeploy needed — the
 * flag lives in Postgres and middleware picks it up within ~10s).
 */
export async function GET() {
  try {
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
    const enabled = await isMaintenanceMode();
    return NextResponse.json({ success: true, maintenanceMode: enabled });
  } catch (error) {
    console.error("[admin:maintenance] GET error:", error);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
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

    let enabled: boolean;
    try {
      const body = await req.json();
      enabled = Boolean(body.enabled);
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON body. Expected { enabled: boolean }" },
        { status: 400 },
      );
    }

    await setMaintenanceMode(enabled);

    adminAuditLog("admin_maintenance_toggle", {
      clerkId: userId,
      details: { enabled },
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      maintenanceMode: enabled,
      message: enabled
        ? "Maintenance mode ON — the platform is now in maintenance."
        : "Maintenance mode OFF — the platform is live again.",
    });
  } catch (error) {
    console.error("[admin:maintenance] POST error:", error);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
