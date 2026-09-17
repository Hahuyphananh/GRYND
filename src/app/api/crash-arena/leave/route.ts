import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaTransactions,
} from "../../../../db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  broadcastLobbyUpdate,
  broadcastTableUpdate,
} from "../../../../lib/crash-arena/rooms";
import { closeAiCrashArenaTable } from "../../../../lib/crash-arena/aiBot";
import { releaseCrashArenaSeat } from "../../../../lib/crash-arena/cleanup";
import { logError } from "../../../../lib/logError";

/**
 * POST /api/crash-arena/leave
 *
 * Body: { tableId: number, permanent?: boolean }
 *
 * Two modes:
 *   • default (permanent: false) — "Leave" button. The player steps off
 *     the table and onto the wait list, keeping their table balance so
 *     they can step back in next round (or fully cash out later).
 *   • permanent: true — "Back to Lobby". Returns the remaining table
 *     balance to the user wallet and marks the player "left".
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { tableId, permanent = false } = await req.json();
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

    // ── Find player row (seated or waiting) ───────────────────────────────
    const playerData = await db
      .select()
      .from(crashArenaPlayers)
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          eq(crashArenaPlayers.userId, user.id),
          inArray(crashArenaPlayers.status, ["seated", "waiting"]),
        ),
      )
      .limit(1);

    if (!playerData.length) {
      return NextResponse.json({ success: false, error: "Not at this table" }, { status: 400 });
    }
    const player = playerData[0];
    const returnAmount = Number(player.balance);

    // ── AI practice tables: leaving ends the practice session ─────────────
    // Balances on these tables are virtual (never deducted from the wallet),
    // so they must NEVER be refunded. Close the whole practice table — a
    // table with only the bot left has no reason to exist.
    const tableData = await db
      .select({ id: crashArenaTables.id, isAi: crashArenaTables.isAi, isPrivate: crashArenaTables.isPrivate })
      .from(crashArenaTables)
      .where(eq(crashArenaTables.id, tableId))
      .limit(1);

    const table = tableData[0];

    if (table?.isAi) {
      await closeAiCrashArenaTable(tableId);
      broadcastTableUpdate(tableId, { left: true, userId: user.id });
      broadcastLobbyUpdate({ left: true, tableId });
      return NextResponse.json({
        success: true,
        data: {
          returned: 0,
          status: "left",
          tableId,
          isAi: true,
        },
      });
    }

    if (!permanent) {
      // ── "Leave" → step off the table onto the wait list (keep balance) ──
      await db
        .update(crashArenaPlayers)
        .set({ status: "waiting" })
        .where(eq(crashArenaPlayers.id, player.id));

      // Best-effort live fanout so the remaining players + lobby refresh.
      broadcastTableUpdate(tableId, { left: true, userId: user.id });
      broadcastLobbyUpdate({ left: true, tableId });

      return NextResponse.json({
        success: true,
        data: {
          returned: 0,
          status: "waiting",
          tableId,
        },
      });
    }

    // ── "Back to Lobby" → return balance to wallet ────────────────────────
    // Use the shared releaseCrashArenaSeat helper, which performs an atomic
    // claim (UPDATE...WHERE status IN ('seated','waiting')) before refunding
    // the balance. This prevents concurrent leave requests or disconnect
    // cleanup from double-refunding the same seat balance.
    const result = await releaseCrashArenaSeat(
      tableId,
      userId,
      "Left table with balance",
    );

    if (!result.cleaned) {
      // Another release path (concurrent /leave, disconnect cleanup, or
      // stale sweep) already claimed this seat, or the player was never
      // seated/waiting. Return success with zero refund.
      return NextResponse.json({
        success: true,
        data: {
          returned: 0,
          walletBalance: Number(user.balance),
        },
      });
    }

    // ── Get updated wallet ────────────────────────────────────────────────
    const [updated] = await db
      .select({ balance: users.balance })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    return NextResponse.json({
      success: true,
      data: {
        returned: result.returned,
        walletBalance: Number(updated?.balance ?? user.balance),
      },
    });
  } catch (err) {
    console.error("[crash-arena:leave]", err);
    await logError({
      errorType: "crash_arena_leave_error",
      errorMessage: err instanceof Error ? err.message : "Crash Arena leave failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/crash-arena/leave",
      game: "Crash Arena",
      metadata: { operation: "leave_table" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
