import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
} from "../../../../db/schema";
import { eq, and, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  CRASH_MIN_WAGER,
  CRASH_MIN_BUYIN_MULTIPLIER,
} from "../../../../lib/games/crash/constants";
import {
  broadcastLobbyUpdate,
  broadcastTableUpdate,
} from "../../../../lib/crash-arena/rooms";
import {
  CRASH_ARENA_AI_NAME,
  getOrCreateCrashArenaAiBot,
} from "../../../../lib/crash-arena/aiBot";
import { CRASH_AI_DIFFICULTIES } from "../../../../lib/crash-arena/botStrategy";
import { computeBlinds } from "../../../../lib/crash-poker/roundSystem";

/** Free practice stack the human starts with (chips are virtual). */
const AI_PRACTICE_STACK_MULTIPLIER = 20; // 20× wager — ~20 rounds of practice

/**
 * POST /api/crash-arena/create-ai
 *
 * Body: { wager: number, difficulty?: "easy" | "medium" | "hard" }
 *
 * Creates a private FREE practice table (human vs the GRYND AI bot):
 *
 *   1. Ensures the reserved bot user exists (idempotent).
 *   2. Closes the caller's stale practice tables so they don't pile up.
 *   3. Creates an `is_ai` table (max 2 seats: the human + the bot) with
 *      the chosen difficulty (mirrors the poker table AIs).
 *   4. Seats BOTH players with free virtual balances — the wallet is
 *      never touched, no BUY_IN transaction is recorded.
 *
 * Rounds then run exactly like a real table (wager deducted from the
 * virtual balances, pot, crash, settle) and the client drives the bot's
 * cashout through /api/crash-arena/ai-cashout.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { wager, difficulty } = await req.json();
    const wagerNum = Number(wager);

    if (!Number.isFinite(wagerNum) || wagerNum < CRASH_MIN_WAGER) {
      return NextResponse.json(
        { success: false, error: `Minimum wager is $${CRASH_MIN_WAGER}` },
        { status: 400 },
      );
    }
    // Round wager to 2 decimal places
    const roundedWager = Math.round(wagerNum * 100) / 100;

    // Difficulty mirrors the poker AI seats — fall back to medium for
    // anything unexpected.
    const aiDifficulty = CRASH_AI_DIFFICULTIES.includes(difficulty)
      ? difficulty
      : "medium";

    // ── Get the caller's internal user id ──────────────────────────────────
    const [userRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!userRow) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }
    const hostId = userRow.id;

    // ── Ensure the reserved bot user exists ───────────────────────────────
    const botId = await getOrCreateCrashArenaAiBot();

    // ── Close the caller's stale practice tables (older than 30 min) so a
    //    user can't pile up dead AI tables. Practice tables are free, so
    //    closing one that still has the human seated is safe.
    const staleAiTables = await db
      .select({ id: crashArenaTables.id })
      .from(crashArenaTables)
      .where(
        and(
          eq(crashArenaTables.isAi, true),
          eq(crashArenaTables.status, "waiting"),
          lt(crashArenaTables.createdAt, new Date(Date.now() - 30 * 60 * 1000)),
        ),
      );

    for (const t of staleAiTables) {
      await db
        .update(crashArenaPlayers)
        .set({ status: "left" })
        .where(eq(crashArenaPlayers.tableId, t.id));
      await db
        .update(crashArenaTables)
        .set({ status: "closed" })
        .where(eq(crashArenaTables.id, t.id));
    }

    // ── Create the practice table ──────────────────────────────────────────
    // Configurable blinds: persist the Small Blind (default round(wager/2))
    // so practice hands mirror real tables.
    const { smallBlind } = computeBlinds(roundedWager);
    const [created] = await db
      .insert(crashArenaTables)
      .values({
        name: `$${roundedWager} Crash Arena (AI)`,
        wagerAmount: roundedWager.toFixed(2),
        minimumBuyin: (roundedWager * CRASH_MIN_BUYIN_MULTIPLIER).toFixed(2),
        maxPlayers: 2,
        hostId,
        status: "waiting",
        isAi: true,
        aiDifficulty,
        smallBlind: smallBlind.toFixed(2),
      })
      .returning();

    // ── Seat the human + the bot with free virtual balances ───────────────
    const freeStack = (roundedWager * AI_PRACTICE_STACK_MULTIPLIER).toFixed(2);
    await db.insert(crashArenaPlayers).values([
      {
        tableId: created.id,
        userId: hostId,
        balance: freeStack,
        status: "seated",
      },
      {
        tableId: created.id,
        userId: botId,
        balance: freeStack,
        status: "seated",
      },
    ]);

    // Best-effort live fanout so the lobby grid refreshes instantly
    // (silently no-ops in separate-process deployments; the 5 s poll
    // covers it and the lobby hides AI tables anyway).
    broadcastLobbyUpdate({ created: true, tableId: created.id, wager: roundedWager, isAi: true });
    broadcastTableUpdate(created.id, { created: true, isAi: true });

    return NextResponse.json({
      success: true,
      data: {
        tableId: created.id,
        name: created.name,
        wager: roundedWager,
        minBuyIn: roundedWager * CRASH_MIN_BUYIN_MULTIPLIER,
        isAi: true,
        aiDifficulty,
        botName: CRASH_ARENA_AI_NAME,
        freeStack: Number(freeStack),
      },
    });
  } catch (err) {
    console.error("[crash-arena:create-ai]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
