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
import { equipBoardCosmetic } from "../../../../lib/streaks/server";
import { isProMember } from "../../../../lib/proStatus";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    let body: { key?: unknown; item?: unknown; category?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // ── Board cosmetics (streak-earned) ──────────────────────────────────
    // One equip endpoint, three board slots. Ownership is the permanent
    // `user_unlocks` row the streak engine wrote — a locked item posted by hand
    // is refused here, not merely hidden in the drawer.
    const category = typeof body?.category === "string" ? body.category : "";
    if (category === "felt" || category === "card_back" || category === "deck_skin") {
      const result = await equipBoardCosmetic(
        userId,
        body?.item ?? body?.key,
        category as "felt" | "card_back" | "deck_skin",
      );
      if (result.ok === false) {
        return NextResponse.json(
          { success: false, error: result.error },
          { status: result.status },
        );
      }
      return NextResponse.json({
        success: true,
        slot: result.slot,
        itemId: result.itemId,
      });
    }

    // The membership is resolved HERE, from the caller's own subscription row,
    // and handed to the equip rule. The body cannot influence it.
    const isPro = await isProMember(userId);
    const result = await equipCosmetic(userId, body?.key, body?.category, { isPro });
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