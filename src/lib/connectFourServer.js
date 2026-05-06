import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { connectFourGames, users } from "../db/schema";
import { applyLeaderboardCounters } from "./leaderboardCounters";

const HOUSE_EDGE_MULTIPLIER = 1.9;
const DEFAULT_MOVE_TIME_SECONDS = 60;
const REPLAY_DECISION_SECONDS = 20;

export async function getUserAliases(clerkId) {
  const aliases = new Set([String(clerkId)]);
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  if (row?.id) aliases.add(String(row.id));
  return aliases;
}

export async function resolveNameByClerkId(clerkId) {
  if (!clerkId) return null;
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return row?.name || null;
}

export function getPlayerRole(game, userAliases) {
  if (userAliases.has(String(game.hostClerkId))) return "host";
  if (game.guestClerkId && userAliases.has(String(game.guestClerkId))) return "guest";
  return null;
}

export async function settleConnectFourGame(gameId, winnerClerkId, result) {
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(connectFourGames)
      .where(eq(connectFourGames.id, gameId))
      .for("update");

    if (!locked || locked.status === "finished" || locked.status === "cancelled") return;

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
        .update(connectFourGames)
        .set({
          status: "finished",
          result,
          winnerClerkId: null,
          payout: "0",
          endedAt: new Date(),
          moveDeadlineAt: null,
          replayDeadlineAt: new Date(Date.now() + REPLAY_DECISION_SECONDS * 1000),
          hostReplayDecision: null,
          guestReplayDecision: null,
          nextGameId: null,
        })
        .where(eq(connectFourGames.id, gameId));

      return;
    }

    if (!winnerClerkId) return;

    const payout = Number((bet * HOUSE_EDGE_MULTIPLIER).toFixed(2));

    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout}` })
      .where(eq(users.clerkId, winnerClerkId));

    await applyLeaderboardCounters({ clerkId: winnerClerkId, game: "connect-four", betAmount: bet, payout, isPvpWin: true });

    await tx
      .update(connectFourGames)
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
      .where(eq(connectFourGames.id, gameId));
  });
}

export async function settleTimeoutIfNeeded(game) {
  if (game.status !== "in_progress" || !game.moveDeadlineAt) return game;

  const deadline = new Date(game.moveDeadlineAt).getTime();
  if (Date.now() <= deadline) return game;

  const winnerClerkId = game.currentTurn === "host" ? game.guestClerkId : game.hostClerkId;
  if (!winnerClerkId) return game;

  await settleConnectFourGame(game.id, winnerClerkId, "timeout");

  const [updated] = await db
    .select()
    .from(connectFourGames)
    .where(eq(connectFourGames.id, game.id))
    .limit(1);

  return updated || game;
}

export function computeMoveTimeRemaining(deadline) {
  if (!deadline) return 0;
  const endsAt = new Date(deadline).getTime();
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
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
  const fallback = Array.from({ length: 6 }, () => Array.from({ length: 7 }, () => 0));
  if (!Array.isArray(board) || board.length !== 6) return fallback;

  for (const row of board) {
    if (!Array.isArray(row) || row.length !== 7) return fallback;
    if (!row.every((cell) => cell === 0 || cell === 1 || cell === 2)) return fallback;
  }

  return board;
}
