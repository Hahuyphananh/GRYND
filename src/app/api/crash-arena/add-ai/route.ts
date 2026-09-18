import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
} from "../../../../db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { CRASH_AI_DIFFICULTIES } from "../../../../lib/crash-arena/botStrategy";
import {
  getOrCreateCrashArenaAiBot,
  resolveCrashArenaAiBotIds,
} from "../../../../lib/crash-arena/aiBot";
import {
  broadcastLobbyUpdate,
  broadcastTableUpdate,
} from "../../../../lib/crash-arena/rooms";

/** Default virtual stack for an AI seat: 20× the table wager. */
const AI_STACK_MULTIPLIER = 20;

/**
 * POST /api/crash-arena/add-ai
 *
 * Body: { tableId: number, difficulty?: "easy"|"medium"|"hard", stack?: number }
 *
 * Adds an AI seat to a PRIVATE table (the host only, mirroring the poker
 * table AIs). AIs may never be added to public tables.
 *
 *   1. Validates the caller is the table host and the table is private.
 *   2. Picks the next unused reserved bot user (each AI seat is a distinct
 *      user so multiple bots can sit one table).
 *   3. Seats the bot with a virtual stack (no wallet interaction).
 *
 * The host's client drives the bot's fold/call/raise decisions through
 * /api/crash-arena/action with `forBot` + `forBotUserId`, exactly like the
 * practice-table bot.
 */
export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;

    const { tableId, difficulty, stack, name } = await req.json();
    if (!tableId) {
      return NextResponse.json({ success: false, error: "tableId is required" }, { status: 400 });
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
    // AIs are private-only, and only the host may add them.
    if (!table.isPrivate) {
      return NextResponse.json({
        success: false,
        error: "AIs can only be added to private tables",
      }, { status: 400 });
    }
    if (table.hostId !== userRow.id) {
      return NextResponse.json({ success: false, error: "Only the host can add AIs" }, { status: 403 });
    }

    const aiDifficulty = CRASH_AI_DIFFICULTIES.includes(difficulty)
      ? difficulty
      : "medium";

    // Optional custom name for this AI seat (stored on the seat, never the
    // shared users row). Empty / too long → default name.
    const nickname =
      typeof name === "string" && name.trim()
        ? name.trim().slice(0, 40)
        : null;

    // Virtual stack defaults to 20× the wager (capped at the table max
    // buy-in so an AI can't dwarf every human stack).
    const wager = Number(table.wagerAmount);
    const defaultStack = wager * AI_STACK_MULTIPLIER;
    const maxStack = Number(table.minimumBuyin) * 20;
    const aiStack =
      Number.isFinite(Number(stack)) && Number(stack) > 0
        ? Math.min(Number(stack), maxStack)
        : defaultStack;

    // ── Capacity: seated + waiting share the max seats ──────────────────
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

    // ── Pick the NEXT bot user — each Add-AI click seats a NEW bot (up
    //    to capacity). The lowest-indexed reserved bot that is NOT already
    //    seated at THIS table wins, so removed bots' slots get reused
    //    before brand-new ones are created. (A bot may sit other tables;
    //    only this table's seats are excluded.) ───────────────────────────
    const existingBots = await resolveCrashArenaAiBotIds();
    // Only ACTIVE seats exclude a bot from reuse — a previously removed bot
    // (status "left") is available again (and re-seated fresh below).
    const seatedBotIds = await db
      .select({ userId: crashArenaPlayers.userId })
      .from(crashArenaPlayers)
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          eq(crashArenaPlayers.status, "seated"),
        ),
      );
    const seatedHere = new Set(seatedBotIds.map((r) => r.userId));

    const botIndexOf = (clerkId: string) => {
      const m = clerkId.match(/(\d+)$/);
      return m ? Number(m[1]) - 1 : 0;
    };
    const available = [...existingBots.entries()]
      .filter(([id]) => !seatedHere.has(id))
      .sort((a, b) => botIndexOf(a[1]) - botIndexOf(b[1]));

    let botId: number | null = available[0]?.[0] ?? null;
    if (botId == null) {
      // Every existing bot user is already seated here → create the next
      // numbered bot.
      const usedIndexes = new Set<number>();
      for (const clerkId of existingBots.values()) {
        usedIndexes.add(botIndexOf(clerkId));
      }
      let nextIndex = 0;
      while (usedIndexes.has(nextIndex)) nextIndex++;
      botId = await getOrCreateCrashArenaAiBot(nextIndex);
    }

    // ── Seat the bot. A leftover row (a previously removed bot) is
    //    re-seated as a FRESH bot: status seated + a fresh virtual stack
    //    (removal deletes the bot, so re-adding starts clean). ───────────
    const existing = await db
      .select({ id: crashArenaPlayers.id })
      .from(crashArenaPlayers)
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          eq(crashArenaPlayers.userId, botId),
        ),
      )
      .limit(1);

    let player;
    if (existing[0]) {
      [player] = await db
        .update(crashArenaPlayers)
        .set({ status: "seated", aiDifficulty, nickname, balance: aiStack.toFixed(2) })
        .where(eq(crashArenaPlayers.id, existing[0].id))
        .returning();
    } else {
      [player] = await db
        .insert(crashArenaPlayers)
        .values({
          tableId,
          userId: botId,
          balance: aiStack.toFixed(2),
          status: "seated",
          aiDifficulty,
          nickname,
        })
        .returning();
    }

    const botName = (
      await db.select({ name: users.name }).from(users).where(eq(users.id, botId)).limit(1)
    )[0]?.name;

    broadcastTableUpdate(tableId, { aiAdded: true, userId: botId });
    broadcastLobbyUpdate({ aiAdded: true, tableId });

    return NextResponse.json({
      success: true,
      data: {
        playerId: player.id,
        userId: botId,
        name: nickname ?? botName ?? "GRYND AI",
        difficulty: aiDifficulty,
        balance: Number(player.balance),
      },
    });
  } catch (err) {
    console.error("[crash-arena:add-ai]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
