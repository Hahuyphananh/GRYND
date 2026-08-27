import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
} from "../../../../db/schema";
import { eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { broadcastTableUpdate } from "../../../../lib/crash-arena/rooms";
import {
  CRASH_ARENA_AI_CLERK_ID,
  resolveCrashArenaAiBotId,
} from "../../../../lib/crash-arena/aiBot";

/** Upper sanity bound for any cashout multiplier (CRASH_MAX = 9.2). */
const MAX_CASHOUT_MULTIPLIER = 20;

/**
 * POST /api/crash-arena/ai-cashout
 *
 * Body: { roundId: number, cashoutMultiplier: number }
 *
 * Records the AI bot's cashout for a FREE practice round. Only reachable
 * from an `is_ai` table by the seated human — the bot has no account and
 * never connects. The server validates exactly like a human cashout:
 * the crash point is the source of truth, so the bot's entry resolves to
 * "won" when its multiplier is at/below the crash point and "lost"
 * otherwise (a greedy bot that committed past the crash point busts).
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { roundId, cashoutMultiplier } = await req.json();

    if (!roundId || !Number.isFinite(cashoutMultiplier) || cashoutMultiplier < 1 || cashoutMultiplier > MAX_CASHOUT_MULTIPLIER) {
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

    // ── Get the round ─────────────────────────────────────────────────────
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

    // Crash Poker hands have no cashout — the bot bets through
    // /api/crash-arena/action with `forBot: true` instead.
    if (round.handState != null) {
      return NextResponse.json({
        success: false,
        error: "Cashout is not part of Crash Poker hands — the bot bets instead",
      }, { status: 400 });
    }

    // ── Only AI practice tables can cash out the bot ──────────────────────
    const tableData = await db
      .select()
      .from(crashArenaTables)
      .where(eq(crashArenaTables.id, round.tableId))
      .limit(1);

    if (!tableData.length) {
      return NextResponse.json({ success: false, error: "Table not found" }, { status: 404 });
    }
    const table = tableData[0];

    if (!table.isAi) {
      return NextResponse.json({ success: false, error: "Not an AI practice table" }, { status: 400 });
    }

    // ── The caller must be the seated human at this table ─────────────────
    const callerSeat = await db
      .select({ id: crashArenaPlayers.id })
      .from(crashArenaPlayers)
      .where(
        and(
          eq(crashArenaPlayers.tableId, table.id),
          eq(crashArenaPlayers.userId, user.id),
          eq(crashArenaPlayers.status, "seated"),
        ),
      )
      .limit(1);

    if (!callerSeat.length) {
      return NextResponse.json({ success: false, error: "Not seated at this table" }, { status: 400 });
    }

    // ── The bot's entry for this round (resolved without creating it) ─────
    const botId = await resolveCrashArenaAiBotId();
    if (botId == null) {
      return NextResponse.json({ success: false, error: "AI bot not found" }, { status: 404 });
    }

    const botEntryData = await db
      .select()
      .from(crashArenaEntries)
      .where(
        and(
          eq(crashArenaEntries.roundId, roundId),
          eq(crashArenaEntries.userId, botId),
        ),
      )
      .limit(1);

    if (!botEntryData.length) {
      return NextResponse.json({ success: false, error: "Bot not entered in this round" }, { status: 400 });
    }
    const botEntry = botEntryData[0];

    if (botEntry.result !== "pending") {
      return NextResponse.json({ success: false, error: "Bot already resolved this round" }, { status: 400 });
    }

    // ── Server-authoritative crash check (same rule as a human cashout) ───
    const actualCrashPoint = Number(round.crashPoint);
    const survived = cashoutMultiplier <= actualCrashPoint;

    // ── Update the bot's entry ────────────────────────────────────────────
    await db
      .update(crashArenaEntries)
      .set({
        cashoutMultiplier: cashoutMultiplier.toFixed(2),
        cashoutTimestamp: new Date(),
        result: survived ? "won" : "lost",
      })
      .where(eq(crashArenaEntries.id, botEntry.id));

    // Best-effort fanout so the acting client (and any spectator) sees the
    // bot's cashout in the live standings instantly.
    broadcastTableUpdate(table.id, {
      cashout: {
        userId: botId,
        multiplier: Number(cashoutMultiplier.toFixed(2)),
        clerkId: CRASH_ARENA_AI_CLERK_ID,
      },
      survived,
    });

    return NextResponse.json({
      success: true,
      data: {
        entryId: botEntry.id,
        survived,
        cashoutMultiplier: Number(cashoutMultiplier.toFixed(2)),
        actualCrashPoint,
      },
    });
  } catch (err) {
    console.error("[crash-arena:ai-cashout]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
