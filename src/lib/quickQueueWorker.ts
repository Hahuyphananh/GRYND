import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { quickQueueAssignmentEvents, quickQueueAssignments, quickQueueRequests } from "../db/schema";
import { findCompatibleQuickQueuePair, normalizeQuickQueueRequest } from "./quickQueue";
import { getActiveMemberIds } from "./stripe/subscriptions";
import { normalizeStake } from "./games/stakes";
import { getTrophyMapsForUsers } from "./trophyStore";
import { getRatingMapsForUsers } from "./rating";
import { createOrJoin as createOrJoinMinesMatch } from "./mines-pvp/serverStore";
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
import { createOrJoin as createOrJoinMiniGolfMatch } from "./mini-golf/serverStore";
import { createOrJoin as createOrJoinSpeedTypingMatch } from "./speed-typing/serverStore";
import { createOrJoin as createOrJoinTicTacToeMatch } from "./tic-tac-toe/serverStore";
import { createOrJoin as createOrJoinBarricadeMatch } from "./barricade/serverStore";

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
    // is the only place matchmaking reads progression.
    let trophyMaps: Record<string, Record<string, number>> = {};
    let ratingMaps: Record<string, Record<string, number>> = {};
    try {
      trophyMaps = await getTrophyMapsForUsers(rows.map((row) => row.userId));
    } catch (error) {
      console.error("[quick-queue] failed to load trophy snapshots", error);
    }
    // Elo snapshots — the second skill signal. Trophies are unbounded now, so
    // the matcher checks BOTH the trophy gap and the Elo gap for every pair
    // (see src/lib/quickQueue.ts). Best-effort like trophies.
    try {
      ratingMaps = await getRatingMapsForUsers(rows.map((row) => row.userId));
    } catch (error) {
      console.error("[quick-queue] failed to load rating snapshots", error);
    }

    // GRYND PRO priority — resolved HERE, on the server, for the whole batch in
    // one indexed query against the subscription table. The request row's
    // `premium` column is only an advisory snapshot taken at join time and is
    // deliberately NOT trusted: this fresh read means a subscription that was
    // canceled, expired or moved to a non-active status since the player queued
    // stops receiving priority immediately, and a client can never grant itself
    // priority by submitting a flag. Fails closed (empty set = nobody is Pro).
    const activeMembers = await getActiveMemberIds(rows.map((row) => row.userId));

    const requests = rows.map((row) => ({
      ...normalizeQuickQueueRequest({
        userId: row.userId,
        preferredGames: row.preferredGames,
        preferredModes: row.preferredModes,
        region: row.region,
        playerCount: row.playerCount,
        maxWaitMs: row.maxWaitMs,
      }),
      memberPriority: activeMembers.has(row.userId),
      requestId: row.id,
      queuedAt: row.queuedAt.getTime(),
      trophies: trophyMaps[row.userId] ?? null,
      ratings: ratingMaps[row.userId] ?? null,
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
    // Every queue-matched game is created at the stake the players queued with
    // (the Mines request's stake field doubles as the queue's stake envelope),
    // normalized HERE at the one place all queue games are created — so a
    // queue row can never hand a game an out-of-range stake, and a free (0)
    // queue still opens a free match.
    const sourceStake = normalizeStake(pair.source.row?.minesStakeAmount);
    const sourceMines = Number(pair.source.row?.minesCount ?? 3);
    const partnerStake = normalizeStake(pair.partner.row?.minesStakeAmount);
    const partnerMines = Number(pair.partner.row?.minesCount ?? sourceMines);
    const createMatch = {
      "mines-pvp": (userId) => createOrJoinMinesMatch({ userId, stakeAmount: sourceStake, minesCount: sourceMines }),
      "keno-pvp": (userId) => createOrJoinKenoMatch({ userId, stakeAmount: sourceStake }),
      "lane-rush-duel": (userId) => createOrJoinLaneRushMatch({ userId, stakeAmount: sourceStake, difficulty: "easy", vsBot: false }),
      "four-in-a-row": (userId) => createOrJoinFourInARowDestination({ userId, betAmount: sourceStake }),
      "memory-grid": (userId) => createOrJoinMemoryGridDestination({ userId, stakeAmount: sourceStake }),
      "dots-and-boxes": (userId) => createOrJoinDotsAndBoxesDestination({ userId, betAmount: sourceStake }),
      "rps-pvp": (userId) => createOrJoinRpsDestination({ userId, betAmount: sourceStake }),
      "uno": (userId) => createOrJoinUnoDestination({ userId, betAmount: sourceStake }),
      "tower-arena": (userId) => createOrJoinTowerArenaDestination({ userId, wager: sourceStake }),
      "pool-masters": (userId) => createOrJoinPoolDestination({ userId, wager: sourceStake }),
      "precision": (userId) => createOrJoinPrecisionDestination({ userId, wager: sourceStake }),
      "hex-duel": (userId) => createOrJoinHexDuelDestination({ userId, wager: sourceStake }),
      "chess": (userId) => createOrJoinChessDestination({ userId, betAmount: sourceStake }),
      // Mini Golf is lobby-style: both paired seats land on the SAME waiting
      // lobby, and it plays for coins like every other ranked duel, so the
      // queue's stake is what the pair is matched at (both seats are escrowed
      // when the second one joins).
      "mini-golf": (userId) => createOrJoinMiniGolfMatch({ userId, stake: sourceStake }),
      // Speed Typing is identical in shape — one shared waiting lobby, both
      // seats escrowed at the queue's stake when the second one joins.
      "speed-typing": (userId) =>
        createOrJoinSpeedTypingMatch({ userId, stake: sourceStake }),
      // Tic-Tac-Toe Duel is lobby-style in exactly the same way — its
      // `createOrJoin` returns the SAME waiting-lobby id for both paired seats —
      // and it plays for coins like every other ranked duel, so the queue's
      // stake is what the pair is matched at (both seats are escrowed when the
      // second one joins).
      "tic-tac-toe": (userId) =>
        createOrJoinTicTacToeMatch({ userId, stakeAmount: sourceStake }),
      // Barricade is lobby-style on the same terms: its `createOrJoin` seats
      // the first caller in a waiting lobby and hands the second caller THAT
      // SAME lobby, so both paired players land on one match id — escrowed at
      // the queue's stake the moment the second seat fills.
      "barricade": (userId) => createOrJoinBarricadeMatch({ userId, stake: sourceStake }),
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
                    ? await createOrJoinTowerArenaDestination({ userId: pair.partner.userId, wager: sourceStake })
                  : pair.candidate.gameKey === "pool-masters"
                    ? await createOrJoinPoolDestination({ userId: pair.partner.userId, wager: sourceStake })
                    : pair.candidate.gameKey === "precision"
                      ? createOrJoinPrecisionDestination({ userId: pair.partner.userId, wager: sourceStake })
                      : pair.candidate.gameKey === "hex-duel"
                        ? createOrJoinHexDuelDestination({ userId: pair.partner.userId, wager: sourceStake })
                        : pair.candidate.gameKey === "chess"
                          ? createOrJoinChessDestination({ userId: pair.partner.userId, betAmount: sourceStake })
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
