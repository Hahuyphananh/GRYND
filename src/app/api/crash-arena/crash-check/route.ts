import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { crashArenaRounds } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { settleCrashPokerHand } from "../../../../lib/crash-poker/settleHand";
import { crashDueAtMs } from "../../../../lib/games/crash/generateCrashPoint";

export const dynamic = "force-dynamic";

/**
 * POST /api/crash-arena/crash-check
 *
 * Internal endpoint driven by the realtime server's crash sweep (see
 * `runCrashArenaCrashSweep` in realtime-server/server.js).
 *
 * The crash point is generated server-side at hand start and is NEVER sent
 * to clients before the crash. Because the curve is deterministic
 * (multiplier = e^(GROWTH_RATE·t)), the exact wall-clock moment the curve
 * crosses the crash point is also a server-side constant:
 *   crashAt = roundCreatedAt + ln(crashPoint) / GROWTH_RATE
 *
 * This sweep settles every running hand whose crash moment has passed, so
 * the crash happens at the exact same multiplier for everyone, decided by
 * server time — never by a client's latency or a client-side timer. The
 * crash point is only revealed in the broadcast AFTER the hand is settled.
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
      .select({
        id: crashArenaRounds.id,
        tableId: crashArenaRounds.tableId,
        status: crashArenaRounds.status,
        createdAt: crashArenaRounds.createdAt,
        crashPoint: crashArenaRounds.crashPoint,
      })
      .from(crashArenaRounds)
      .where(eq(crashArenaRounds.status, "running"))
      .limit(50);

    const crashed: Array<{
      tableId: number;
      roundId: number;
      multiplier: number;
      results: Awaited<ReturnType<typeof settleCrashPokerHand>>;
    }> = [];

    for (const round of runningRounds) {
      const crashPoint = Number(round.crashPoint);
      if (!Number.isFinite(crashPoint) || crashPoint <= 0) continue;
      // Not due yet — the curve hasn't crossed the crash point.
      if (now < crashDueAtMs(round.createdAt, crashPoint)) continue;

      // Due: settle. Idempotent + row-locked, so a concurrent fold-out
      // settlement (action / auto-fold routes) simply wins the lock and
      // this call no-ops instead of double-crediting anyone.
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
