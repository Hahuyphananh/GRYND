// GET /api/user/is-admin — Returns whether the authenticated user is an admin.
// Used by client-side components (nav bar, chat widget) to conditionally
// show admin UI elements without exposing the admin logic.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "../../../../lib/auth/isAdmin";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { isAdmin: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const admin = await isAdmin(userId);
    return NextResponse.json({ isAdmin: admin }, { status: 200 });
  } catch (error) {
    console.error("[api/user/is-admin] Error:", error);
    return NextResponse.json(
      { isAdmin: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
