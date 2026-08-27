import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
} from "../../../../db/schema";
import { eq, and, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isCrashArenaAiBotId } from "../../../../lib/crash-arena/aiBot";
import { broadcastTableUpdate } from "../../../../lib/crash-arena/rooms";

/**
 * POST /api/crash-arena/remove-ai
 *
 * Body: { tableId: number, userId: number }
 *
 * Removes an AI seat from a PRIVATE table (the host only, mirroring the
 * poker table AIs — the host who added the AIs manages them).
 *
 *   1. Validates the caller is the table host and the table is private.
 *   2. Validates the target user is a reserved bot seated at this table.
 *   3. If a hand is mid-flight with a pending entry for the bot, marks it
 *      "lost" (the same release used for disconnects): the bot's committed
 *      chips stay in the pot as dead money, but it can no longer win or
 *      count toward the fold-out / active-at-crash sets.
 *   4. Marks the seat "left" — the seat frees immediately.
 *
 * Removing is NOT a refund: bot stacks are virtual. Re-adding the same bot
 * later seats it fresh with a new stack.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { tableId, userId: botUserId } = await req.json();
    if (!tableId || !Number.isFinite(Number(botUserId))) {
      return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
    }

    const [userRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);
    if (!userRow) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }

    const [table] = await db
      .select()
      .from(crashArenaTables)
      .where(eq(crashArenaTables.id, tableId))
      .limit(1);
    if (!table) {
      return NextResponse.json({ success: false, error: "Table not found" }, { status: 404 });
    }
    if (table.status === "closed") {
      return NextResponse.json({ success: false, error: "Table is closed" }, { status: 400 });
    }
    // AIs are private-only, and only the host may manage them.
    if (!table.isPrivate) {
      return NextResponse.json({
        success: false,
        error: "AIs can only be managed on private tables",
      }, { status: 400 });
    }
    if (table.hostId !== userRow.id) {
      return NextResponse.json({ success: false, error: "Only the host can remove AIs" }, { status: 403 });
    }

    // ── The target must be a reserved bot seated at THIS table ───────────
    const botId = Number(botUserId);
    if (!(await isCrashArenaAiBotId(botId))) {
      return NextResponse.json({ success: false, error: "Not an AI seat" }, { status: 400 });
    }
    const [seat] = await db
      .select({ id: crashArenaPlayers.id })
      .from(crashArenaPlayers)
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          eq(crashArenaPlayers.userId, botId),
          eq(crashArenaPlayers.status, "seated"),
        ),
      )
      .limit(1);
    if (!seat) {
      return NextResponse.json({ success: false, error: "AI is not seated at this table" }, { status: 400 });
    }

    // ── Release a mid-round entry (disconnect-cleanup semantics): the bot
    //    is out of the hand — committed chips stay in the pot as dead
    //    money, and it can no longer win or block settlement. ─────────────
    const openRound = await db
      .select({ id: crashArenaRounds.id })
      .from(crashArenaRounds)
      .where(
        and(
          eq(crashArenaRounds.tableId, tableId),
          ne(crashArenaRounds.status, "settled"),
        ),
      )
      .orderBy(crashArenaRounds.createdAt)
      .limit(1);

    if (openRound[0]) {
      await db
        .update(crashArenaEntries)
        .set({ result: "lost", isActive: false })
        .where(
          and(
            eq(crashArenaEntries.roundId, openRound[0].id),
            eq(crashArenaEntries.userId, botId),
            eq(crashArenaEntries.result, "pending"),
          ),
        );
    }

    // ── Free the seat ────────────────────────────────────────────────────
    await db
      .update(crashArenaPlayers)
      .set({ status: "left" })
      .where(eq(crashArenaPlayers.id, seat.id));

    const botName = (
      await db.select({ name: users.name }).from(users).where(eq(users.id, botId)).limit(1)
    )[0]?.name;

    broadcastTableUpdate(tableId, { aiRemoved: true, userId: botId });

    return NextResponse.json({
      success: true,
      data: {
        userId: botId,
        name: botName ?? "GRYND AI",
      },
    });
  } catch (err) {
    console.error("[crash-arena:remove-ai]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
