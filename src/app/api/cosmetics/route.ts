// src/app/api/cosmetics/route.ts
//
// GET /api/cosmetics — authenticated catalog+ownership payload for the
// cosmetics Shop section and the profile equipment panel.
//
// Returns:
//   shop:      catalog rows that carry a token price (purchasable), with the
//              user's owned/equipped markers folded in.
//   owned:     everything the user owns (joins catalog metadata + equipped
//              state), so equipment panels can render exactly that.
//   equipped:  the equipped-cosmetics map (category → key) written only by
//              the server (src/lib/cosmetics.ts).

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  getEnabledCosmetics,
  getShopCosmetics,
  getOwnedCosmetics,
} from "../../../lib/cosmetics";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const [owned, shop, all] = await Promise.all([
      getOwnedCosmetics(userId),
      getShopCosmetics(),
      getEnabledCosmetics(),
    ]);
    const ownedKeys = new Set(owned.map((row) => row.key));
    const equipped = {};
    for (const row of owned) {
      if (row.equipped) equipped[row.category] = row.key;
    }

    return NextResponse.json({
      success: true,
      shop: shop.map((row) => ({
        key: row.key,
        name: row.name,
        description: row.description,
        category: row.category,
        rarity: row.rarity,
        priceTokens: row.priceTokens,
        visual: row.visual,
        unlockCondition: row.unlockCondition,
        owned: ownedKeys.has(row.key),
      })),
      owned: owned.map((row) => ({
        key: row.key,
        name: row.name,
        description: row.description,
        category: row.category,
        rarity: row.rarity,
        visual: row.visual,
        unlockCondition: row.unlockCondition,
        equipped: row.equipped,
      })),
      catalog: all.map((row) => ({
        key: row.key,
        name: row.name,
        category: row.category,
        rarity: row.rarity,
        priceTokens: row.priceTokens,
        visual: row.visual,
        unlockCondition: row.unlockCondition,
      })),
      equipped,
    });
  } catch (error) {
    console.error("[GET /api/cosmetics] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to load cosmetics" },
      { status: 500 },
    );
  }
}