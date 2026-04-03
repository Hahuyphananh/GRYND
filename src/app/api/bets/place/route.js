import { NextResponse } from "next/server";

// Legacy endpoint intentionally disabled.
// Use /api/place-bet instead.
export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: "This endpoint is deprecated. Use /api/place-bet.",
    },
    { status: 410 }
  );
}
