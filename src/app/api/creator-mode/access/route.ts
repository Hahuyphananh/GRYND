// src/app/api/creator-mode/access/route.ts
//
// GET /api/creator-mode/access — whether the authenticated user may use
// Creator Mode. Admin-only today; the approved-creator program slots
// into src/lib/creator-mode/permissions.ts without touching this route.
//
// Mirrors the existing /api/user/is-admin endpoint (auth() + server-side
// permission check) so client components never implement the rule
// themselves and never trust a client-provided flag.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { canUseCreatorMode } from "../../../../lib/creator-mode/permissions";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { canUseCreatorMode: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const canUse = await canUseCreatorMode(userId);
    return NextResponse.json({ canUseCreatorMode: canUse }, { status: 200 });
  } catch (error) {
    console.error("[api/creator-mode/access] Error:", error);
    return NextResponse.json(
      { canUseCreatorMode: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
