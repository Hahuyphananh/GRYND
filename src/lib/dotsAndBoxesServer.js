import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { dotsAndBoxesGames, users } from "../db/schema";
import { applyLeaderboardCounters } from "./leaderboardCounters";
import {
  TURN_SECONDS as DEFAULT_MOVE_TIME_SECONDS,
  determineResult,
  drawEdge as engineDrawEdge,
  ensureState,
  getLegalEdges,
  isGameOver,
  pickRandomLegalEdge,
} from "./dotsAndBoxesEngine";

const HOUSE_EDGE_MULTIPLIER = 1.9;

export function getGameMoveSeconds(game) {
  const configured = Number(game?.timerSeconds);
  if (!Number.isFinite(configured)) return DEFAULT_MOVE_TIME_SECONDS;
  return Math.min(120, Math.max(5, Math.floor(configured)));
}

export function nextMoveDeadline(seconds = getGameMoveSeconds({})) {
  return new Date(Date.now() + seconds * 1000);
}

export function computeMoveTimeRemaining(deadline) {
  if (!deadline) return 0;
  const endsAt = new Date(deadline).getTime();
  if (!Number.isFinite(endsAt)) return 0;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

export async function settleDotsAndBoxesGame(gameId, winnerClerkId, result) {
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(dotsAndBoxesGames)
      .where(eq(dotsAndBoxesGames.id, gameId))
      .for("update");

    if (!locked) return;

    // ── Idempotency: don't double-settle. The `payout` field starts as
    //    null and is set on first settlement. Any non-null payout (>=0)
    //    means we've already processed this game. ──
    if (locked.payout !== null && locked.payout !== undefined) return;

    const bet = Number(locked.betAmount);

    if (result === "draw") {
      // Refund both players' wagers
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${locked.betAmount}` })
        .where(eq(users.clerkId, locked.hostClerkId));
      if (locked.guestClerkId) {
        await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${locked.betAmount}` })
          .where(eq(users.clerkId, locked.guestClerkId));
      }

      await tx
        .update(dotsAndBoxesGames)
        .set({
          status: "finished",
          result: "draw",
          winnerClerkId: null,
          payout: "0",
          endedAt: new Date(),
          moveDeadlineAt: null,
        })
        .where(eq(dotsAndBoxesGames.id, gameId));

      return;
    }

    if (!winnerClerkId) return;

    const payout = Number((bet * HOUSE_EDGE_MULTIPLIER).toFixed(2));

    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout}` })
      .where(eq(users.clerkId, winnerClerkId));

    await applyLeaderboardCounters({
      clerkId: winnerClerkId,
      game: "dots-and-boxes",
      betAmount: bet,
      payout,
      isPvpWin: true,
    });

    await tx
      .update(dotsAndBoxesGames)
      .set({
        status: "finished",
        result,
        winnerClerkId,
        payout: payout.toFixed(2),
        endedAt: new Date(),
        moveDeadlineAt: null,
      })
      .where(eq(dotsAndBoxesGames.id, gameId));
  });
}

/**
 * Lazily auto-play a random legal edge for the current player when their
 * timer has expired. Only fires once per poll — repeated expiry is fine
 * because each invocation runs in a row-locked transaction.
 *
 * If the auto-play completes the game, settleDotsAndBoxesGame is called.
 *
 * Returns the freshly-fetched game row (locked + updated), or the input
 * row if no auto-play was needed.
 */
export async function settleAutoMoveIfNeeded(game) {
  if (!game || game.status !== "in_progress") return game;
  if (!game.moveDeadlineAt) return game;

  const deadline = new Date(game.moveDeadlineAt).getTime();
  if (!Number.isFinite(deadline) || Date.now() <= deadline) return game;

  let settleWinner = null;
  let settleResult = null;
  let isAutoGameOver = false;

  await db.transaction(async (tx) => {
    // Re-fetch with row lock to serialize concurrent auto-moves
    const [locked] = await tx
      .select()
      .from(dotsAndBoxesGames)
      .where(eq(dotsAndBoxesGames.id, game.id))
      .for("update");

    if (!locked || locked.status !== "in_progress") return;
    const lockedDeadline = locked.moveDeadlineAt
      ? new Date(locked.moveDeadlineAt).getTime()
      : 0;
    if (!lockedDeadline || Date.now() <= lockedDeadline) return;

    const state = ensureState(locked.gameState);

    const legal = getLegalEdges(state);
    if (legal.length === 0) {
      isAutoGameOver = true;
      settleWinner = null;
      settleResult = "draw";
      await tx
        .update(dotsAndBoxesGames)
        .set({ gameState: state })
        .where(eq(dotsAndBoxesGames.id, locked.id));
      return;
    }

    const randomEdge = pickRandomLegalEdge(state);
    if (!randomEdge) {
      isAutoGameOver = true;
      settleWinner = null;
      settleResult = "draw";
      await tx
        .update(dotsAndBoxesGames)
        .set({ gameState: state })
        .where(eq(dotsAndBoxesGames.id, locked.id));
      return;
    }

    const draw = engineDrawEdge(state, randomEdge, state.currentTurn);
    if (draw.error) {
      // Engine rejected the auto-move; re-extend the deadline so polls
      // don't keep retrying with the same stale expiry.
      await tx
        .update(dotsAndBoxesGames)
        .set({ moveDeadlineAt: new Date() })
        .where(eq(dotsAndBoxesGames.id, locked.id));
      return;
    }

    const newState = draw.state;
    isAutoGameOver = isGameOver(newState);

    await tx
      .update(dotsAndBoxesGames)
      .set({ gameState: newState })
      .where(eq(dotsAndBoxesGames.id, locked.id));

    if (isAutoGameOver) {
      const decision = determineResult(
        newState,
        locked.hostClerkId,
        locked.guestClerkId,
      );
      settleWinner = decision.winnerClerkId;
      settleResult = "timeout"; // server-driven auto-move finished the game
    } else {
      // Reset the deadline so the next player has a fresh 10s window.
      await tx
        .update(dotsAndBoxesGames)
        .set({ moveDeadlineAt: nextMoveDeadline(getGameMoveSeconds(locked)) })
        .where(eq(dotsAndBoxesGames.id, locked.id));
    }
  });

  // ── Settle in a separate transaction (avoids nested-tx issues) ──
  if (isAutoGameOver) {
    await settleDotsAndBoxesGame(
      game.id,
      settleWinner,
      settleResult || "draw",
    );
  }

  const [final] = await db
    .select()
    .from(dotsAndBoxesGames)
    .where(eq(dotsAndBoxesGames.id, game.id))
    .limit(1);

  return final || game;
}
