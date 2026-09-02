import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getOwnedBanners, resolveSelectedBannerKey } from "../../../../lib/banners";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const selectedBanner = await resolveSelectedBannerKey(userId);
    const ownedBanners = await getOwnedBanners(userId);
    return NextResponse.json({
      success: true,
      selectedBanner,
      noBanner: selectedBanner === null,
      ownedBanners,
    });
  } catch (error) {
    console.error("[GET /api/user/banners] error:", error);
    return NextResponse.json({ success: false, error: "Failed to load banners" }, { status: 500 });
  }
}
