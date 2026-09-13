import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db/client";
import {
  crashArenaTables,
  crashArenaRounds,
  crashArenaEntries,
} from "../../../../db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  handFromEntries,
  isCrashDueAt,
  resumePauseIfDue,
} from "../../../../lib/crash-poker/roundSystem";
import { settleCrashPokerHand } from "../../../../lib/crash-poker/settleHand";
import type { CrashPokerHand } from "../../../../lib/crash-poker/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/crash-arena/crash-check
 *
 * Internal endpoint driven by the realtime server's crash sweep (see
 * `runCrashArenaCrashSweep` in realtime-server/server.js). Runs on an
 * adaptive cadence — every second while any hand is running, 15s idle —
 * and acts as the GAME CLOCK for every running Crash Arena hand:
 *
 *   The curve is the piecewise-linear slowdown in crash-poker/constants
 *   (no betting checkpoints), so the exact moment the curve crosses the
 *   crash point is a server-side constant. This sweep settles every running
 *   hand whose curve has reached its crash point and returns the settled
 *   hands so the realtime server can broadcast the crash (with the
 *   now-revealed multiplier + authoritative ranked results). It ALSO
 *   resolves deferred fold-outs (hands the action route stamped
 *   settlePendingAt) once their grace deadline passes, so a fold-out's
 *   payout is broadcast from exactly one place — this sweep.
 *
 * Idempotent: settleCrashPokerHand locks the round row and no-ops on a
 * round already settled (a fold-out or crash via the action route races
 * this sweep — the row lock serializes them). Internal-only: when
 * REALTIME_INTERNAL_SECRET
 * is set the caller must send it in the `x-internal-secret` header (skipped
 * in local dev, like sweep-stale).
 */
export async function POST(req: NextRequest) {
  try {
    // ── Optional shared-secret guard for the internal sweep ─────────────
    const secret = process.env.REALTIME_INTERNAL_SECRET;
    if (secret) {
      const header = req.headers.get("x-internal-secret");
      if (header !== secret) {
        return NextResponse.json(
          { success: false, error: "Unauthorized" },
          { status: 401 },
        );
      }
    }

    const now = Date.now();

    // ── Every running hand — a handful at most, so a plain scan is cheap. ─
    const runningRounds = await db
      .select()
      .from(crashArenaRounds)
      .where(eq(crashArenaRounds.status, "running"))
      .limit(50);

    if (runningRounds.length === 0) {
      return NextResponse.json({
        success: true,
        data: { scanned: 0, crashed: [] },
      });
    }

    const tableIds = [...new Set(runningRounds.map((r) => r.tableId))];
    const tablesData = tableIds.length
      ? await db
          .select()
          .from(crashArenaTables)
          .where(inArray(crashArenaTables.id, tableIds))
      : [];
    const tableById = new Map(tablesData.map((t) => [t.id, t]));

    // ── One bulk fetch of every entry row for the scanned rounds ────────
    const roundIds = runningRounds.map((r) => r.id);
    const allEntries = roundIds.length
      ? await db
          .select()
          .from(crashArenaEntries)
          .where(inArray(crashArenaEntries.roundId, roundIds))
      : [];
    const entriesByRound = new Map<number, typeof allEntries>();
    for (const e of allEntries) {
      const list = entriesByRound.get(e.roundId) ?? [];
      list.push(e);
      entriesByRound.set(e.roundId, list);
    }

    const crashed: Array<{
      tableId: number;
      roundId: number;
      multiplier: number | null;
      kind: "crash" | "fold-out";
      results: Awaited<ReturnType<typeof settleCrashPokerHand>>;
    }> = [];

    for (const round of runningRounds) {
      const table = tableById.get(round.tableId);
      const rawHand = round.handState;
      if (!table || !rawHand || typeof rawHand !== "object") continue;
      const crashPoint = Number(round.crashPoint);
      const entries = entriesByRound.get(round.id) ?? [];

      const hand = handFromEntries({
        round,
        entries,
        carryOver: Number(table.carryOver ?? 0),
      }) as CrashPokerHand;

      // ── Deferred fold-out settle: a fold-out froze the curve with a
      //    settlePendingAt deadline (set by the action route). This sweep
      //    owns the settlement — once the deadline passes it resolves the
      //    hand and reports a fold-out so the realtime server broadcasts the
      //    results from ONE place (no action-route/sweep race). Checked
      //    BEFORE pause resume: the hand is intentionally frozen and must
      //    not resume (nor crash-check) while its fold-out payout is
      //    pending.
      if (hand.settlePendingAt != null) {
        if (now < hand.settlePendingAt) continue; // still frozen, not due yet
        const settled = await settleCrashPokerHand(round.id);
        if (settled.alreadySettled) continue;
        crashed.push({
          tableId: round.tableId,
          roundId: round.id,
          // A fold-out has no crash point — multiplier stays null;
          // `kind` tells the realtime server how to emit it.
          multiplier: null,
          kind: "fold-out",
          results: settled,
        });
        continue;
      }

      // ── Fold-pause resume: close any elapsed pause window BEFORE the due
      //    check. The pause stops the crash clock (curveMultiplierAt freezes
      //    while paused), so a crash that is due the moment the window closes
      //    settles right here — never while the reveal is on screen. Persist
      //    the resume under the row lock so a fold that re-opens the pause at
      //    the same instant can't be clobbered by our write. ───────────────
      const { hand: handForDue, resumed } = resumePauseIfDue(hand, now);
      if (resumed) {
        await db.transaction(async (tx) => {
          const lockedRound = await tx
            .select()
            .from(crashArenaRounds)
            .where(eq(crashArenaRounds.id, round.id))
            .limit(1)
            .for("update");
          if (!lockedRound.length) return;
          const lockedHand = lockedRound[0].handState;
          if (!lockedHand || typeof lockedHand !== "object") return;
          const { hand: freshResumed, resumed: fresh } = resumePauseIfDue(
            lockedHand as CrashPokerHand,
            now,
          );
          if (!fresh) return; // a fold re-opened the pause meanwhile
          await tx
            .update(crashArenaRounds)
            .set({ handState: freshResumed })
            .where(eq(crashArenaRounds.id, round.id));
        });
      }

      // ── Crash: the continuous curve reached the crash point → settle. ──
      if (
        Number.isFinite(crashPoint) &&
        crashPoint > 0 &&
        isCrashDueAt(handForDue, now, crashPoint)
      ) {
        const settled = await settleCrashPokerHand(round.id);
        if (settled.alreadySettled) continue;
        crashed.push({
          tableId: round.tableId,
          roundId: round.id,
          // The authoritative crash multiplier — revealed only now, at the
          // moment of the crash, never before.
          multiplier: settled.crashPoint,
          kind: "crash",
          results: settled,
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        scanned: runningRounds.length,
        crashed,
      },
    });
  } catch (err) {
    console.error("[crash-arena:crash-check]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}