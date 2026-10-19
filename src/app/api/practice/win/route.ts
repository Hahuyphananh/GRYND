// app/api/practice/win/route.ts
//
// POST /api/practice/win  → records a win in a client-settled practice mode
//                           (Four-in-a-Row, RPS, Barrier Blitz) as today's
//                           daily-reward win marker.
//
// These three modes have no server match row, so there is nothing for the
// authoritative settlement writers to stamp. The page reports its terminal
// result here once, and the shared helper writes the same
// `users.last_won_game_date` marker every server-settled win writes.
//
// Auth is required — a guest's win has no account to stamp. The body is only
// `{ game: "four-in-a-row" | "rps" | "barrier-blitz" }`; the accepted list is
// in src/lib/practiceWin.ts, so an unknown key is a 400 rather than a marker
// write. See that file for why this path is deliberately client-authoritative.

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { markClientPracticeWin } from "../../../../lib/practiceWin";
import { logError } from "../../../../lib/logError";

export async function POST(request: Request) {
  let clerkId: string | null = null;
  try {
    ({ userId: clerkId } = await auth());
    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const result = await markClientPracticeWin(clerkId, body?.game);

    // `in` narrowing rather than `!result.ok`: this project compiles with
    // `strict: false`, where truthiness narrowing of the union is not applied.
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({ success: true, stamped: result.stamped });
  } catch (error) {
    console.error("[PRACTICE_WIN_ERROR]", error);
    await logError({
      errorType: "practice_win_error",
      errorMessage:
        error instanceof Error ? error.message : "Practice win report failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/practice/win",
      game: "Practice",
      metadata: {
        operation: "mark_practice_win",
        userId: clerkId ?? null,
      },
    });

    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
