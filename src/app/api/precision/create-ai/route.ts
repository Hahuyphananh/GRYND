// POST /api/precision/create-ai
//
// Free practice match against the server-controlled GRYND AI. The match is
// created in `ready_up` with the bot seat already ready, so the human's
// single Ready click starts the first round through the normal
// `markPlayerReady` → arm path.
//
// ── Why it is NOT armed here ─────────────────────────────────────────────
// This route used to arm the round immediately, which stamped the 5-second
// arming countdown at CREATE time — before the client had even navigated to
// the match page or fetched its first state. By the time the page rendered,
// the countdown was usually already expired, so the screen opened on a
// countdown parked at 0. Arming from the player's Ready click instead means
// the countdown is always a real 5…4…3…2…1 that starts the moment the human
// is actually looking at the page.
//
// The match row only ever lives in `precision_matches` (never in
// `precision_lobbies`), which is what keeps a practice match un-joinable —
// see `/api/precision/join-lobby`.

import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { createAiMatch } from "../../../../lib/precision/serverStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const requested = String(body?.playerName ?? "").replace(/\s+/g, " ").trim();
    const humanName = requested ? requested.slice(0, 24) : "You";

    const matchId = await createAiMatch(userId, humanName);
    return NextResponse.json({ success: true, matchId });
  } catch (error) {
    console.error("[precision/create-ai] error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unable to create AI match" },
      { status: 500 },
    );
  }
}
