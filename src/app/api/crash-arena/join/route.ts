import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaTransactions,
} from "../../../../db/schema";
import { eq, and, ne, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  broadcastLobbyUpdate,
  broadcastTableUpdate,
} from "../../../../lib/crash-arena/rooms";
import { CRASH_MAX_BUYIN } from "../../../../lib/games/crash/constants";
import { normalizeJoinCode } from "../../../../lib/crash-arena/joinCode";

/**
 * POST /api/crash-arena/join
 *
 * Body: { tableId: number, buyInAmount: number, joinCode?: string }
 *
 * 1. Validates table exists and is not full/closed.
 * 2. PRIVATE tables are invite-only: the host is exempt, and anyone else
 *    must supply the table's join code — the table URL alone no longer
 *    grants access (mirrors the poker private games' invite codes).
 * 3. Validates buy-in >= minimum.
 * 4. Deducts buy-in from user wallet (atomic).
 * 5. Creates crash_arena_players row.
 * 6. Creates BUY_IN transaction.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { tableId, buyInAmount, joinCode } = await req.json();

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

    if (table.isAi) {
      return NextResponse.json({
        success: false,
        error: "AI practice tables are private — start one from the lobby instead",
      }, { status: 400 });
    }

    if (buyInAmount < Number(table.minimumBuyin)) {
      return NextResponse.json({
        success: false,
        error: `Minimum buy-in is ${table.minimumBuyin}`,
      }, { status: 400 });
    }

    if (buyInAmount > CRASH_MAX_BUYIN) {
      return NextResponse.json({
        success: false,
        error: `Maximum buy-in is ${CRASH_MAX_BUYIN.toLocaleString()} tokens`,
      }, { status: 400 });
    }

    // ── Wallet check (server-enforced) ────────────────────────────────────
    // PRIVATE tables are virtual-chips only: the buy-in is PLAY MONEY the
    // player chooses freely (capped at CRASH_MAX_BUYIN), never deducted
    // from the wallet and never winnable as real tokens. Only PUBLIC tables
    // spend real tokens — so the balance check + deduction below are
    // skipped entirely for private tables.
    const isVirtual = Boolean(table.isPrivate);
    if (!isVirtual && Number(user.balance) < buyInAmount) {
      return NextResponse.json({
        success: false,
        error: "Insufficient balance",
      }, { status: 400 });
    }

    // ── Is a round currently running? ─────────────────────────────────────
    // Late joiners don't jump into a live round — they land on the wait
    // list and are seated automatically once the round settles.
    const activeRound = await db
      .select({ id: crashArenaRounds.id, status: crashArenaRounds.status, createdAt: crashArenaRounds.createdAt })
      .from(crashArenaRounds)
      .where(
        and(
          eq(crashArenaRounds.tableId, tableId),
          ne(crashArenaRounds.status, "settled"),
        ),
      )
      .orderBy(sql`${crashArenaRounds.createdAt} DESC`)
      .limit(1);

    let midRound = false;
    if (activeRound[0] && activeRound[0].status === "running") {
      const ageMs = Date.now() - new Date(activeRound[0].createdAt).getTime();
      // A running round older than 5 minutes is treated as abandoned.
      midRound = ageMs < 5 * 60 * 1000;
    }

    // ── Check capacity (seated + waiting share the seats) ────────────────
    const occupiedCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(crashArenaPlayers)
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          inArray(crashArenaPlayers.status, ["seated", "waiting"]),
        ),
      );

    if (Number(occupiedCount[0]?.count ?? 0) >= table.maxPlayers) {
      return NextResponse.json({ success: false, error: "Table is full" }, { status: 400 });
    }

    // ── Check if the caller already has a seat or a wait-list spot ───────
    const existing = await db
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

    if (existing.length) {
      const alreadyWaiting = existing[0].status === "waiting";
      return NextResponse.json({
        success: false,
        error: alreadyWaiting
          ? "You're already on the wait list for this table"
          : "Already seated at this table",
      }, { status: 400 });
    }

    // ── Invite-only gate for PRIVATE tables ──────────────────────────────
    // The host is exempt (they created the game). Anyone else must present
    // the table's join code — a member would have been caught by the
    // existing-seat check above, so a fresh join always needs the code.
    if (table.isPrivate && table.hostId !== user.id) {
      const expected = table.joinCode ? normalizeJoinCode(table.joinCode) : "";
      const supplied = normalizeJoinCode(joinCode);
      if (!expected || supplied !== expected) {
        return NextResponse.json({
          success: false,
          error: "This is a private table — join with the invite code from the host",
        }, { status: 403 });
      }
    }

    // ── Deduct from wallet (atomic) — PUBLIC tables only ──────────────────
    // Private tables are virtual: the buy-in is play money, so no wallet
    // move happens at all (the player's real balance is untouched).
    let deducted = null;
    if (!isVirtual) {
      [deducted] = await db
        .update(users)
        .set({ balance: sql`${users.balance} - ${buyInAmount}` })
        .where(
          sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${buyInAmount}`,
        )
        .returning({ balance: users.balance, id: users.id });

      if (!deducted) {
        return NextResponse.json({ success: false, error: "Insufficient balance" }, { status: 400 });
      }
    }

    // ── Create player row (waiting when a round is mid-flight) ───────────
    const [player] = await db
      .insert(crashArenaPlayers)
      .values({
        tableId,
        userId: user.id,
        balance: buyInAmount.toFixed(2),
        status: midRound ? "waiting" : "seated",
      })
      .returning();

    // ── Record transaction (real ledger only — virtual chips never touch
    //    it; private tables are play money) ────────────────────────────────
    if (!isVirtual) {
      await db.insert(crashArenaTransactions).values({
        userId: user.id,
        tableId,
        amount: buyInAmount.toFixed(2),
        type: "BUY_IN",
        reason: `Joined ${table.name}`,
      });
    }

    // Best-effort live fanout so the table room + lobby refresh
    // instantly (silently no-ops in separate-process deployments).
    broadcastTableUpdate(tableId, { joined: true, userId: user.id });
    broadcastLobbyUpdate({ joined: true, tableId });

    return NextResponse.json({
      success: true,
      data: {
        playerId: player.id,
        balance: Number(player.balance),
        walletBalance: isVirtual ? Number(user.balance) : Number(deducted.balance),
        virtual: isVirtual,
        tableId,
        status: player.status,
      },
    });
  } catch (err) {
    console.error("[crash-arena:join]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
