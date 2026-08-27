import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { isAdmin } from "../../../../lib/auth/isAdmin";

/**
 * POST /api/admin/socket-verify
 *
 * Internal endpoint called by the realtime server's `admin:join` handler
 * (see realtime-server/server.js). It verifies the socket's raw Clerk
 * session token and reports whether that user is an admin — the admin
 * notifications room is only joinable when this returns isAdmin: true.
 *
 * The response only reveals whether a VALID Clerk token belongs to an
 * admin, which is exactly what the already-public /api/user/is-admin check
 * tells the session owner, so there is no additional data exposure. It
 * fails closed: an invalid/missing token or a DB error → not admin.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const token = body?.token;

    if (!token) {
      return NextResponse.json(
        { success: false, error: "Missing token" },
        { status: 400 },
      );
    }

    const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
    if (!CLERK_SECRET_KEY) {
      return NextResponse.json(
        { success: false, error: "Server authentication is not configured" },
        { status: 500 },
      );
    }

    let clerkUserId: string;
    try {
      const verified = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
      clerkUserId = verified.sub ?? "";
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid token" },
        { status: 401 },
      );
    }
    if (!clerkUserId) {
      return NextResponse.json(
        { success: false, error: "Invalid token" },
        { status: 401 },
      );
    }

    const admin = await isAdmin(clerkUserId);

    return NextResponse.json({ success: true, isAdmin: admin, userId: clerkUserId });
  } catch {
    return NextResponse.json(
      { success: false, error: "Internal error" },
      { status: 500 },
    );
  }
}
