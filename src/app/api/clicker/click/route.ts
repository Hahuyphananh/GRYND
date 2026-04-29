import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { processClick } from "../../../../lib/goonbet-clicker-db";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roundId } = await req.json();
  if (!roundId) return NextResponse.json({ error: "roundId required" }, { status: 400 });

  try {
    const result = await processClick(userId, Number(roundId)) as any;
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "FAILED";
    const status = message === "RATE_LIMITED" ? 429 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
