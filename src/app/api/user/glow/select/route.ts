// src/app/api/user/glow/select/route.ts
//
// POST — equip an owned official Grynd name glow (or clear it with
// null / "none" / ""). Server-authoritative: the glow must resolve through
// the official `glows` catalog (enabled) AND be owned by the user. Arbitrary
// hex colors / user-supplied values are never accepted — the free-form
// surface is the GRYND PRO chat-color picker, glows are fixed catalog entries.
// Mirrors the icon equip endpoint (src/app/api/user/icon/select/route.ts).

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { selectGlow } from "../../../../../lib/glows";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: { glowKey?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const result = await selectGlow(userId, body?.glowKey);
    if (result.ok === false) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status ?? 400 }
      );
    }

    return NextResponse.json({ success: true, selectedGlow: result.glowKey });
  } catch (error) {
    console.error("[POST /api/user/glow/select] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to equip glow" },
      { status: 500 }
    );
  }
}