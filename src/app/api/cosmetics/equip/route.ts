// src/app/api/cosmetics/equip/route.ts
//
// POST /api/cosmetics/equip  { key?: string | null, category?: string }
//
// Server-authoritative equip. Passing a cosmetic key equips it into its
// catalog category slot; passing null + category clears that slot; passing
// just null clears everything. Validation lives in src/lib/cosmetics.ts
// (catalog exists + enabled, ownership, unlock condition).

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { equipCosmetic } from "../../../../lib/cosmetics";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    let body: { key?: unknown; category?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const result = await equipCosmetic(userId, body?.key, body?.category);
    if (result.ok === false) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status ?? 400 },
      );
    }

    return NextResponse.json({
      success: true,
      equippedCosmetics: result.equippedCosmetics,
    });
  } catch (error) {
    console.error("[POST /api/cosmetics/equip] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to equip cosmetic" },
      { status: 500 },
    );
  }
}