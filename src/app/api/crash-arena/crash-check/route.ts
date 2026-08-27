import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db/client";
import {
  crashArenaTables,
  crashArenaRounds,
  crashArenaEntries,
} from "../../../../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  handFromEntries,
  expireStaleActions,
  openNextCheckpoint,
  resumeFlight,
  isCrashDueAt,
  hasCurveReachedNextCheckpoint,
} from "../../../../lib/crash-poker/roundSystem";
import { settleCrashPokerHand } from "../../../../lib/crash-poker/settleHand";
import type { CrashPokerHand } from "../../../../lib/crash-poker/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/crash-arena/crash-check
 *
 * Internal endpoint driven by the realtime server's crash sweep (see
 * `runCrashArenaCrashSweep` in realtime-server/server.js). Runs every
 * second and acts as the GAME CLOCK for every running Crash Poker hand:
 *
 *   1. Checkpoint opening — the flight stops at every 0.25x checkpoint and
 *      players get CHECKPOINT_ACTION_DEADLINE_MS to decide. The curve is
 *      pause-aware (flightResumedAt + checkpointIndex), so this sweep opens
 *      the next checkpoint the moment the curve reaches its multiplier
 *      (the flight then pauses there). When every player acts before the
 *      deadline the checkpoint resolves on the last action and the game
 *      continues immediately — no waiting for the timer.
 *   2. Stall guard — an open checkpoint past its window deadline
 *      auto-checks matched-but-silent players and auto-folds unmatched
 *      silents (proactive version of the action route's lazy guard), so
 *      the game continues for the players who DID decide.
 *   3. Crash — the crash point is generated server-side at hand start and
 *      NEVER sent to clients before the crash. The pause-aware curve
 *      (multiplier = fromMultiplier · e^(GROWTH_RATE·t), paused at open
 *      checkpoints) decides the exact moment: once the unpaused curve
 *      reaches the crash point, the hand settles at that multiplier and
 *      the sweep returns the crash so the realtime server broadcasts it
 *      (with the now-revealed multiplier + authoritative results).
 *
 * Idempotent: settleCrashPokerHand locks the round row and no-ops on a
 * round already settled (fold-out via the action/auto-fold routes race
 * this sweep — the row lock serializes them). Internal-only: when
 * REALTIME_INTERNAL_SECRET is set the caller must send it in the
 * `x-internal-secret` header (skipped in local dev, like sweep-stale).
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

    // ── Every running hand — a handful at most, so a plain scan is cheap
    //    and avoids a jsonb/expression index for the due-time predicate. ──
    const runningRounds = await db
      .select()
      .from(crashArenaRounds)
      .where(eq(crashArenaRounds.status, "running"))
      .limit(50);

    if (runningRounds.length === 0) {
      return NextResponse.json({
        success: true,
        data: { scanned: 0, crashed: [], updates: [] },
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
      multiplier: number;
      results: Awaited<ReturnType<typeof settleCrashPokerHand>>;
    }> = [];
    // Per-table events the realtime server broadcasts to the table room.
    const updates: Array<Record<string, unknown>> = [];

    for (const round of runningRounds) {
      const table = tableById.get(round.tableId);
      const rawHand = round.handState;
      if (!table || !rawHand || typeof rawHand !== "object") continue;
      const crashPoint = Number(round.crashPoint);
      const entries = entriesByRound.get(round.id) ?? [];

      let hand = handFromEntries({
        round,
        entries,
        carryOver: Number(table.carryOver ?? 0),
      }) as CrashPokerHand;

      // ── 1. Stall guard: an open window past its deadline auto-resolves
      //    the silent players (auto-check matched, auto-fold unmatched). ──
      if (hand.bettingOpen) {
        const expired = expireStaleActions(hand, now);
        if (expired.autoFolded.length > 0 || expired.autoChecked.length > 0) {
          hand = expired.hand;
          // The window closed → the flight resumes from the checkpoint.
          if (!hand.bettingOpen) hand = resumeFlight(hand, now);

          await persistHand(round.id, hand, entries, expired);

          if (expired.handOver) {
            const settled = await settleCrashPokerHand(round.id);
            updates.push({
              tableId: round.tableId,
              roundId: round.id,
              handOver: true,
              autoFolded: expired.autoFolded,
              autoChecked: expired.autoChecked,
              results: {
                winnerUserId: settled.winnerUserId,
                pot: settled.pot,
                rake: settled.rake,
                payout: settled.payout,
                payoutGross: settled.payoutGross,
                carryOver: settled.carryOver,
                activeAtCrash: settled.activeAtCrash,
                pots: settled.pots,
                returns: settled.returns,
                entries: settled.entries,
                nextRoundAt: settled.nextRoundAt,
              },
            });
            continue;
          }
          // Non-terminal expiry — tell the table (fold badges + window).
          updates.push({
            tableId: round.tableId,
            roundId: round.id,
            autoFolded: expired.autoFolded,
            autoChecked: expired.autoChecked,
            checkpointIndex: hand.checkpointIndex,
            bettingOpen: hand.bettingOpen,
            windowDeadlineAt: hand.windowDeadlineAt ?? null,
          });
        }
      }

      // ── 2. Crash: the pause-aware curve reached the crash point while
      //    the flight is NOT paused → settle now. (A fold-out settle above
      //    already `continue`d.) ─────────────────────────────────────────
      if (
        !hand.bettingOpen &&
        Number.isFinite(crashPoint) &&
        crashPoint > 0 &&
        isCrashDueAt(hand, now, crashPoint)
      ) {
        const settled = await settleCrashPokerHand(round.id);
        if (settled.alreadySettled) continue;
        crashed.push({
          tableId: round.tableId,
          roundId: round.id,
          // The authoritative crash multiplier — revealed only now, at the
          // moment of the crash, never before.
          multiplier: settled.crashPoint,
          results: settled,
        });
        continue;
      }

      // ── 3. Checkpoint opening: the curve finished this segment and
      //    reached the next 0.25x multiplier → open it (the flight pauses
      //    there for the betting window). ────────────────────────────────
      if (!hand.bettingOpen && hasCurveReachedNextCheckpoint(hand, now)) {
        hand = openNextCheckpoint(hand, now);
        await persistHand(round.id, hand, entries, null);
        updates.push({
          tableId: round.tableId,
          roundId: round.id,
          checkpointOpened: true,
          checkpointIndex: hand.checkpointIndex,
          windowDeadlineAt: hand.windowDeadlineAt ?? null,
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        scanned: runningRounds.length,
        crashed,
        updates,
      },
    });
  } catch (err) {
    console.error("[crash-arena:crash-check]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}

/**
 * Persist the sweep's hand changes: the updated hand state + round columns,
 * plus any auto-resolved entry flags (folds/checks). One transaction per
 * changed round.
 */
async function persistHand(
  roundId: number,
  hand: CrashPokerHand,
  entries: Array<{ id: number; userId: number }>,
  expired: { autoFolded: number[]; autoChecked: number[] } | null,
) {
  await db.transaction(async (tx) => {
    const foldedIds = new Set(expired?.autoFolded ?? []);
    const checkedIds = new Set(expired?.autoChecked ?? []);
    for (const entry of entries) {
      if (!foldedIds.has(entry.userId) && !checkedIds.has(entry.userId)) continue;
      const hp = hand.players.find((p) => p.userId === entry.userId);
      if (!hp) continue;
      const isFolded = foldedIds.has(entry.userId);
      await tx
        .update(crashArenaEntries)
        .set({
          lastAction: isFolded ? "fold" : "check",
          foldedAtMultiplier:
            isFolded && hp.foldedAtMultiplier != null
              ? String(hp.foldedAtMultiplier)
              : undefined,
          isActive: isFolded ? false : true,
        })
        .where(eq(crashArenaEntries.id, entry.id));
    }
    await tx
      .update(crashArenaRounds)
      .set({
        handState: hand,
        checkpointIndex: hand.checkpointIndex,
        requiredBet: hand.requiredBet.toFixed(2),
        bettingOpen: hand.bettingOpen,
      })
      .where(eq(crashArenaRounds.id, roundId));
  });
}
