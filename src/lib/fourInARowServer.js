import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { fourInARowGames, users } from "../db/schema";
import { applyLeaderboardCounters } from "./leaderboardCounters";
import { applyPrestigeResult } from "./prestige";
import { applyRatingResult } from "./rating";

const HOUSE_EDGE_MULTIPLIER = 1.9;
const DEFAULT_MOVE_TIME_SECONDS = 60;
const REPLAY_DECISION_SECONDS = 20;

// Brief "Match found!" takeover window between the opponent joining and
// the first move (mirrors blackjack-pvp's READY_WINDOW_MS). During it the
// game sits in status "ready" and both pages show the takeover countdown;
// advanceReadyIfNeeded (called from the game-state route) flips it to
// in_progress once the deadline passes.
export const READY_WINDOW_MS = 3000;

export async function getUserAliases(clerkId) {
  const aliases = new Set([String(clerkId)]);
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  if (row?.id) aliases.add(String(row.id));
  return aliases;
}

export async function resolveNameByClerkId(clerkId) {
  if (!clerkId) return null;
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  return row?.name || null;
}

export function getPlayerRole(game, userAliases) {
  if (userAliases.has(String(game.hostClerkId))) return "host";
  if (game.guestClerkId && userAliases.has(String(game.guestClerkId)))
    return "guest";
  return null;
}

export async function settleFourInARowGame(gameId, winnerClerkId, result) {
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(fourInARowGames)
      .where(eq(fourInARowGames.id, gameId))
      .for("update");

    if (
      !locked ||
      locked.status === "finished" ||
      locked.status === "cancelled"
    )
      return;

    const bet = Number(locked.betAmount);

    if (result === "draw") {
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
        .update(fourInARowGames)
        .set({
          status: "finished",
          result,
          winnerClerkId: null,
          payout: "0",
          endedAt: new Date(),
          moveDeadlineAt: null,
          replayDeadlineAt: new Date(
            Date.now() + REPLAY_DECISION_SECONDS * 1000,
          ),
          hostReplayDecision: null,
          guestReplayDecision: null,
          nextGameId: null,
        })
        .where(eq(fourInARowGames.id, gameId));

      // Per-game Elo — a draw moves BOTH ratings by K × (0.5 − expected),
      // so a stalemate still separates the players over time. Both seats are
      // known here and the journal keeps the event idempotent.
      if (locked.hostClerkId && locked.guestClerkId) {
        await applyRatingResult({
          tx,
          gameKey: "four-in-a-row",
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

    await applyLeaderboardCounters({
      clerkId: winnerClerkId,
      game: "four-in-a-row",
      betAmount: bet,
      payout,
      isPvpWin: true,
    });

    const prestigeLoserId =
      locked.hostClerkId === winnerClerkId
        ? locked.guestClerkId
        : locked.hostClerkId;

    // Also record the loser's loss + stake so losses / win_rate / wagered
    // stay in sync with the winner's win (matches chess / precision).
    if (prestigeLoserId) {
      await applyLeaderboardCounters({
        clerkId: prestigeLoserId,
        game: "four-in-a-row",
        betAmount: bet,
        payout: 0,
      });
    }

    // Permanent Prestige — competitive PvP finish (draws refund above and
    // four-in-a-row has no AI mode, so every paid finish counts).
    await applyPrestigeResult({
      tx,
      clerkId: winnerClerkId,
      outcome: "win",
      source: "four-in-a-row",
      sourceId: String(gameId),
    }).catch(() => {});
    if (prestigeLoserId) {
      await applyPrestigeResult({
        tx,
        clerkId: prestigeLoserId,
        outcome: "loss",
        source: "four-in-a-row",
        sourceId: String(gameId),
      }).catch(() => {});
    }

    // Per-game Elo — same guarded single-execution path as Prestige above, so
    // only ONE settlement of this match can ever move a rating.
    if (prestigeLoserId) {
      await applyRatingResult({
        tx,
        gameKey: "four-in-a-row",
        matchId: String(gameId),
        winnerClerkId,
        loserClerkId: prestigeLoserId,
      }).catch(() => {});
    }

    await tx
      .update(fourInARowGames)
      .set({
        status: "finished",
        result,
        winnerClerkId,
        payout: payout.toFixed(2),
        endedAt: new Date(),
        moveDeadlineAt: null,
        replayDeadlineAt: new Date(Date.now() + REPLAY_DECISION_SECONDS * 1000),
        hostReplayDecision: null,
        guestReplayDecision: null,
        nextGameId: null,
      })
      .where(eq(fourInARowGames.id, gameId));
  });
}

export async function settleTimeoutIfNeeded(game) {
  if (game.status !== "in_progress" || !game.moveDeadlineAt) return game;

  const deadline = new Date(game.moveDeadlineAt).getTime();
  if (Date.now() <= deadline) return game;

  const winnerClerkId =
    game.currentTurn === "host" ? game.guestClerkId : game.hostClerkId;
  if (!winnerClerkId) return game;

  await settleFourInARowGame(game.id, winnerClerkId, "timeout");

  const [updated] = await db
    .select()
    .from(fourInARowGames)
    .where(eq(fourInARowGames.id, game.id))
    .limit(1);

  return updated || game;
}

export function computeMoveTimeRemaining(deadline) {
  if (!deadline) return 0;
  const endsAt = new Date(deadline).getTime();
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
      .from(fourInARowGames)
      .where(eq(fourInARowGames.id, game.id))
      .for("update");
    if (!locked || locked.status !== "ready") return;
    const deadline = locked.readyDeadlineAt
      ? new Date(locked.readyDeadlineAt).getTime()
      : 0;
    if (!deadline || deadline > Date.now()) return;

    await tx
      .update(fourInARowGames)
      .set({
        status: "in_progress",
        currentTurn: "host",
        startedAt: new Date(),
        moveDeadlineAt: nextMoveDeadline(getGameMoveSeconds(locked)),
        readyDeadlineAt: null,
      })
      .where(eq(fourInARowGames.id, game.id));
  });

  const [updated] = await db
    .select()
    .from(fourInARowGames)
    .where(eq(fourInARowGames.id, game.id))
    .limit(1);
  return updated || game;
}

export function getGameMoveSeconds(game) {
  const configured = Number(game?.timerSeconds);
  if (!Number.isFinite(configured)) return DEFAULT_MOVE_TIME_SECONDS;
  return Math.min(120, Math.max(10, Math.floor(configured)));
}

export function nextMoveDeadline(seconds = DEFAULT_MOVE_TIME_SECONDS) {
  return new Date(Date.now() + seconds * 1000);
}

export function ensureBoard(board) {
  const fallback = Array.from({ length: 6 }, () =>
    Array.from({ length: 7 }, () => 0),
  );
  if (!Array.isArray(board) || board.length !== 6) return fallback;

  for (const row of board) {
    if (!Array.isArray(row) || row.length !== 7) return fallback;
    if (!row.every((cell) => cell === 0 || cell === 1 || cell === 2))
      return fallback;
  }

  return board;
}
