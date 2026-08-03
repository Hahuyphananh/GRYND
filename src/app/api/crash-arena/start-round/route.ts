import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
  crashArenaTransactions,
} from "../../../../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { generateRoundSeed } from "../../../../lib/games/crash/generateSeed";
import { generateCrashPoint } from "../../../../lib/games/crash/generateCrashPoint";

/**
 * POST /api/crash-arena/start-round
 *
 * Body: { tableId: number }
 *
 * Server-authoritative round creation:
 *   1. Locks in all seated players who aren't sitting out.
 *   2. Deducts the round wager from each player's table balance.
 *   3. Generates a cryptographically secure seed + crash point.
 *   4. Creates a crash_arena_rounds row.
 *   5. Creates a crash_arena_entries row for each playing player.
 *   6. Updates the table status to "active".
 *
 * Returns the round ID, crash point, seed hash (for commitment),
 * and player list (without seed — seed revealed only after round ends).
 */
export async function POST(req: Request) {
  try {
    const { userId: callerId } = await auth();
    if (!callerId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { tableId } = await req.json();
    if (!tableId) {
      return NextResponse.json({ success: false, error: "tableId is required" }, { status: 400 });
    }

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

    if (table.status === "closed") {
      return NextResponse.json({ success: false, error: "Table is closed" }, { status: 400 });
    }

    // ── Get seated players ────────────────────────────────────────────────
    const seatedPlayers = await db
      .select()
      .from(crashArenaPlayers)
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          eq(crashArenaPlayers.status, "seated"),
        ),
      );

    if (seatedPlayers.length < 1) {
      return NextResponse.json({ success: false, error: "No players at table" }, { status: 400 });
    }

    const wager = Number(table.wagerAmount);

    // ── Deduct wager from each player's table balance ─────────────────────
    const playerDeductions = [];
    for (const player of seatedPlayers) {
      if (Number(player.balance) < wager) {
        return NextResponse.json({
          success: false,
          error: `Player ${player.userId} has insufficient table balance`,
        }, { status: 400 });
      }
      playerDeductions.push({
        ...player,
        newBalance: Number(player.balance) - wager,
      });
    }

    // Apply deductions
    for (const pd of playerDeductions) {
      await db
        .update(crashArenaPlayers)
        .set({ balance: pd.newBalance.toFixed(2) })
        .where(eq(crashArenaPlayers.id, pd.id));
    }

    // ── Generate seed + crash point (server-authoritative) ─────────────────
    const { seed, hash: seedHash } = generateRoundSeed();
    const crashPoint = generateCrashPoint(seed);

    // ── Create round ──────────────────────────────────────────────────────
    const [round] = await db
      .insert(crashArenaRounds)
      .values({
        tableId,
        seed,
        seedHash,
        crashPoint: crashPoint.toFixed(2),
        status: "running",
      })
      .returning();

    // ── Create entries for each player (no wager deduction from entry — already done) ─
    for (const pd of playerDeductions) {
      await db.insert(crashArenaEntries).values({
        roundId: round.id,
        userId: pd.userId,
        result: "pending",
      });
    }

    // ── Update table status ───────────────────────────────────────────────
    await db
      .update(crashArenaTables)
      .set({ status: "active" })
      .where(eq(crashArenaTables.id, tableId));

    // ── Calculate pot ─────────────────────────────────────────────────────
    const pot = playerDeductions.length * wager;

    return NextResponse.json({
      success: true,
      data: {
        roundId: round.id,
        crashPoint,                      // sent to all players (same crash sequence)
        seedHash,                        // commitment — published before round
        pot,
        wager,
        players: playerDeductions.map((p) => ({
          userId: p.userId,
          tableBalance: p.newBalance,
        })),
        // seed is NOT returned — revealed only after round ends
      },
    });
  } catch (err) {
    console.error("[crash-arena:start-round]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
