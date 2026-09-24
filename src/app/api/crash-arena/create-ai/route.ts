import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
} from "../../../../db/schema";
import { eq, and, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
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
import { toCrashAiDifficulty } from "../../../../lib/crash-arena/botStrategy";

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
 * Rounds then run exactly like a real table (ante deducted from the
 * virtual balances, pot, crash, settle) and the client drives the bot's
 * fold through /api/crash-arena/action (forBot: true).
 */
export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = gate.userId;

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
    // Accepts the canonical `easy | normal | hard` the shared lobby picker
    // sends, and this game's stored `medium`, as the same middle tier.
    const aiDifficulty = toCrashAiDifficulty(difficulty);

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
    // Every player posts the wager as a flat ante each hand — no blinds to
    // persist (small_blind stays NULL).
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
