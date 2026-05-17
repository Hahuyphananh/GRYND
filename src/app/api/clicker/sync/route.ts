import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { syncRound } from "../../../../lib/goonbet-clicker-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const body = await req.json().catch(() => ({}));

  const roundId = Number(body.roundId);
  if (!roundId) {
    return NextResponse.json(
      { error: "roundId required" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const result = await syncRound(
      userId,
      roundId,
      Number(body.clientClicks ?? 0),
      Number(body.clientMultiplier ?? 1),
      Number(body.durationMs ?? 0)
    );

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "FAILED";

    return NextResponse.json(
      { error: message },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
