import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { cashoutRound } from "../../../../lib/goonbet-clicker-db";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roundId } = await req.json();
  if (!roundId) return NextResponse.json({ error: "roundId required" }, { status: 400 });

  try {
    const result = await cashoutRound(userId, Number(roundId)) as any;
    return NextResponse.json({ ...result, payout: result.payout.toString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "FAILED";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
