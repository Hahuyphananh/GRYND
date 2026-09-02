import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { selectBanner } from "../../../../../lib/banners";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const result = await selectBanner(userId, body?.bannerKey);
    if (result.ok === false) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status ?? 400 },
      );
    }

    return NextResponse.json({
      success: true,
      selectedBanner: result.bannerKey,
      noBanner: result.bannerKey === null,
    });
  } catch (error) {
    console.error("[POST /api/user/banner/select] error:", error);
    return NextResponse.json({ success: false, error: "Failed to update banner" }, { status: 500 });
  }
}
