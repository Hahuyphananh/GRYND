import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaTransactions,
} from "../../../../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * POST /api/crash-arena/join
 *
 * Body: { tableId: number, buyInAmount: number }
 *
 * 1. Validates table exists and is not full/closed.
 * 2. Validates buy-in >= minimum.
 * 3. Deducts buy-in from user wallet (atomic).
 * 4. Creates crash_arena_players row.
 * 5. Creates BUY_IN transaction.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { tableId, buyInAmount } = await req.json();

    if (!tableId || !Number.isFinite(buyInAmount) || buyInAmount <= 0) {
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

    if (buyInAmount < Number(table.minimumBuyin)) {
      return NextResponse.json({
        success: false,
        error: `Minimum buy-in is ${table.minimumBuyin}`,
      }, { status: 400 });
    }

    // ── Check capacity ────────────────────────────────────────────────────
    const seatedCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(crashArenaPlayers)
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          eq(crashArenaPlayers.status, "seated"),
        ),
      );

    if (Number(seatedCount[0]?.count ?? 0) >= table.maxPlayers) {
      return NextResponse.json({ success: false, error: "Table is full" }, { status: 400 });
    }

    // ── Check if already seated ───────────────────────────────────────────
    const existing = await db
      .select()
      .from(crashArenaPlayers)
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          eq(crashArenaPlayers.userId, user.id),
          eq(crashArenaPlayers.status, "seated"),
        ),
      )
      .limit(1);

    if (existing.length) {
      return NextResponse.json({ success: false, error: "Already seated at this table" }, { status: 400 });
    }

    // ── Deduct from wallet (atomic) ───────────────────────────────────────
    const [deducted] = await db
      .update(users)
      .set({ balance: sql`${users.balance} - ${buyInAmount}` })
      .where(
        sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${buyInAmount}`,
      )
      .returning({ balance: users.balance, id: users.id });

    if (!deducted) {
      return NextResponse.json({ success: false, error: "Insufficient balance" }, { status: 400 });
    }

    // ── Create player row ─────────────────────────────────────────────────
    const [player] = await db
      .insert(crashArenaPlayers)
      .values({
        tableId,
        userId: user.id,
        balance: buyInAmount.toFixed(2),
        status: "seated",
      })
      .returning();

    // ── Record transaction ────────────────────────────────────────────────
    await db.insert(crashArenaTransactions).values({
      userId: user.id,
      tableId,
      amount: buyInAmount.toFixed(2),
      type: "BUY_IN",
      reason: `Joined ${table.name}`,
    });

    return NextResponse.json({
      success: true,
      data: {
        playerId: player.id,
        balance: Number(player.balance),
        walletBalance: Number(deducted.balance),
        tableId,
      },
    });
  } catch (err) {
    console.error("[crash-arena:join]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
