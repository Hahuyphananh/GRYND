import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
  crashArenaTransactions,
} from "../../../../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { broadcastTableUpdate } from "../../../../lib/crash-arena/rooms";

const PLATFORM_FEE = 0.05; // 5% rake

/**
 * POST /api/crash-arena/settle
 *
 * Body: { roundId: number }
 *
 * Server-authoritative settlement:
 *   1. Loads the round and all entries.
 *   2. Finds entries with result = "won" (survived the crash).
 *   3. Determines winner = highest cashout among survivors.
 *   4. Calculates pot = (# players) × wager.
 *   5. Calculates rake = pot × 5%.
 *   6. Winner payout = pot − rake.
 *   7. Credits winner's table balance.
 *   8. Marks losing entries as "lost" (if not already).
 *   9. Creates WIN transaction for winner, RAKE for platform.
 *   10. Updates round status to "settled", table to "waiting".
 *   11. Reveals the seed (now that the round is over).
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

    // ── Get round ─────────────────────────────────────────────────────────
    const roundData = await db
      .select()
      .from(crashArenaRounds)
      .where(eq(crashArenaRounds.id, roundId))
      .limit(1);

    if (!roundData.length) {
      return NextResponse.json({ success: false, error: "Round not found" }, { status: 404 });
    }
    const round = roundData[0];

    if (round.status === "settled") {
      return NextResponse.json({ success: false, error: "Round already settled" }, { status: 400 });
    }

    if (round.status !== "running" && round.status !== "crashed") {
      return NextResponse.json({ success: false, error: "Round not in progress" }, { status: 400 });
    }

    const tableId = round.tableId;
    const actualCrashPoint = Number(round.crashPoint);

    // ── Get table ─────────────────────────────────────────────────────────
    const tableData = await db
      .select()
      .from(crashArenaTables)
      .where(eq(crashArenaTables.id, tableId))
      .limit(1);

    if (!tableData.length) {
      return NextResponse.json({ success: false, error: "Table not found" }, { status: 404 });
    }
    const table = tableData[0];
    const wager = Number(table.wagerAmount);

    // ── Get all entries for this round ────────────────────────────────────
    const entries = await db
      .select()
      .from(crashArenaEntries)
      .where(eq(crashArenaEntries.roundId, roundId));

    if (entries.length === 0) {
      return NextResponse.json({ success: false, error: "No entries in round" }, { status: 400 });
    }

    // ── Mark any still-pending entries as lost (they didn't cash out) ─────
    for (const entry of entries) {
      if (entry.result === "pending") {
        await db
          .update(crashArenaEntries)
          .set({
            result: "lost",
            cashoutMultiplier: actualCrashPoint.toFixed(2),
            cashoutTimestamp: new Date(),
          })
          .where(eq(crashArenaEntries.id, entry.id));
      }
    }

    // Re-fetch entries after updates
    const updatedEntries = await db
      .select()
      .from(crashArenaEntries)
      .where(eq(crashArenaEntries.roundId, roundId));

    // ── Find survivors ────────────────────────────────────────────────────
    const survivors = updatedEntries.filter((e) => e.result === "won" && e.cashoutMultiplier !== null);

    // ── Calculate pot ─────────────────────────────────────────────────────
    const pot = updatedEntries.length * wager;

    let winner: typeof updatedEntries[0] | null = null;
    let winnerPayout = 0;
    let rake = 0;

    if (survivors.length > 0) {
      // Sort by cashout multiplier, highest wins
      survivors.sort((a, b) => Number(b.cashoutMultiplier) - Number(a.cashoutMultiplier));
      winner = survivors[0];

      rake = Math.floor(pot * PLATFORM_FEE);
      winnerPayout = pot - rake;

      // ── Credit winner's table balance ───────────────────────────────────
      await db
        .update(crashArenaPlayers)
        .set({
          balance: sql`${crashArenaPlayers.balance} + ${winnerPayout}`,
        })
        .where(
          and(
            eq(crashArenaPlayers.tableId, tableId),
            eq(crashArenaPlayers.userId, winner.userId),
          ),
        );

      // ── WIN/RAKE transactions (real tables only) ────────────────────────
      // AI practice rounds move only virtual chips — no ledger rows.
      if (!table.isAi) {
        // ── WIN transaction ─────────────────────────────────────────────
        await db.insert(crashArenaTransactions).values({
          userId: winner.userId,
          tableId,
          amount: winnerPayout.toFixed(2),
          type: "WIN",
          reason: `Won round #${round.id} at ${Number(winner.cashoutMultiplier).toFixed(2)}x`,
        });

        // ── RAKE transaction ────────────────────────────────────────────
        if (rake > 0) {
          await db.insert(crashArenaTransactions).values({
            userId: winner.userId, // attributed to the table; using winner's userId as proxy
            tableId,
            amount: rake.toFixed(2),
            type: "RAKE",
            reason: `Platform fee (5%), round #${round.id}`,
          });
        }
      }
    }

    // ── Mark round as settled ─────────────────────────────────────────────
    await db
      .update(crashArenaRounds)
      .set({ status: "settled" })
      .where(eq(crashArenaRounds.id, roundId));

    // ── Update table back to waiting ──────────────────────────────────────
    await db
      .update(crashArenaTables)
      .set({ status: "waiting" })
      .where(eq(crashArenaTables.id, tableId));

    // ── Seat any wait-listed players now that the round is over ──────────
    // Late joiners who landed on the wait list during the round step onto
    // the table so they're in for the next round.
    await db
      .update(crashArenaPlayers)
      .set({ status: "seated" })
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          eq(crashArenaPlayers.status, "waiting"),
        ),
      );

    // Best-effort fanout so every player at the table reconciles the
    // finished round (winner, payout, crash point) instantly.
    broadcastTableUpdate(tableId, {
      settled: true,
      roundId,
      pot,
      rake,
      winnerPayout,
      crashPoint: actualCrashPoint,
    });

    return NextResponse.json({
      success: true,
      data: {
        roundId,
        pot,
        rake,
        winnerPayout,
        crashPoint: actualCrashPoint,
        seed: round.seed,                     // revealed now that round is over
        seedHash: round.seedHash,
        winner: winner
          ? {
              userId: winner.userId,
              multiplier: Number(winner.cashoutMultiplier),
              payout: winnerPayout,
            }
          : null,
        survivors: survivors.map((s) => ({
          userId: s.userId,
          multiplier: Number(s.cashoutMultiplier),
        })),
        totalPlayers: updatedEntries.length,
        allResults: updatedEntries.map((e) => ({
          userId: e.userId,
          result: e.result,
          multiplier: e.cashoutMultiplier ? Number(e.cashoutMultiplier) : null,
        })),
      },
    });
  } catch (err) {
    console.error("[crash-arena:settle]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
