import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { cashoutRound, ensureClickerUser } from "../../../../lib/goonbet-clicker-db";

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

  const clerkUser = await currentUser();

  await ensureClickerUser(userId, clerkUser?.emailAddresses?.[0]?.emailAddress ?? null);

  const body = await req.json().catch(() => ({}));

  const roundId = Number(body.roundId);
  if (!roundId) {
    return NextResponse.json(
      { error: "roundId required" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const result = await cashoutRound(
      userId,
      roundId,
      Number(body.clientClicks ?? 0),
      Number(body.clientMultiplier ?? 1),
      Number(body.durationMs ?? 0)
    );

    return NextResponse.json(
      {
        ...result,
        payout: result.payout.toString(),
      },
      {
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "FAILED";
    const status = message === "ROUND_NOT_FOUND" || message === "ROUND_NOT_ACTIVE" ? 409 : 400;

    return NextResponse.json(
      { error: message },
      { status, headers: { "Cache-Control": "no-store" } }
    );
  }
}
