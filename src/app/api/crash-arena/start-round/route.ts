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
import { eq, ne, and, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { generateRoundSeed } from "../../../../lib/games/crash/generateSeed";
import { generateCrashPoint } from "../../../../lib/games/crash/generateCrashPoint";
import { broadcastTableUpdate } from "../../../../lib/crash-arena/rooms";

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

    // ── AI practice tables: only the host (the human who created the
    //    practice session) may start rounds — prevents a stranger from
    //    burning the host's virtual chips.
    if (table.isAi) {
      const [hostRow] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkId, callerId))
        .limit(1);
      if (!hostRow || hostRow.id !== table.hostId) {
        return NextResponse.json({
          success: false,
          error: "Only the practice-table host can start rounds",
        }, { status: 403 });
      }
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

    // ── Guard against concurrent round starts ───────────────────────────
    // Two players clicking "Start Round" at the same time would otherwise
    // create two running rounds. Block when a fresh round is already in
    // flight; a running round older than 5 minutes is treated as abandoned
    // (e.g. everyone disconnected before settle) so the table can recover.
    const activeRound = await db
      .select()
      .from(crashArenaRounds)
      .where(
        and(
          eq(crashArenaRounds.tableId, tableId),
          ne(crashArenaRounds.status, "settled"),
        ),
      )
      .orderBy(sql`${crashArenaRounds.createdAt} DESC`)
      .limit(1);

    if (activeRound[0] && activeRound[0].status === "running") {
      const ageMs = Date.now() - new Date(activeRound[0].createdAt).getTime();
      if (ageMs < 5 * 60 * 1000) {
        return NextResponse.json({
          success: false,
          error: "A round is already in progress",
        }, { status: 400 });
      }
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

    // Best-effort fanout so the other players at the table learn the
    // round id + crash point instantly (client-driven fanout via
    // crashArena:updated covers the separate-process deployment).
    broadcastTableUpdate(tableId, {
      roundStarted: true,
      roundId: round.id,
      crashPoint,
      seedHash,
      pot,
      wager,
    });

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
