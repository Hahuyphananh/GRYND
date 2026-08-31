// src/app/api/user/icons/route.ts
//
// GET — the signed-in user's official Grynd icon state:
//   * selectedIcon     — the user's currently equipped (safe) icon key
//   * defaultIconKey   — the official default key
//   * ownedIcons       — every icon the user owns, with catalog metadata
//                        (equipped flag, rarity, official asset path)
// The client renders avatars ONLY from these keys via iconAssetUrl — never
// from user-supplied URLs.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getOwnedIcons } from "../../../../lib/icons";
import { DEFAULT_ICON_KEY, iconAssetUrl } from "../../../../lib/iconAssets";
import { resolveSelectedIconKey } from "../../../../lib/icons";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const selectedIcon = await resolveSelectedIconKey(userId);
    const owned = await getOwnedIcons(userId);

    const ownedIcons = owned.map((o) => ({
      key: o.iconKey,
      name: o.name,
      description: o.description,
      rarity: o.rarity,
      isDefault: o.isDefault,
      equipped: o.equipped,
      assetUrl: iconAssetUrl(o.iconKey),
    }));

    return NextResponse.json({
      success: true,
      selectedIcon,
      defaultIconKey: DEFAULT_ICON_KEY,
      ownedIcons,
    });
  } catch (error) {
    console.error("[GET /api/user/icons] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to load icons" },
      { status: 500 }
    );
  }
}