import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { resignDiceDuelMatch } from "../../../../lib/dice-duel/serverStore";
import { logError } from "../../../../lib/logError";

// Resigns from a Dice Duel match (active state only).
//   • Resigner forfeits their stake; the opponent wins the pot
//     minus the shared 5% house rake.
//   • AI matches are free play — no balance moves, the AI is simply
//     declared the winner.
// Settlement logic lives in `src/lib/dice-duel/serverStore.ts` so
// the realtime-server disconnect-forfeit route settles identically.
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    }

    const { matchId } = await req.json();
    if (!matchId) {
      return NextResponse.json(
        { ok: false, message: "Missing matchId" },
        { status: 400 },
      );
    }

    const result = await resignDiceDuelMatch({ userId, matchId });
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, message: result.message },
        { status: result.status || 400 },
      );
    }

    return NextResponse.json({ ok: true, winnerId: result.winnerId, ended: true });
  } catch (error) {
    await logError({
      errorType: "dice_duel_resign_error",
      errorMessage: error instanceof Error ? error.message : "Dice Duel resign failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/dice-duel/resign",
      game: "Dice Duel",
      metadata: { operation: "resign_match" },
    });
    return NextResponse.json({ ok: false, message: "Unable to resign" }, { status: 500 });
  }
}
