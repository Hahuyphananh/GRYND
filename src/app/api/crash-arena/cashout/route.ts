import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaRounds,
  crashArenaEntries,
} from "../../../../db/schema";
import { eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * POST /api/crash-arena/cashout
 *
 * Body: { roundId: number, cashoutMultiplier: number }
 *
 * Server-authoritative cashout:
 *   1. Loads the round to get the actual crashPoint.
 *   2. Compares the client-reported multiplier against the REAL crash point.
 *   3. If multiplier <= crashPoint → survived (won).
 *   4. If multiplier > crashPoint → busted (lost).
 *   5. Records result in crash_arena_entries.
 *
 * THE CLIENT MULTIPLIER IS NEVER TRUSTED as the source of truth.
 * The server calculates whether the player survived based on the
 * actual crash point. The client multiplier is only used for history.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { roundId, cashoutMultiplier } = await req.json();

    if (!roundId || !Number.isFinite(cashoutMultiplier) || cashoutMultiplier < 1) {
      return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
    }

    // ── Get user ──────────────────────────────────────────────────────────
    const userData = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!userData.length) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }
    const user = userData[0];

    // ── Get the round (server source of truth) ────────────────────────────
    const roundData = await db
      .select()
      .from(crashArenaRounds)
      .where(eq(crashArenaRounds.id, roundId))
      .limit(1);

    if (!roundData.length) {
      return NextResponse.json({ success: false, error: "Round not found" }, { status: 404 });
    }
    const round = roundData[0];

    if (round.status !== "running") {
      return NextResponse.json({ success: false, error: "Round is not active" }, { status: 400 });
    }

    // ── Get player's entry for this round ─────────────────────────────────
    const entryData = await db
      .select()
      .from(crashArenaEntries)
      .where(
        and(
          eq(crashArenaEntries.roundId, roundId),
          eq(crashArenaEntries.userId, user.id),
        ),
      )
      .limit(1);

    if (!entryData.length) {
      return NextResponse.json({ success: false, error: "Not entered in this round" }, { status: 400 });
    }
    const entry = entryData[0];

    if (entry.result !== "pending") {
      return NextResponse.json({ success: false, error: "Already cashed out or busted" }, { status: 400 });
    }

    // ── Server-authoritative crash check ──────────────────────────────────
    const actualCrashPoint = Number(round.crashPoint);
    const survived = cashoutMultiplier <= actualCrashPoint;

    // ── Update entry ──────────────────────────────────────────────────────
    await db
      .update(crashArenaEntries)
      .set({
        cashoutMultiplier: cashoutMultiplier.toFixed(2),
        cashoutTimestamp: new Date(),
        result: survived ? "won" : "lost",
      })
      .where(eq(crashArenaEntries.id, entry.id));

    return NextResponse.json({
      success: true,
      data: {
        entryId: entry.id,
        survived,
        cashoutMultiplier: Number(cashoutMultiplier.toFixed(2)),
        actualCrashPoint,
      },
    });
  } catch (err) {
    console.error("[crash-arena:cashout]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
