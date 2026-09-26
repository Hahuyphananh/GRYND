import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { quickQueueAssignmentEvents, quickQueueAssignments, quickQueueRequests } from "../db/schema";
import { findCompatibleQuickQueuePair, normalizeQuickQueueRequest } from "./quickQueue";
import { normalizeStake } from "./games/stakes";
import { getTrophyMapsForUsers } from "./trophyStore";
import { getRatingMapsForUsers } from "./rating";
import { createOrJoin as createOrJoinMinesMatch } from "./mines-pvp/serverStore";
import { createOrJoin as createOrJoinPlinkoMatch } from "./plinko-pvp/serverStore";
import { createOrJoin as createOrJoinBlackjackMatch } from "./blackjack-pvp/serverStore";
import { createOrJoin as createOrJoinRouletteMatch } from "./roulette-pvp/serverStore";
import { createOrJoin as createOrJoinKenoMatch } from "./keno-pvp/serverStore";
import { createOrJoin as createOrJoinLaneRushMatch } from "./lane-rush-duel/serverStore";
import { createOrJoinFourInARowDestination } from "./quickQueueFourInARow";
import { createOrJoinMemoryGridDestination } from "./quickQueueMemoryGrid";
import { createOrJoinDotsAndBoxesDestination } from "./quickQueueDotsAndBoxes";
import { createOrJoinRpsDestination } from "./quickQueueRps";
import { createOrJoinUnoDestination } from "./quickQueueUno";
import { createOrJoinTowerArenaDestination } from "./tower-arena/quickQueue";
import { createOrJoinPoolDestination } from "./quickQueuePool";
import { createOrJoinPrecisionDestination } from "./quickQueuePrecision";
import { createOrJoinHexDuelDestination } from "./quickQueueHexDuel";
import { createOrJoinChessDestination } from "./quickQueueChess";
import { createOrJoinDiceFlushDestination } from "./quickQueueDiceFlush";
import { createOrJoinCrashArenaDestination } from "./quickQueueCrashArena";

export async function claimQuickQueueAssignment({ limit = 100 } = {}) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(quickQueueRequests)
      .where(eq(quickQueueRequests.status, "queued"))
      .orderBy(asc(quickQueueRequests.queuedAt))
      .limit(Math.max(1, Math.min(limit, 500)))
      .for("update", { skipLocked: true });

    // Trophy skill snapshots for every queued player, in one query. Trophies
    // are the primary skill signal below the cap, so the matcher pairs players
    // whose per-game trophy counts are close — widening the acceptable gap the
    // longer someone waits (see src/lib/quickQueue.ts). A player with no trophy
    // rows for a game has no skill signal and falls back to FIFO for it; this
    // is the only place matchmaking reads progression, and membership is never
    // consulted.
    let trophyMaps: Record<string, Record<string, number>> = {};
    let ratingMaps: Record<string, Record<string, number>> = {};
    try {
      trophyMaps = await getTrophyMapsForUsers(rows.map((row) => row.userId));
    } catch (error) {
      console.error("[quick-queue] failed to load trophy snapshots", error);
    }
    // Elo snapshots, for the ABOVE-CAP switch: once both players have capped a
    // game their trophies are identical, so the matcher uses the prestige (Elo)
    // gap instead (see src/lib/quickQueue.ts). Best-effort like trophies.
    try {
      ratingMaps = await getRatingMapsForUsers(rows.map((row) => row.userId));
    } catch (error) {
      console.error("[quick-queue] failed to load rating snapshots", error);
    }

    const requests = rows.map((row) => ({
      ...normalizeQuickQueueRequest({
        userId: row.userId,
        preferredGames: row.preferredGames,
        preferredModes: row.preferredModes,
        region: row.region,
        playerCount: row.playerCount,
        maxWaitMs: row.maxWaitMs,
      }),
      premium: Boolean(row.premium),
      requestId: row.id,
      queuedAt: row.queuedAt.getTime(),
      trophies: trophyMaps[row.userId] ?? null,
      prestige: ratingMaps[row.userId] ?? null,
      row,
    }));

    const pair = findCompatibleQuickQueuePair(requests);
    if (!pair) return null;

    const requestIds = [pair.source.requestId, pair.partner.requestId];
    const alreadyAssigned = await tx
      .select({ id: quickQueueAssignments.id })
      .from(quickQueueAssignments)
      .where(eq(quickQueueAssignments.requestIds, requestIds as any))
      .limit(1);
    if (alreadyAssigned.length > 0) return null;
    let destinationMatchId = null;
    // STAKES ARE RETIRED (src/lib/games/stakes.js). Every queue-matched game
    // used to be created at the stake the players queued with (the Mines
    // request's stake field doubles as the queue's stake envelope). That value
    // is now normalized away HERE, at the one place all 18 queue games are
    // created, so matchmaking can never hand a game a stake — and therefore
    // never a debit or a payout — no matter what a queue row still carries
    // from before the retirement.
    const sourceStake = normalizeStake(pair.source.row?.minesStakeAmount);
    const sourceMines = Number(pair.source.row?.minesCount ?? 3);
    const partnerStake = normalizeStake(pair.partner.row?.minesStakeAmount);
    const partnerMines = Number(pair.partner.row?.minesCount ?? sourceMines);
    // Tower Arena supports 2–6 players. The pair worker matches exactly two
    // candidates (a 2-player Tower Arena), but the mode string may carry an
    // explicit seat count when a distinct quick-queue grouping is configured.
    const towerArenaPlayers = Number(pair.candidate.mode === "3p"
      ? 3
      : pair.candidate.mode === "4p"
        ? 4
        : pair.candidate.mode === "5p"
          ? 5
          : pair.candidate.mode === "6p"
            ? 6
            : pair.source.playerCount || 2);
    const createMatch = {
      "mines-pvp": (userId) => createOrJoinMinesMatch({ userId, stakeAmount: sourceStake, minesCount: sourceMines }),
      "plinko-pvp": (userId) => createOrJoinPlinkoMatch({ userId, stakeAmount: sourceStake }),
      "blackjack-pvp": (userId) => createOrJoinBlackjackMatch({ userId, stakeAmount: sourceStake }),
      "roulette-pvp": (userId) => createOrJoinRouletteMatch({ userId, stakeAmount: sourceStake }),
      "keno-pvp": (userId) => createOrJoinKenoMatch({ userId, stakeAmount: sourceStake }),
      "lane-rush-duel": (userId) => createOrJoinLaneRushMatch({ userId, stakeAmount: sourceStake, difficulty: "easy", vsBot: false }),
      "four-in-a-row": (userId) => createOrJoinFourInARowDestination({ userId, betAmount: sourceStake }),
      "memory-grid": (userId) => createOrJoinMemoryGridDestination({ userId, stakeAmount: sourceStake }),
      "dots-and-boxes": (userId) => createOrJoinDotsAndBoxesDestination({ userId, betAmount: sourceStake }),
      "rps-pvp": (userId) => createOrJoinRpsDestination({ userId, betAmount: sourceStake }),
      "uno": (userId) => createOrJoinUnoDestination({ userId, betAmount: sourceStake }),
      "tower-arena": (userId) => createOrJoinTowerArenaDestination({ userId, wager: sourceStake, maxPlayers: towerArenaPlayers }),
      "pool-masters": (userId) => createOrJoinPoolDestination({ userId, wager: sourceStake }),
      "precision": (userId) => createOrJoinPrecisionDestination({ userId, wager: sourceStake }),
      "hex-duel": (userId) => createOrJoinHexDuelDestination({ userId, wager: sourceStake }),
      "chess": (userId) => createOrJoinChessDestination({ userId, betAmount: sourceStake }),
      "dice-flush": (userId) => createOrJoinDiceFlushDestination({ userId, wager: sourceStake }),
      "crash-arena": (userId) => createOrJoinCrashArenaDestination({ userId, wager: sourceStake }),
    }[pair.candidate.gameKey];
    if (createMatch) {
      let result: any;
      try {
        result = await createMatch(pair.source.userId) as any;
      } catch (error) {
        console.error("[quick-queue] destination creation failed", { gameKey: pair.candidate.gameKey, userId: pair.source.userId, error });
        return null;
      }
      if (result?.error || !result?.match?.id) return null;
      destinationMatchId = String(result.match.id);
      let second: any;
      try {
        second = pair.candidate.gameKey === "mines-pvp"
        ? await createOrJoinMinesMatch({ userId: pair.partner.userId, stakeAmount: partnerStake, minesCount: partnerMines })
        : pair.candidate.gameKey === "four-in-a-row"
          ? await createOrJoinFourInARowDestination({ userId: pair.partner.userId, betAmount: sourceStake })
          : pair.candidate.gameKey === "memory-grid"
            ? await createOrJoinMemoryGridDestination({ userId: pair.partner.userId, stakeAmount: sourceStake })
            : pair.candidate.gameKey === "dots-and-boxes"
              ? await createOrJoinDotsAndBoxesDestination({ userId: pair.partner.userId, betAmount: sourceStake })
              : pair.candidate.gameKey === "rps-pvp"
                ? await createOrJoinRpsDestination({ userId: pair.partner.userId, betAmount: sourceStake })
                : pair.candidate.gameKey === "uno"
                ? await createOrJoinUnoDestination({ userId: pair.partner.userId, betAmount: sourceStake })
                : pair.candidate.gameKey === "tower-arena"
                    ? await createOrJoinTowerArenaDestination({ userId: pair.partner.userId, wager: sourceStake, maxPlayers: towerArenaPlayers })
                  : pair.candidate.gameKey === "pool-masters"
                    ? await createOrJoinPoolDestination({ userId: pair.partner.userId, wager: sourceStake })
                    : pair.candidate.gameKey === "precision"
                      ? createOrJoinPrecisionDestination({ userId: pair.partner.userId, wager: sourceStake })
                      : pair.candidate.gameKey === "hex-duel"
                        ? createOrJoinHexDuelDestination({ userId: pair.partner.userId, wager: sourceStake })
                        : pair.candidate.gameKey === "chess"
                          ? createOrJoinChessDestination({ userId: pair.partner.userId, betAmount: sourceStake })
                          : pair.candidate.gameKey === "dice-flush"
                            ? createOrJoinDiceFlushDestination({ userId: pair.partner.userId, wager: sourceStake })
                            : pair.candidate.gameKey === "crash-arena"
                              ? createOrJoinCrashArenaDestination({ userId: pair.partner.userId, wager: sourceStake })
                              : await createMatch(pair.partner.userId) as any;
      } catch (error) {
        console.error("[quick-queue] destination join failed", { gameKey: pair.candidate.gameKey, userId: pair.partner.userId, destinationMatchId, error });
        return null;
      }
      if (second?.error || String(second?.match?.id) !== destinationMatchId) return null;
    }
    const [assignment] = await tx.insert(quickQueueAssignments).values({
      requestIds,
      gameKey: pair.candidate.gameKey,
      mode: pair.candidate.mode,
      destinationMatchId,
      playerCount: requestIds.length,
      status: "ready",
    }).returning();
    await tx.update(quickQueueRequests).set({ status: "assigned", updatedAt: new Date() }).where(eq(quickQueueRequests.id, pair.source.requestId));
    await tx.update(quickQueueRequests).set({ status: "assigned", updatedAt: new Date() }).where(eq(quickQueueRequests.id, pair.partner.requestId));
    await tx.insert(quickQueueAssignmentEvents).values({
      assignmentId: assignment.id,
      requestIds,
      eventType: "quick_queue:ready",
      payload: {
        assignmentId: assignment.id,
        requestIds,
        gameKey: assignment.gameKey,
        mode: assignment.mode,
        destinationMatchId: assignment.destinationMatchId,
        playerCount: assignment.playerCount,
        status: assignment.status,
      },
    });
    return assignment;
  });
}
