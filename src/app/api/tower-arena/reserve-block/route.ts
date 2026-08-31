import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { logError } from "../../../../lib/logError";
import { reserveBlock } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    const { matchId, blockId } = await req.json().catch(() => ({}));
    if (!matchId || !blockId) {
      return NextResponse.json({ ok: false, message: "matchId and blockId are required" }, { status: 400 });
    }
    const res: any = await reserveBlock({ userId, matchId: String(matchId), blockId: String(blockId) });
    return NextResponse.json(
      { ok: !res.error, reserved: res.reserved ?? null, error: res.error },
      { status: res.status || (res.error ? 400 : 200) },
    );
  } catch (error) {
    await logError({
      errorType: "tower_arena_reserve_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena reserve failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/reserve-block",
      game: "Tower Arena",
      metadata: { operation: "reserve_block" },
    });
    return NextResponse.json({ ok: false, message: "Unable to reserve block" }, { status: 500 });
  }
}