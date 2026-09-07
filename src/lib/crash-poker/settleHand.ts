// src/lib/crash-poker/settleHand.ts
//
// Shared, server-authoritative settlement for a Crash Arena hand. Used by
// BOTH the fold route (a fold-out ends the hand immediately) and the
// settle/crash-check paths (the crash ended the hand). Outcome
// determination is delegated to `resolveHand()` in roundSystem.js — the
// single, clean hook for the rank / pot rules — so neither route hardcodes
// payout logic.
//
// Settlement:
//   1. Rebuilds the hand from the round row + entries (+ table carry-over).
//   2. resolveHand() ranks the players by fold order and splits the pot by
//      linear weights:
//        • rank 1 = sole survivor (fold-out) or the last fold before the
//          crash — takes the biggest share (pot − 5% fee, weighted);
//        • every other folder ranks below and takes a smaller share;
//        • crash victims get NOTHING;
//        • nobody folded + crash → nobody wins; the full pot carries over.
//   3. Marks entries won / folded / lost, credits EVERY ranked player's
//      table balance, writes one WIN transaction per ranked player (+ one
//      RAKE on the winner) on real tables only, updates the table's
//      carry-over, settles the round, re-opens the table, and broadcasts.

import { db } from "../../db/client";
import {
  crashArenaTables,
  crashArenaPlayers,
  crashArenaRounds,
  crashArenaEntries,
  crashArenaTransactions,
  users,
} from "../../db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { handFromEntries, resolveHand } from "./roundSystem";
import { PLATFORM_FEE, NEXT_ROUND_COUNTDOWN_MS } from "./constants";
import { broadcastTableUpdate } from "../crash-arena/rooms";
import { isCrashArenaAiBotId } from "../crash-arena/aiBot";
import type { CrashPokerHand } from "./types";

export interface CrashPokerPayout {
  userId: number;
  rank: number;
  amount: number;
}

export interface CrashPokerSettleResult {
  roundId: number;
  alreadySettled: boolean;
  winnerUserId: number | null;
  pot: number;
  rake: number;
  /** Rank-1 payout (the biggest share). */
  payout: number;
  /** Distributable pool (pot − rake). */
  payoutGross: number;
  carryOver: number;
  activeAtCrash: number[];
  payouts: CrashPokerPayout[];
  crashPoint: number;
  seed: string | null;
  seedHash: string | null;
  entries: {
    userId: number;
    result: string;
    contributed: number;
    foldedAtMultiplier: number | null;
  }[];
  /** Absolute epoch-ms of the next round start (null when already settled). */
  nextRoundAt: number | null;
}

/**
 * Settle a Crash Arena hand. Idempotent: a round already marked "settled"
 * returns immediately with `alreadySettled: true`.
 *
 * @param roundId crash_arena_rounds.id
 */
export async function settleCrashPokerHand(
  roundId: number,
): Promise<CrashPokerSettleResult> {
  // The ENTIRE settlement runs in one transaction that locks the round row
  // (`FOR UPDATE`) — two concurrent settle calls (crash + fold-out racing,
  // the client settle + the crash sweep) serialize here: the second caller
  // waits, re-reads `status === "settled"`, and no-ops instead of
  // double-crediting anyone. Every read (table, entries, carry-over) and
  // every write (entries, balances, ledger, statuses) shares the lock.
  const outcome = await db.transaction(async (tx) => {
    const roundData = await tx
      .select()
      .from(crashArenaRounds)
      .where(eq(crashArenaRounds.id, roundId))
      .limit(1)
      .for("update");

    if (!roundData.length) {
      throw new Error(`Round ${roundId} not found`);
    }
    const round = roundData[0];

    if (round.status === "settled") {
      return {
        alreadySettled: true as const,
        round,
        tableId: round.tableId,
        updatedEntries: [] as CrashPokerSettleResult["entries"],
        resolved: {
          pot: 0,
          carryOver: 0,
          activeAtCrash: [] as number[],
          payouts: [] as CrashPokerPayout[],
        },
        rake: 0,
        payout: 0,
        payoutGross: 0,
        winnerUserId: null as number | null,
        nextRoundAt: null as Date | null,
        tableIsAi: false,
        tableIsPrivate: false,
      };
    }

    const tableId = round.tableId;
    const crashPoint = Number(round.crashPoint);

    const tableData = await tx
      .select()
      .from(crashArenaTables)
      .where(eq(crashArenaTables.id, tableId))
      .limit(1);
    if (!tableData.length) {
      throw new Error(`Table ${tableId} not found`);
    }
    const table = tableData[0];

    const entries = await tx
      .select()
      .from(crashArenaEntries)
      .where(eq(crashArenaEntries.roundId, roundId));

    if (entries.length === 0) {
      throw new Error(`No entries in round ${roundId}`);
    }

    const tableCarryOver = Number(table.carryOver ?? 0);
    const hand = handFromEntries({
      round,
      entries,
      carryOver: tableCarryOver,
    }) as CrashPokerHand;
    const resolved = resolveHand(hand, crashPoint);
    const winnerUserId = resolved.winnerUserId;
    const payouts = resolved.payouts ?? [];

    // ── Money math ────────────────────────────────────────────────────────
    // The whole pot (minus the 5% fee) is the distributable pool; every
    // ranked player takes their weighted share (resolveHand already split
    // it, conserving every cent).
    let rake = resolved.rake;
    let payout = 0;
    let carryOver = resolved.carryOver;
    if (winnerUserId != null) {
      payout = payouts.find((p) => p.userId === winnerUserId)?.amount ?? 0;
      carryOver = 0;
    }

    // ── Mark entries ──────────────────────────────────────────────────────
    const rankedUserIds = new Set(payouts.map((p) => p.userId));
    const activeAtCrashIds = new Set(resolved.activeAtCrash);

    const updatedEntries: CrashPokerSettleResult["entries"] = [];
    for (const entry of entries) {
      let result = "lost";
      if (entry.userId === winnerUserId) {
        result = "won";
      } else if (rankedUserIds.has(entry.userId)) {
        result = "folded";
      }
      await tx
        .update(crashArenaEntries)
        .set({
          result,
          isActive: false,
        })
        .where(eq(crashArenaEntries.id, entry.id));
      updatedEntries.push({
        userId: entry.userId,
        result,
        contributed: Number(entry.contributed ?? 0),
        // The multiplier where this player folded — lets the UI render the
        // fold order (and the winner's successful fold point).
        foldedAtMultiplier:
          entry.foldedAtMultiplier != null ? Number(entry.foldedAtMultiplier) : null,
      });
    }

    // ── Credit EVERY ranked player's table balance ───────────────────────
    for (const p of payouts) {
      if (p.amount <= 0) continue;
      await tx
        .update(crashArenaPlayers)
        .set({ balance: sql`${crashArenaPlayers.balance} + ${p.amount}` })
        .where(
          and(
            eq(crashArenaPlayers.tableId, tableId),
            eq(crashArenaPlayers.userId, p.userId),
          ),
        );
    }

    // ── WIN / RAKE transactions (real tables only — practice and PRIVATE
    //    tables are virtual chips that never touch the ledger; bot seats
    //    are reserved users whose table balances are virtual too, so their
    //    wins are never ledgered). ─────────────────────────────────────────
    if (!table.isAi && !table.isPrivate) {
      for (const p of payouts) {
        if (p.amount <= 0) continue;
        if (await isCrashArenaAiBotId(p.userId)) continue;
        await tx.insert(crashArenaTransactions).values({
          userId: p.userId,
          tableId,
          amount: p.amount.toFixed(2),
          type: "WIN",
          reason: `Won Crash Arena hand #${round.id} (rank ${p.rank} of ${payouts.length}, pot ${resolved.pot.toFixed(2)})`,
        });
      }
      if (rake > 0 && winnerUserId != null && !(await isCrashArenaAiBotId(winnerUserId))) {
        await tx.insert(crashArenaTransactions).values({
          userId: winnerUserId,
          tableId,
          amount: rake.toFixed(2),
          type: "RAKE",
          reason: `Platform fee (5%), hand #${round.id}`,
        });
      }
    }

    // ── Carry-over: a hand with no winner keeps the whole pot for the
    //    next hand (server-authoritative on the table row). ──────────────
    await tx
      .update(crashArenaTables)
      .set({ carryOver: carryOver.toFixed(2) })
      .where(eq(crashArenaTables.id, tableId));

    // ── Settle the round + re-open the table ─────────────────────────────
    // The resolved hand (with payouts + winner) is persisted into hand_state
    // so the tables poll can serve authoritative results to clients that
    // missed the socket broadcast.
    await tx
      .update(crashArenaRounds)
      .set({
        status: "settled",
        handState: {
          ...hand,
          winnerUserId,
          payouts,
          resolvedAt: Date.now(),
        },
      })
      .where(eq(crashArenaRounds.id, roundId));

    // Schedule the NEXT round start on an absolute wall-clock deadline
    // (settle time + countdown). Every client counts down to this same
    // moment and the start-round route rejects early starts, so a slow or
    // desynced client can never see the round fire before its countdown.
    const nextRoundAt = new Date(Date.now() + NEXT_ROUND_COUNTDOWN_MS);
    await tx
      .update(crashArenaTables)
      .set({ status: "waiting", nextRoundAt })
      .where(eq(crashArenaTables.id, tableId));

    // Seat any wait-listed players now that the hand is over.
    await tx
      .update(crashArenaPlayers)
      .set({ status: "seated" })
      .where(
        and(
          eq(crashArenaPlayers.tableId, tableId),
          eq(crashArenaPlayers.status, "waiting"),
        ),
      );

    return {
      alreadySettled: false as const,
      round,
      tableId,
      updatedEntries,
      resolved,
      rake,
      payout,
      payoutGross: resolved.payoutGross,
      winnerUserId,
      nextRoundAt,
      tableIsAi: table.isAi,
      tableIsPrivate: table.isPrivate,
    };
  });

  const { round, tableId, updatedEntries, resolved, rake, payout, payoutGross, winnerUserId, alreadySettled, nextRoundAt, tableIsAi, tableIsPrivate } = outcome;

  // Best-effort fanout so the whole table reconciles instantly (after the
  // transaction committed).
  broadcastTableUpdate(tableId, {
    settled: true,
    roundId,
    pot: resolved.pot,
    rake,
    winnerPayout: payout,
    payoutGross,
    carryOver: alreadySettled ? 0 : resolved.carryOver,
    crashPoint: Number(round.crashPoint ?? 0),
    winnerUserId,
    payouts: resolved.payouts,
    activeAtCrash: resolved.activeAtCrash,
    // Absolute epoch-ms of the next round start — clients count down to it.
    nextRoundAt:
      nextRoundAt != null ? nextRoundAt.getTime() : Date.now() + NEXT_ROUND_COUNTDOWN_MS,
  });

  // ── User stats + quests (real tables only, human participants) ──
  // Crash Arena is a multi-player PvP table, so a settled hand is a PvP
  // outcome. The rank-1 winner records a PvP win and each "lost"
  // participant a loss through the canonical applyLeaderboardCounters
  // pipeline (user_stats wins/losses/win_rate, pvp_wins, quests). Folded
  // entries are skipped — they received a ranked payout, so they don't
  // represent a settled win/loss. Practice/private tables use virtual
  // chips and never touch real stats (mirrors the WIN/RAKE transaction
  // gating). Fire-and-forget — never blocks settlement.
  if (
    !alreadySettled &&
    !tableIsAi &&
    !tableIsPrivate &&
    winnerUserId != null
  ) {
    recordCrashArenaStats({
      winnerUserId,
      entries: updatedEntries,
      payout,
    }).catch((err) => console.error("[crash-arena] stats failed:", err));
  }

  return {
    roundId,
    alreadySettled,
    winnerUserId,
    pot: resolved.pot,
    rake,
    payout,
    payoutGross,
    carryOver: alreadySettled ? 0 : resolved.carryOver,
    activeAtCrash: resolved.activeAtCrash,
    payouts: resolved.payouts,
    crashPoint: Number(round.crashPoint ?? 0),
    seed: round.seed,
    seedHash: round.seedHash,
    entries: updatedEntries,
    nextRoundAt:
      outcome.nextRoundAt != null
        ? outcome.nextRoundAt.getTime()
        : null,
  };
}

// Best-effort stat side-effect for a settled Crash Arena hand. Resolves
// numeric user ids → clerk ids (applyLeaderboardCounters keys on clerk id),
// records the winner as a PvP win and each "lost" participant as a loss.
// AI-bot seats are skipped. Fire-and-forget; a failure never blocks the
// settlement response.
async function recordCrashArenaStats(opts: {
  winnerUserId: number;
  entries: CrashPokerSettleResult["entries"];
  payout: number;
}): Promise<void> {
  const { winnerUserId, entries, payout } = opts;
  const allIds = entries.map((e) => e.userId);

  // Identify AI-bot seats (reserved users) so we don't pollute real stats.
  const botIds = new Set<number>();
  for (const id of allIds) {
    if (await isCrashArenaAiBotId(id)) botIds.add(id);
  }

  const rows = await db
    .select({ id: users.id, clerkId: users.clerkId })
    .from(users)
    .where(inArray(users.id, allIds));
  const clerkByUserId = new Map<number, string | null>();
  for (const r of rows) clerkByUserId.set(r.id, r.clerkId);

  const winnerClerk = clerkByUserId.get(winnerUserId);
  if (winnerClerk) {
    const winnerEntry = entries.find(
      (e) => e.userId === winnerUserId && e.result === "won",
    );
    applyLeaderboardCounters({
      clerkId: winnerClerk,
      game: "crash",
      betAmount: Number(winnerEntry?.contributed ?? 0),
      payout,
      isPvpWin: true,
    }).catch(() => {});
  }

  for (const e of entries) {
    if (e.userId === winnerUserId || e.result !== "lost") continue;
    if (botIds.has(e.userId)) continue;
    const clerk = clerkByUserId.get(e.userId);
    if (!clerk) continue;
    applyLeaderboardCounters({
      clerkId: clerk,
      game: "crash",
      betAmount: Number(e.contributed) || 0,
      payout: 0,
    }).catch(() => {});
  }
}