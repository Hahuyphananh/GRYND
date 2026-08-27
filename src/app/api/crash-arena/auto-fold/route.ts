import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db/client";
import {
  crashArenaRounds,
  crashArenaEntries,
} from "../../../../db/schema";
import { eq, and, lt, sql } from "drizzle-orm";
import { expireStaleActions } from "../../../../lib/crash-poker/roundSystem";
import { settleCrashPokerHand } from "../../../../lib/crash-poker/settleHand";
import { broadcastTableUpdate } from "../../../../lib/crash-arena/rooms";
import type { CrashPokerHand } from "../../../../lib/crash-poker/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/crash-arena/auto-fold
 *
 * Internal endpoint driven by the realtime server's periodic checkpoint
 * sweep (see `runCrashArenaAutoFoldSweep` in realtime-server/server.js).
 *
 * Every running Crash Poker hand has a `windowDeadlineAt` — how long an
 * unmatched player has to act once a betting checkpoint window opens. A
 * staller who never acts keeps the checkpoint open and freezes betting for
 * everyone else; this sweep auto-folds overdue players so the hand keeps
 * moving (the same stall guard the action/settle routes enforce lazily,
 * made proactive for hands where nobody is acting at all).
 *
 * Idempotent: a round whose deadline already passed is re-checked and the
 * folds are already persisted → no-op. The route is internal-only: when
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

    // ── Running hands with an open checkpoint past its deadline ─────────
    const staleRounds = await db
      .select()
      .from(crashArenaRounds)
      .where(
        and(
          eq(crashArenaRounds.status, "running"),
          eq(crashArenaRounds.bettingOpen, true),
          lt(
            sql`(hand_state->>'windowDeadlineAt')::bigint`,
            String(now),
          ),
        ),
      )
      .limit(50);

    const autoFoldedByRound: Record<number, number[]> = {};
    const settledRoundIds: number[] = [];

    for (const round of staleRounds) {
      const rawHand = round.handState;
      if (!rawHand || typeof rawHand !== "object") continue;
      const hand = rawHand as CrashPokerHand;

      const expired = expireStaleActions(hand, now);
      if (expired.autoFolded.length === 0 && expired.autoChecked.length === 0) continue;

      if (expired.autoFolded.length > 0) {
        autoFoldedByRound[round.id] = expired.autoFolded;
      }

      // Persist the auto-folds / auto-checks + hand window atomically.
      await db.transaction(async (tx) => {
        const foldedIds = new Set(expired.autoFolded);
        const checkedIds = new Set(expired.autoChecked);
        for (const hp of expired.hand.players) {
          const isFolded = foldedIds.has(hp.userId);
          const isChecked = checkedIds.has(hp.userId);
          if (!isFolded && !isChecked) continue;
          const entry = await tx
            .select({ id: crashArenaEntries.id })
            .from(crashArenaEntries)
            .where(
              and(
                eq(crashArenaEntries.roundId, round.id),
                eq(crashArenaEntries.userId, hp.userId),
              ),
            )
            .limit(1);
          if (entry[0]) {
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
              .where(eq(crashArenaEntries.id, entry[0].id));
          }
        }
        await tx
          .update(crashArenaRounds)
          .set({
            handState: expired.hand,
            bettingOpen: expired.hand.bettingOpen,
          })
          .where(eq(crashArenaRounds.id, round.id));
      });

      // An expiry that left exactly one player ends the hand immediately.
      if (expired.handOver) {
        const settled = await settleCrashPokerHand(round.id);
        settledRoundIds.push(round.id);
        broadcastTableUpdate(round.tableId, {
          autoFolded: expired.autoFolded,
          autoChecked: expired.autoChecked,
          handOver: true,
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
          },
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        scanned: staleRounds.length,
        autoFoldedByRound,
        settledRoundIds,
      },
    });
  } catch (err) {
    console.error("[crash-arena:auto-fold]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
