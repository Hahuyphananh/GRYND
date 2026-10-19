import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
import { chessGames, chessMoves, users } from "../../../../db/schema";
import { CHESS_AI_PLAYER_ID, chessSeatDisplayName } from "../../../../lib/chessAiSeat";
import { applyRatingResult } from "../../../../lib/rating";
import { applyTrophyResult } from "../../../../lib/trophyStore";
import { markDailyRewardWin } from "../../../../lib/dailyRewardWin";
import { isPracticePaused } from "../../../../lib/practicePause";
import { payPvpPot } from "../../../../lib/tokens/pvpPot";

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

    // The conditional UPDATE is the settlement CLAIM (only the transaction that
    // flips the row out of `in_progress` settles), so it runs before any coin
    // moves. The winner is then paid out of the escrow both seats funded at
    // join, inside this same transaction as the result that earned it; the
    // ledger keys the move per match+seat, so a racing poll can never pay twice.
    await tx
      .update(chessGames)
      .set({
        status: "finished",
        winnerId: lockedWinnerId,
        result: "timeout",
        payout: "0.00",
        endedAt: new Date(),
      })
      .where(
        and(eq(chessGames.id, game.id), eq(chessGames.status, "in_progress")),
      );

    // A clock timeout is a server-decided win. It unlocks the daily reward
    // even in a practice game; the bot id has no `users` row, so a human
    // running out of time stamps nothing.
    if (lockedWinnerId && lockedWinnerId !== CHESS_AI_PLAYER_ID) {
      await markDailyRewardWin(tx, lockedWinnerId);
    }

    // The winner banks the pot. An AI game was never escrowed and pays nothing.
    const stake = Number(lockedGame.betAmount) || 0;
    if (!lockedGame.isAiGame && stake > 0) {
      const winnerPayout = await payPvpPot({
        tx,
        gameKey: "chess",
        matchId: game.id,
        winnerClerkId: lockedWinnerId,
        stake,
      });
      if (winnerPayout > 0) {
        await tx
          .update(chessGames)
          .set({ payout: winnerPayout.toFixed(2) })
          .where(eq(chessGames.id, game.id));
      }
    }

      // Competitive clock-timeout finish: chess vs AI is free play and never
      // earns Elo or trophies.
      if (!lockedGame.isAiGame && lockedWinnerId) {
        const loserClerkId =
          lockedGame.playerWhiteId === lockedWinnerId
            ? lockedGame.playerBlackId
            : lockedGame.playerWhiteId;

        // Per-game Elo — server-authoritative clock timeout (the winner was
        // resolved from the recomputed clocks above, never from the client).
        // AI games are free play and are excluded.
        if (loserClerkId) {
          await applyRatingResult({
            tx,
            gameKey: "chess",
            matchId: String(game.id),
            winnerClerkId: lockedWinnerId,
            loserClerkId,
          }).catch(() => {});
          // Per-game trophies — the same authoritative timeout result.
          await applyTrophyResult({
            tx,
            gameKey: "chess",
            matchId: String(game.id),
            winnerClerkId: lockedWinnerId,
            loserClerkId,
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
    // Readable by a guest playing their own practice game (`canAccess` below is
    // the authorisation — a guest is only ever in its own alias set).
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const userId = gate.playerId;
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

    // A paused free-play match must not settle a clock timeout while nobody is
    // at the board. The resume shifts `started_at`/move timestamps forward, so
    // the frozen clock returns exactly where it stopped.
    const paused = game.isAiGame
      ? await isPracticePaused("chess", gameId)
      : false;

    let clocks = computeClocks(game, moves);
    if (!paused) game = await settleTimeoutIfNeeded(game, clocks);
    clocks = computeClocks(game, moves);    const lastMove = moves[moves.length - 1] || null;
    const [whiteName, blackName] = await Promise.all([
      resolveDisplayName(game.playerWhiteId),
      resolveDisplayName(game.playerBlackId),
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
        blackPlayerId: game.playerBlackId,
        // A VS-AI game now puts the bot in whichever seat the human is not in,
        // so the bot's label can no longer be hardcoded onto the black seat:
        // these resolve the sentinel seat, an EMPTY seat on an AI row (a row
        // written before the seat model changed), and a genuinely unjoined PvP
        // seat apart, while a real username always wins.
        whitePlayerName: chessSeatDisplayName(game.playerWhiteId, whiteName, {
          isAiGame: game.isAiGame,
          emptyLabel: "White",
        }),
        blackPlayerName: chessSeatDisplayName(game.playerBlackId, blackName, {
          isAiGame: game.isAiGame,
          emptyLabel: "Waiting...",
        }),
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
