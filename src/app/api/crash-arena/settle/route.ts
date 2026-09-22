import { db } from "../../../../db/client";
import {
  users,
  crashArenaRounds,
  crashArenaEntries,
} from "../../../../db/schema";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { settleCrashPokerHand } from "../../../../lib/crash-poker/settleHand";
import { isCrashDueAt } from "../../../../lib/crash-poker/roundSystem";
import type { CrashPokerHand } from "../../../../lib/crash-poker/types";
import { logError } from "../../../../lib/logError";

/**
 * POST /api/crash-arena/settle
 *
 * Body: { roundId: number }
 *
 * Resolve a running Crash Arena hand that the server has already decided is
 * over, and return the authoritative results. Two cases:
 *
 *   • FOLD-OUT — the fold left exactly one active player. Fold-out
 *     settlement used to be reachable only from the realtime-server crash
 *     sweep, which left the table on the "Hand over — settling payouts…"
 *     card until the next sweep tick (1s while hands run, 15s once its
 *     running-hand hint idles — and never, when no sweep is running). The
 *     fold-out's own deadline (`handState.settlePendingAt`, stamped by the
 *     action route at the end of the FOLD_PAUSE_MS freeze) is public
 *     information the table's client already holds, so the client now wakes
 *     the settlement here AT that deadline and applies the results straight
 *     from the response.
 *
 *   • CRASH — the deterministic curve reached the crash point. This is the
 *     original path and is unchanged.
 *
 * The client can never settle early or choose an outcome: the outcome is
 * `settleCrashPokerHand` → `resolveHand` (fold-order / pot rules), the
 * fold-out deadline is compared against SERVER time, and the crash moment is
 * a server-side constant. Both paths are additionally restricted to seats
 * entered in the hand, so an unrelated caller can't drive someone else's
 * hand. Settlement is idempotent (the round row is locked and an already
 * settled round no-ops), so the action route's scheduled settle and the
 * crash sweep racing this route is harmless.
 */
export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const callerId = gate.userId;

    const { roundId } = await req.json().catch(() => ({}));
    const rid = Number(roundId);
    if (!Number.isFinite(rid) || rid <= 0) {
      return NextResponse.json({ success: false, error: "roundId is required" }, { status: 400 });
    }

    const [caller] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, callerId))
      .limit(1);
    if (!caller) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }

    const [round] = await db
      .select({
        status: crashArenaRounds.status,
        crashPoint: crashArenaRounds.crashPoint,
        handState: crashArenaRounds.handState,
      })
      .from(crashArenaRounds)
      .where(eq(crashArenaRounds.id, rid))
      .limit(1);
    if (!round) {
      return NextResponse.json({ success: false, error: "Round not found" }, { status: 404 });
    }

    const hand =
      round.handState && typeof round.handState === "object"
        ? (round.handState as CrashPokerHand)
        : null;

    // Already resolved (by the action route's scheduled settle, the crash
    // sweep, or another seat racing this call) — not an error. `results` is
    // null because the caller has to reconcile the settled round from the
    // tables poll, which is what the client does next.
    if (round.status !== "running") {
      return NextResponse.json({
        success: true,
        data: { roundId: rid, alreadySettled: true, results: null },
      });
    }

    // Only seats entered in the hand may resolve it.
    const [entry] = await db
      .select({ id: crashArenaEntries.id })
      .from(crashArenaEntries)
      .where(
        and(
          eq(crashArenaEntries.roundId, rid),
          eq(crashArenaEntries.userId, caller.id),
        ),
      )
      .limit(1);
    if (!entry) {
      return NextResponse.json(
        { success: false, error: "You are not in this hand" },
        { status: 403 },
      );
    }

    const now = Date.now();
    const settlePendingAt =
      hand?.settlePendingAt != null ? Number(hand.settlePendingAt) : null;

    if (settlePendingAt != null && Number.isFinite(settlePendingAt)) {
      // ── Fold-out: the outcome is decided; wait for the reveal window to
      //    close (SERVER time — a client clock can't shorten it).
      if (now < settlePendingAt) {
        return NextResponse.json(
          {
            success: false,
            error: "The hand is still frozen",
            retryAfterMs: Math.max(50, settlePendingAt - now),
          },
          { status: 409 },
        );
      }
    } else {
      // ── Crash: a running hand can only be settled once its deterministic
      //    crash time has passed. The check runs through the pause-aware
      //    engine, so an open fold pause freezes the curve and the crash is
      //    simply not due while the reveal window is still open.
      const cp = Number(round.crashPoint);
      if (
        Number.isFinite(cp) &&
        cp > 0 &&
        (!hand || !isCrashDueAt(hand, now, cp))
      ) {
        return NextResponse.json(
          { success: false, error: "The crash hasn't happened yet" },
          { status: 400 },
        );
      }
    }

    const settled = await settleCrashPokerHand(rid);
    if (settled.alreadySettled) {
      return NextResponse.json({
        success: true,
        data: { roundId: rid, alreadySettled: true, results: null },
      });
    }

    // The canonical settle payload — the same shape the crash sweep, the
    // action route's crash path and the socket broadcast carry, so every
    // client applies one settlement format everywhere.
    return NextResponse.json({
      success: true,
      data: {
        roundId: settled.roundId,
        alreadySettled: false,
        results: settled,
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
