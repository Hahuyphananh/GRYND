import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { cashoutRound } from "../../../../lib/goonbet-clicker-db";
import { ensureClickerUser } from "../../../../lib/goonbet-clicker-db";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clerkUser = await currentUser();
  await ensureClickerUser(userId, clerkUser?.emailAddresses?.[0]?.emailAddress ?? null);

  const { roundId, clientClicks, clientMultiplier, durationMs } = await req.json();
  if (!roundId) return NextResponse.json({ error: "roundId required" }, { status: 400 });

  try {
    const result = await cashoutRound(
      userId,
      Number(roundId),
      Number(clientClicks ?? 0),
      Number(clientMultiplier ?? 1),
      Number(durationMs ?? 0),
    ) as any;
    return NextResponse.json({ ...result, payout: result.payout.toString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "FAILED";
    const status = message === "ROUND_NOT_FOUND" || message === "ROUND_NOT_ACTIVE" ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
