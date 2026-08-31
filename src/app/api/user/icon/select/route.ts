// src/app/api/user/icon/select/route.ts
//
// POST — equip an ownned official Grynd icon. Server-authoritative: the icon
// must resolve through the official catalog (enabled) AND be owned by the
// user. Arbitrary URLs / media are never accepted. Mirrors the special-title
// equip endpoint (src/app/api/titles/equip-special/route.js).

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { selectIcon } from "../../../../../lib/icons";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: { iconKey?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const result = await selectIcon(userId, body?.iconKey);
    if (result.ok === false) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status ?? 400 }
      );
    }

    return NextResponse.json({ success: true, selectedIcon: result.iconKey });
  } catch (error) {
    console.error("[POST /api/user/icon/select] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to equip icon" },
      { status: 500 }
    );
  }
}