import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { logError } from "../../../../lib/logError";
import { submitPlacement } from "../../../../lib/tower-arena/serverStore";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const { matchId, shape, positionX, rotation } = body;
    if (!matchId) return NextResponse.json({ ok: false, message: "matchId is required" }, { status: 400 });
    const res: any = await submitPlacement({
      userId,
      matchId: String(matchId),
      shape,
      positionX: Number(positionX),
      rotation: rotation == null ? 0 : Number(rotation),
    });
    return NextResponse.json(
      {
        ok: !res.error,
        collapsed: Boolean(res.collapsed),
        eliminated: Boolean(res.eliminated),
        matchFinished: Boolean(res.matchFinished),
        error: res.error,
      },
      { status: res.status || (res.error ? 400 : 200) },
    );
  } catch (error) {
    await logError({
      errorType: "tower_arena_placement_error",
      errorMessage: error instanceof Error ? error.message : "Tower Arena placement failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tower-arena/submit-placement",
      game: "Tower Arena",
      metadata: { operation: "submit_placement" },
    });
    return NextResponse.json({ ok: false, message: "Unable to submit placement" }, { status: 500 });
  }
}