import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaPlayers,
  crashArenaTransactions,
} from "../../../../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  broadcastLobbyUpdate,
  broadcastTableUpdate,
} from "../../../../lib/crash-arena/rooms";

/**
 * POST /api/crash-arena/leave
 *
 * Body: { tableId: number }
 *
 * 1. Finds the player's seated row at the table.
 * 2. Returns remaining balance to user wallet.
 * 3. Marks player as "left".
 * 4. Creates LEAVE transaction.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { tableId } = await req.json();
    if (!tableId) {
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

    // ── Find seated player row ────────────────────────────────────────────
    const playerData = await db
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

    if (!playerData.length) {
      return NextResponse.json({ success: false, error: "Not seated at this table" }, { status: 400 });
    }
    const player = playerData[0];
    const returnAmount = Number(player.balance);

    // ── Return balance to wallet ──────────────────────────────────────────
    if (returnAmount > 0) {
      await db
        .update(users)
        .set({ balance: sql`${users.balance} + ${returnAmount}` })
        .where(eq(users.clerkId, userId));
    }

    // ── Mark as left ──────────────────────────────────────────────────────
    await db
      .update(crashArenaPlayers)
      .set({ status: "left" })
      .where(eq(crashArenaPlayers.id, player.id));

    // ── Record transaction ────────────────────────────────────────────────
    await db.insert(crashArenaTransactions).values({
      userId: user.id,
      tableId,
      amount: returnAmount.toFixed(2),
      type: "LEAVE",
      reason: `Left table with balance`,
    });

    // Best-effort live fanout so the remaining players + lobby refresh.
    broadcastTableUpdate(tableId, { left: true, userId: user.id });
    broadcastLobbyUpdate({ left: true, tableId });

    // ── Get updated wallet ────────────────────────────────────────────────
    const [updated] = await db
      .select({ balance: users.balance })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    return NextResponse.json({
      success: true,
      data: {
        returned: returnAmount,
        walletBalance: Number(updated.balance),
      },
    });
  } catch (err) {
    console.error("[crash-arena:leave]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
