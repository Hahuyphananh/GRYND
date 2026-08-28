import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { crashArenaRounds } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { settleCrashPokerHand } from "../../../../lib/crash-poker/settleHand";
import { crashDueAtMs } from "../../../../lib/games/crash/generateCrashPoint";
import { logError } from "../../../../lib/logError";

/**
 * POST /api/crash-arena/settle
 *
 * Body: { roundId: number }
 *
 * Server-authoritative settlement for a Crash Poker hand. The client calls
 * this when the curve reaches the server-authoritative crash point. Winner
 * determination is NOT hardcoded here — it is delegated to
 * `settleCrashPokerHand` → `resolveHand` (fold-order / pot rules):
 *
 *   • one active player left  → fold-out winner takes the pot minus 5% fee
 *   • crash with 2+ active    → nobody wins; the whole pot carries over
 *
 * The settle route no longer computes "highest cashout" — Crash Poker hands
 * have no cashouts.
 *
 * The crash moment is DETERMINISTIC server-side (round creation time + the
 * curve's growth rate → crashDueAtMs). A settlement request for a still-
 * running hand is rejected before that moment — a client racing the crash
 * cannot settle the hand early, and a betting action that lost the race is
 * ordered by server time, not by network latency.
 */
export async function POST(req: Request) {
  try {
    const { userId: callerId } = await auth();
    if (!callerId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { roundId } = await req.json();
    if (!roundId) {
      return NextResponse.json({ success: false, error: "roundId is required" }, { status: 400 });
    }

    // ── Early-settlement guard: a running hand can only be settled once
    //    its deterministic crash time has passed. Fold-out settlements are
    //    NOT routed here (the action/auto-fold routes settle those via
    //    settleCrashPokerHand directly), so this guard is crash-only. ────
    const [roundData] = await db
      .select({ status: crashArenaRounds.status, createdAt: crashArenaRounds.createdAt, crashPoint: crashArenaRounds.crashPoint })
      .from(crashArenaRounds)
      .where(eq(crashArenaRounds.id, Number(roundId)))
      .limit(1);
    if (!roundData) {
      return NextResponse.json({ success: false, error: "Round not found" }, { status: 404 });
    }
    if (roundData.status === "running") {
      const cp = Number(roundData.crashPoint);
      if (Number.isFinite(cp) && cp > 0) {
        const dueAt = crashDueAtMs(roundData.createdAt, cp);
        if (Date.now() < dueAt) {
          return NextResponse.json({
            success: false,
            error: "The crash hasn't happened yet",
          }, { status: 400 });
        }
      }
    }

    const settled = await settleCrashPokerHand(Number(roundId));

    if (settled.alreadySettled) {
      return NextResponse.json({ success: false, error: "Round already settled" }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      data: {
        roundId: settled.roundId,
        pot: settled.pot,
        rake: settled.rake,
        winnerPayout: settled.payout,
        payoutGross: settled.payoutGross,
        carryOver: settled.carryOver,
        crashPoint: settled.crashPoint,
        seed: settled.seed,          // revealed now that the hand is over
        seedHash: settled.seedHash,
        winner: settled.winnerUserId != null
          ? {
              userId: settled.winnerUserId,
              payout: settled.payout,
            }
          : null,
        activeAtCrash: settled.activeAtCrash,
        pots: settled.pots,
        returns: settled.returns,
        allResults: settled.entries,
      },
    });
  } catch (err) {
    console.error("[crash-arena:settle]", err);
    await logError({
      errorType: "crash_arena_settlement_error",
      errorMessage: err instanceof Error ? err.message : "Crash Arena settlement failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/crash-arena/settle",
      game: "Crash Arena",
      metadata: { operation: "settle_hand" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
