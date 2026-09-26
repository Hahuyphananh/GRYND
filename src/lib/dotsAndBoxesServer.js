import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { dotsAndBoxesGames, users } from "../db/schema";
import { applyLeaderboardCounters } from "./leaderboardCounters";
import { applyRatingResult } from "./rating";
import { applyTrophyResult } from "./trophyStore";
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
export const DOTS_AND_BOXES_AI_ID = "AI_BOT";

// Brief "Match found!" takeover window between the opponent joining and
// the first move (mirrors blackjack-pvp's READY_WINDOW_MS). During it the
// game sits in status "ready" and both pages show the takeover countdown;
// advanceReadyIfNeeded (called from the game-state route) flips it to
// in_progress once the deadline passes.
export const READY_WINDOW_MS = 3000;

export function isDotsAndBoxesAiGame(game) {
  return Boolean(game?.isAiGame) && game?.guestClerkId === DOTS_AND_BOXES_AI_ID;
}

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

/**
 * Auto-advance the brief ready window into the first move. Poll-driven
 * (the game-state route calls this on every fetch), row-locked and
 * idempotent: only the ready → in_progress transition ever happens, and
 * the first move deadline is set here so play starts immediately after
 * the countdown on both pages.
 */
export async function advanceReadyIfNeeded(game) {
  if (!game || game.status !== "ready" || !game.readyDeadlineAt) return game;
  if (new Date(game.readyDeadlineAt).getTime() > Date.now()) return game;

  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(dotsAndBoxesGames)
      .where(eq(dotsAndBoxesGames.id, game.id))
      .for("update");
    if (!locked || locked.status !== "ready") return;
    const deadline = locked.readyDeadlineAt
      ? new Date(locked.readyDeadlineAt).getTime()
      : 0;
    if (!deadline || deadline > Date.now()) return;

    await tx
      .update(dotsAndBoxesGames)
      .set({
        status: "in_progress",
        startedAt: new Date(),
        moveDeadlineAt: nextMoveDeadline(getGameMoveSeconds(locked)),
        readyDeadlineAt: null,
      })
      .where(eq(dotsAndBoxesGames.id, game.id));
  });

  const [updated] = await db
    .select()
    .from(dotsAndBoxesGames)
    .where(eq(dotsAndBoxesGames.id, game.id))
    .limit(1);
  return updated || game;
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

    if (locked.isAiGame) {
      await tx
        .update(dotsAndBoxesGames)
        .set({
          status: "finished",
          result,
          winnerClerkId: winnerClerkId || null,
          payout: "0",
          endedAt: new Date(),
          moveDeadlineAt: null,
        })
        .where(eq(dotsAndBoxesGames.id, gameId));
      return;
    }

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

      // Per-game Elo — a draw moves BOTH ratings by K × (0.5 − expected).
      // The row-lock + payout guard above and the rating_events journal keep
      // this to exactly one application per match.
      if (locked.hostClerkId && locked.guestClerkId) {
        await applyRatingResult({
          tx,
          gameKey: "dots-and-boxes",
          matchId: String(gameId),
          winnerClerkId: locked.hostClerkId,
          loserClerkId: locked.guestClerkId,
          result: "draw",
        }).catch(() => {});
      }

      return;
    }

    if (!winnerClerkId) return;

    const payout = Number((bet * HOUSE_EDGE_MULTIPLIER).toFixed(2));

    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout}` })
      .where(eq(users.clerkId, winnerClerkId));

    if (!locked.isAiGame) {
      await applyLeaderboardCounters({
        clerkId: winnerClerkId,
        game: "dots-and-boxes",
        betAmount: bet,
        payout,
        isPvpWin: true,
      });

      const loserClerkId =
        locked.hostClerkId === winnerClerkId
          ? locked.guestClerkId
          : locked.hostClerkId;

      // Also record the loser's loss + stake so losses / win_rate / wagered
      // stay in sync with the winner's win (matches chess / precision).
      if (loserClerkId) {
        await applyLeaderboardCounters({
          clerkId: loserClerkId,
          game: "dots-and-boxes",
          betAmount: bet,
          payout: 0,
        });
      }

      // Per-game Elo — guarded single-execution path: only ONE settlement of
      // this match can ever move a rating.
      if (loserClerkId) {
        await applyRatingResult({
          tx,
          gameKey: "dots-and-boxes",
          matchId: String(gameId),
          winnerClerkId,
          loserClerkId,
        }).catch(() => {});
        // Per-game trophies — the same authoritative win (+30 / −30).
        await applyTrophyResult({
          tx,
          gameKey: "dots-and-boxes",
          matchId: String(gameId),
          winnerClerkId,
          loserClerkId,
        }).catch(() => {});
      }
    }

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
  // Free vs-AI games are untimed — the human's turn never expires, so
  // no auto-move is ever forced for them (create-ai stamps no deadline).
  if (game.isAiGame) return game;

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
