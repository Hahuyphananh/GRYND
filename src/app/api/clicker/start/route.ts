import crypto from "node:crypto";
import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import {
  ensureClickerUser,
  startRound,
} from "../../../../lib/goonbet-clicker-db";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const betAmount = BigInt(body.betAmount ?? 0);
  if (betAmount <= BigInt(0))
    return NextResponse.json({ error: "Invalid bet" }, { status: 400 });

  const clerkUser = await currentUser();
  await ensureClickerUser(
    userId,
    clerkUser?.emailAddresses?.[0]?.emailAddress ?? null,
  );

  try {
    const round = (await startRound(userId, betAmount)) as any;
    return NextResponse.json({
      roundId: round.id,
      startTime: round.created_at,
      betAmount: round.bet_amount,
      serverSeed: crypto.randomUUID(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "FAILED";
    const status = message === "INSUFFICIENT_TOKENS" ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
