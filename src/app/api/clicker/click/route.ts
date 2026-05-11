import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json(
    {
      error: "DEPRECATED_ENDPOINT",
      message:
        "Per-click API calls are deprecated. Use local click simulation and /api/clicker/cashout.",
    },
    { status: 410 },
  );
}
