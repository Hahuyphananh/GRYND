import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import {
  users,
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
} from "../../../../db/schema";
import { eq, ne, and, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { generateRoundSeed } from "../../../../lib/games/crash/generateSeed";
import { generateCrashPoint } from "../../../../lib/games/crash/generateCrashPoint";
import { broadcastTableUpdate } from "../../../../lib/crash-arena/rooms";
import { createHand } from "../../../../lib/crash-poker/roundSystem";
import { logError } from "../../../../lib/logError";

/**
 * POST /api/crash-arena/start-round
 *
 * Body: { tableId: number }
 *
 * Server-authoritative Crash Poker hand creation:
 *   1. Locks in all seated players who aren't sitting out.
 *   2. Assigns dealer / Small Blind / Big Blind seats (dealer rotates every
 *      hand) and posts each player's opening contribution — the Small Blind
 *      is the minimum opening contribution every non-blind player posts
 *      (the ante), the SB seat's ante IS their small blind, and the BB seat
 *      tops up to the Big Blind total. A player whose stack can't cover
 *      their blind/ante posts their whole stack and is all-in; a player
 *      with no stack at all is left out of the hand.
 *   3. Deducts opening contributions from each player's table balance —
 *      atomically inside one db.transaction (deductions, round row, entry
 *      rows and the table status flip commit or roll back together).
 *   4. Generates a cryptographically secure seed + crash point.
 *   5. Creates a crash_arena_rounds row carrying the hand state
 *      (checkpoint 0 = 1.25x open, required bet = big blind).
 *   6. Creates a crash_arena_entries row for each playing player with their
 *      contributed amount (and all-in flag when the blinds busted them).
 *   7. Updates the table status to "active".
 *
 * Returns the round ID, seed hash (commitment), the hand snapshot
 * (blinds, dealer, open checkpoint) and per-player contributions — and
 * NOTHING that reveals the crash point. The crash point + seed stay
 * server-only until the hand settles (provably-fair reveal); clients fly
 * the shared curve "blind" and learn the crash from the server broadcast.
 * `startedAt` (server epoch ms) lets clients align their curve to the
 * server's hand start so every player sees the same multiplier.
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

    // ── Server-authoritative round-start schedule: after a hand settles the
    //    table gets a `next_round_at` deadline. Every client counts down to
    //    the SAME wall-clock moment, and this gate rejects early starts — a
    //    desynced client can never fire a hand before the countdown ends.
    //    The very first hand (no next_round_at yet, ready-vote flow) and
    //    stale scheduled times (clock already passed) are unaffected.
    if (table.nextRoundAt) {
      const nextRoundAtMs = new Date(table.nextRoundAt).getTime();
      if (Date.now() < nextRoundAtMs) {
        return NextResponse.json({
          success: false,
          error: "Next round hasn't started yet",
        }, { status: 400 });
      }
    }

    // ── AI practice tables: only the host (the human who created the
    //    practice session) may start hands — prevents a stranger from
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
          error: "Only the practice-table host can start hands",
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

    // ── Guard against concurrent hand starts ─────────────────────────────
    // Two players clicking "Start Round" at the same time would otherwise
    // create two running hands. Block when a fresh hand is already in
    // flight; a running hand older than 5 minutes is treated as abandoned
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
          error: "A hand is already in progress",
        }, { status: 400 });
      }
    }

    const bigBlind = Number(table.wagerAmount);
    // Configurable blinds: the table's persisted Small Blind wins; the
    // engine falls back to round(wager / 2) when it's NULL (tables created
    // before the column existed).
    const tableSmallBlind = table.smallBlind != null ? Number(table.smallBlind) : null;

    // ── Dealer rotation: dealer advances one seat every hand. ────────────
    const roundCountData = await db
      .select({ count: sql<number>`count(*)` })
      .from(crashArenaRounds)
      .where(eq(crashArenaRounds.tableId, tableId));
    const handNumber = Number(roundCountData[0]?.count ?? 0) + 1;
    const dealerPosition = (handNumber - 1) % seatedPlayers.length;

    // ── Build the hand (blinds + ante + checkpoint 0 open). Opening
    //    contributions are capped at each player's server-authoritative
    //    table balance, so a short stack posts everything (all-in) instead
    //    of being rejected; a player with nothing to post is skipped. ─────
    const carryOver = Number(table.carryOver ?? 0);
    const stackByUser = new Map(
      seatedPlayers.map((p) => [p.userId, Number(p.balance)]),
    );
    // The hand's flight starts NOW (server epoch ms) — clients align their
    // curve to the round's createdAt; the few-ms skew is imperceptible.
    const startedAt = Date.now();
    const hand = createHand({
      players: seatedPlayers,
      bigBlind,
      dealerPosition,
      smallBlind: tableSmallBlind,
      carryOver,
      stackByUser,
      startedAt,
    });

    // ── Per-player deductions (only players who actually entered the hand
    //    — a player with no stack posts nothing and sits the hand out). ───
    const playerDeductions = [];
    for (const player of seatedPlayers) {
      const contribution = hand.players.find((hp) => hp.userId === player.userId);
      if (!contribution) continue; // skipped (no stack)
      const amount = contribution.contributed;
      const newBalance = round2(Number(player.balance) - amount);
      playerDeductions.push({
        ...player,
        newBalance,
        contribution: amount,
        role: contribution.role,
        allIn: Boolean(contribution.allIn),
      });
    }

    if (playerDeductions.length === 0) {
      return NextResponse.json({
        success: false,
        error: "No player has chips to post the blinds",
      }, { status: 400 });
    }

    // ── Generate seed + crash point (server-authoritative). The crash
    //    point is NEVER sent to clients — it stays on the round row and is
    //    only revealed (with the seed) when the hand settles. The realtime
    //    server settles the hand at the deterministic crash moment.
    const { seed, hash: seedHash } = generateRoundSeed();
    const crashPoint = generateCrashPoint(seed);

    // ── Apply every money move atomically: balance deductions, the round
    //    row (hand state), the entry rows and the table status flip either
    //    all commit or all roll back — a crash mid-way can never leave the
    //    table with deducted balances but no hand. ─────────────────────────
    const round = await db.transaction(async (tx) => {
      for (const pd of playerDeductions) {
        await tx
          .update(crashArenaPlayers)
          .set({ balance: pd.newBalance.toFixed(2) })
          .where(eq(crashArenaPlayers.id, pd.id));
      }

      const [created] = await tx
        .insert(crashArenaRounds)
        .values({
          tableId,
          seed,
          seedHash,
          crashPoint: crashPoint.toFixed(2),
          status: "running",
          smallBlind: hand.smallBlind.toFixed(2),
          bigBlind: hand.bigBlind.toFixed(2),
          dealerPosition,
          checkpointIndex: hand.checkpointIndex,
          requiredBet: hand.requiredBet.toFixed(2),
          bettingOpen: hand.bettingOpen,
          handState: hand,
        })
        .returning();

      for (const pd of playerDeductions) {
        await tx.insert(crashArenaEntries).values({
          roundId: created.id,
          userId: pd.userId,
          result: "pending",
          contributed: pd.contribution.toFixed(2),
          lastAction: pd.role === "bb" ? "bb" : pd.role === "sb" ? "sb" : "ante",
          isActive: true,
          allIn: pd.allIn,
        });
      }

      await tx
        .update(crashArenaTables)
        .set({ status: "active" })
        .where(eq(crashArenaTables.id, tableId));

      return created;
    });

    // Best-effort fanout so the other players at the table learn the
    // round id + hand instantly (client-driven fanout via
    // crashArena:updated covers the separate-process deployment). NOTE:
    // the crash point is deliberately NOT included — it must never reach
    // clients before the crash.
    broadcastTableUpdate(tableId, {
      roundStarted: true,
      roundId: round.id,
      seedHash,
      startedAt,
      pot: hand.pot,
      wager: bigBlind,
      hand: {
        smallBlind: hand.smallBlind,
        bigBlind: hand.bigBlind,
        dealerPosition,
        checkpointIndex: hand.checkpointIndex,
        requiredBet: hand.requiredBet,
        bettingOpen: hand.bettingOpen,
        carryOver,
        flightResumedAt: hand.flightResumedAt,
        windowDeadlineAt: hand.windowDeadlineAt,
        contributions: playerDeductions.map((pd) => ({
          userId: pd.userId,
          amount: pd.contribution,
          role: pd.role,
          allIn: pd.allIn,
        })),
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        roundId: round.id,
        seedHash,                        // commitment — published before the hand
        startedAt,                       // server epoch ms — curve alignment
        pot: hand.pot,
        wager: bigBlind,
        hand: {
          smallBlind: hand.smallBlind,
          bigBlind: hand.bigBlind,
          dealerPosition,
          checkpointIndex: hand.checkpointIndex,
          requiredBet: hand.requiredBet,
          bettingOpen: hand.bettingOpen,
          carryOver,
          flightResumedAt: hand.flightResumedAt,
          windowDeadlineAt: hand.windowDeadlineAt,
          contributions: playerDeductions.map((pd) => ({
            userId: pd.userId,
            amount: pd.contribution,
            role: pd.role,
            allIn: pd.allIn,
          })),
        },
        players: playerDeductions.map((p) => ({
          userId: p.userId,
          tableBalance: p.newBalance,
        })),
        // crashPoint + seed are NOT returned — server-only until the
        // hand settles (provably-fair reveal after the crash)
      },
    });
  } catch (err) {
    console.error("[crash-arena:start-round]", err);
    await logError({
      errorType: "crash_arena_round_start_error",
      errorMessage: err instanceof Error ? err.message : "Crash Arena round start failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/crash-arena/start-round",
      game: "Crash Arena",
      metadata: { operation: "start_round" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}

/** Round to 2 decimals (cents). */
function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
