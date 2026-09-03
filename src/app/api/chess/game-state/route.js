import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
import { chessGames, chessMoves, users } from "../../../../db/schema";import {
  applyPrestigeResult,
  resolvePrestigeBadge,
} from "../../../../lib/prestige";


const HOUSE_EDGE_PERCENT = 10;

async function getUserAliases(clerkId) {
  const aliases = new Set([String(clerkId)]);
  const [userRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);
  if (userRow?.id) aliases.add(String(userRow.id));
  return aliases;
}

async function resolveDisplayName(playerId) {
  if (!playerId) return null;

  const normalizedId = String(playerId);
  const [byClerk] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.clerkId, normalizedId))
    .limit(1);

  if (byClerk?.name) return byClerk.name;

  const numericId = Number(normalizedId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return null;
  }

  const [byNumericId] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, numericId))
    .limit(1);  return byNumericId?.name ?? null;
}

async function resolvePrestigeBadgeForPlayer(playerId) {
  if (!playerId) return null;

  const normalizedId = String(playerId);
  const [byClerk] = await db
    .select({
      xp: users.xp,
      prestigeLevel: users.prestigeLevel,
      showPrestigeBadge: users.showPrestigeBadge,
    })
    .from(users)
    .where(eq(users.clerkId, normalizedId))
    .limit(1);

  if (byClerk) {
    return resolvePrestigeBadge({
      xp: byClerk.xp,
      prestigeLevel: byClerk.prestigeLevel,
      showPrestigeBadge: byClerk.showPrestigeBadge,
    });
  }

  const numericId = Number(normalizedId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return null;
  }

  const [byNumericId] = await db
    .select({
      xp: users.xp,
      prestigeLevel: users.prestigeLevel,
      showPrestigeBadge: users.showPrestigeBadge,
    })
    .from(users)
    .where(eq(users.id, numericId))
    .limit(1);

  return byNumericId
    ? resolvePrestigeBadge({
        xp: byNumericId.xp,
        prestigeLevel: byNumericId.prestigeLevel,
        showPrestigeBadge: byNumericId.showPrestigeBadge,
      })
    : null;
}

function computeClocks(game, moves) {
  const initial = Number(game.initialTimeSeconds || 300);
  let white = initial;
  let black = initial;

  let activeColor = "white";
  let turnStart = game.startedAt
    ? new Date(game.startedAt).getTime()
    : Date.now();

  for (const move of moves) {
    const moveAt = new Date(move.createdAt).getTime();
    const elapsed = Math.max(0, Math.floor((moveAt - turnStart) / 1000));

    if (activeColor === "white") white = Math.max(0, white - elapsed);
    else black = Math.max(0, black - elapsed);

    activeColor = activeColor === "white" ? "black" : "white";
    turnStart = moveAt;
  }

  if (game.status === "in_progress") {
    const now = Date.now();
    const elapsed = Math.max(0, Math.floor((now - turnStart) / 1000));
    if (activeColor === "white") white = Math.max(0, white - elapsed);
    else black = Math.max(0, black - elapsed);
  }

  return {
    whiteTimeRemaining: white,
    blackTimeRemaining: black,
    activeTurn: activeColor,
  };
}

async function settleTimeoutIfNeeded(game, clocks) {
  if (game.status !== "in_progress") return game;
  if (clocks.whiteTimeRemaining > 0 && clocks.blackTimeRemaining > 0)
    return game;

  const winnerId =
    clocks.whiteTimeRemaining <= 0 ? game.playerBlackId : game.playerWhiteId;
  if (!winnerId) return game;

  let updatedGame = game;

  await db.transaction(async (tx) => {
    // Lock and re-read in a single step to avoid TOCTOU
    const [lockedGame] = await tx
      .select()
      .from(chessGames)
      .where(eq(chessGames.id, game.id))
      .for("update");
    if (!lockedGame || lockedGame.status !== "in_progress") {
      updatedGame = lockedGame || game;
      return;
    }

    // Recompute clocks inside the lock to ensure accuracy
    const moves = await tx
      .select()
      .from(chessMoves)
      .where(eq(chessMoves.gameId, game.id))
      .orderBy(asc(chessMoves.id));

    const lockedClocks = computeClocks(lockedGame, moves);
    if (lockedClocks.whiteTimeRemaining > 0 && lockedClocks.blackTimeRemaining > 0) {
      updatedGame = lockedGame;
      return;
    }

    const lockedWinnerId =
      lockedClocks.whiteTimeRemaining <= 0 ? lockedGame.playerBlackId : lockedGame.playerWhiteId;
    if (!lockedWinnerId) {
      updatedGame = lockedGame;
      return;
    }

    const pot = Number(lockedGame.betAmount) * 2;
    const houseFee = Number(((pot * HOUSE_EDGE_PERCENT) / 100).toFixed(2));
    const winnerPayout = Number((pot - houseFee).toFixed(2));

    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${winnerPayout}` })
      .where(eq(users.clerkId, lockedWinnerId));

    await tx
      .update(chessGames)
      .set({
        status: "finished",
        winnerId: lockedWinnerId,
        result: "timeout",
        payout: winnerPayout.toString(),
      })
      .where(
        and(eq(chessGames.id, game.id), eq(chessGames.status, "in_progress")),
      );

      // Permanent Prestige — competitive clock-timeout finish (chess vs AI
      // is free play and never earns Prestige).
      if (!lockedGame.isAiGame && lockedWinnerId) {
        const prestigeLoserId =
          lockedGame.playerWhiteId === lockedWinnerId
            ? lockedGame.playerBlackId
            : lockedGame.playerWhiteId;
        await applyPrestigeResult({
          tx,
          clerkId: lockedWinnerId,
          outcome: "win",
          source: "chess",
          sourceId: String(game.id),
        }).catch(() => {});
        if (prestigeLoserId) {
          await applyPrestigeResult({
            tx,
            clerkId: prestigeLoserId,
            outcome: "loss",
            source: "chess",
            sourceId: String(game.id),
          }).catch(() => {});
        }
      }

    // Fetch the updated game state
    const [after] = await tx
      .select()
      .from(chessGames)
      .where(eq(chessGames.id, game.id))
      .limit(1);
    updatedGame = after || lockedGame;
  });

  return updatedGame;
}

export async function GET(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const gameId = String(searchParams.get("gameId") || "").trim();

    if (!UUID_RE.test(gameId)) {
      return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
    }

    const userAliases = await getUserAliases(userId);

    let [game] = await db
      .select()
      .from(chessGames)
      .where(eq(chessGames.id, gameId))
      .limit(1);

    if (!game)
      return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const canAccess =
      userAliases.has(String(game.playerWhiteId)) ||
      userAliases.has(String(game.playerBlackId));
    const viewerRole = canAccess
      ? userAliases.has(String(game.playerWhiteId))
        ? "white"
        : "black"
      : "spectator";

    const moves = await db
      .select()
      .from(chessMoves)
      .where(eq(chessMoves.gameId, gameId))
      .orderBy(asc(chessMoves.id));

    let clocks = computeClocks(game, moves);
    game = await settleTimeoutIfNeeded(game, clocks);
    clocks = computeClocks(game, moves);    const lastMove = moves[moves.length - 1] || null;
    const [whiteName, blackName, whiteBadge, blackBadge] = await Promise.all([
      resolveDisplayName(game.playerWhiteId),
      resolveDisplayName(game.playerBlackId),
      resolvePrestigeBadgeForPlayer(game.playerWhiteId),
      resolvePrestigeBadgeForPlayer(game.playerBlackId),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        gameId: game.id,
        status: game.status,
        betAmount: game.betAmount,
        timerMode: game.timerMode,
        initialTimeSeconds: game.initialTimeSeconds,
        whiteTimeRemaining: clocks.whiteTimeRemaining,
        blackTimeRemaining: clocks.blackTimeRemaining,
        activeTurn: clocks.activeTurn,
        whitePlayerId: game.playerWhiteId,
        blackPlayerId: game.playerBlackId,        whitePlayerName: whiteName || "White",
        blackPlayerName:
          blackName || (game.isAiGame ? "Chess AI" : "Waiting..."),
        whitePlayerPrestigeBadge: whiteBadge,
        blackPlayerPrestigeBadge: blackBadge,
        viewerRole,
        winnerId: game.winnerId,
        result: game.result,
        fen: lastMove?.fenAfter ?? null,
        moves: moves.map((m) => ({
          id: m.id,
          playedBy: m.playedBy,
          moveUci: m.moveUci,
          moveSan: m.moveSan,
          fenAfter: m.fenAfter,
          createdAt: m.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error("chess game-state error", {
      message: error?.message,
      stack: error?.stack,
      cause: error?.cause,
    });
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
