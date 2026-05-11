import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { syncRound } from "../../../../lib/goonbet-clicker-db";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roundId, clientClicks, clientMultiplier, durationMs } =
    await req.json();
  if (!roundId)
    return NextResponse.json({ error: "roundId required" }, { status: 400 });

  try {
    const result = await syncRound(
      userId,
      Number(roundId),
      Number(clientClicks ?? 0),
      Number(clientMultiplier ?? 1),
      Number(durationMs ?? 0),
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "FAILED";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
