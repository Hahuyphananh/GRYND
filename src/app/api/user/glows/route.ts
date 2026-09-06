// src/app/api/user/glows/route.ts
//
// GET — the signed-in user's official Grynd name glow state:
//   * selectedGlow     — the user's currently equipped glow key (or null)
//   * ownedGlows       — every glow the user owns, with catalog metadata
//                        (name, hex color, rarity, equipped flag)
// The client renders glow colors ONLY from these catalog hex values — never
// from user-supplied colors.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getOwnedGlows } from "../../../../lib/glows";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const owned = await getOwnedGlows(userId);
    const selectedGlow = owned.find((o) => o.equipped)?.glowKey ?? null;

    const ownedGlows = owned.map((o) => ({
      key: o.glowKey,
      name: o.name,
      description: o.description,
      color: o.color,
      rarity: o.rarity,
      equipped: o.equipped,
    }));

    return NextResponse.json({
      success: true,
      selectedGlow,
      ownedGlows,
    });
  } catch (error) {
    console.error("[GET /api/user/glows] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to load glows" },
      { status: 500 }
    );
  }
}