import { Chess } from "chess.js";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
import { chessGames, chessMoves, users } from "../../../../db/schema";
import { toStoredUci } from "../../../../lib/chessMoveUci";
import { applyRatingResult } from "../../../../lib/rating";
import { applyTrophyResult } from "../../../../lib/trophyStore";
import { payPvpPot } from "../../../../lib/tokens/pvpPot";
import { refundMatchWagers } from "../../../../lib/tokens/wager";

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

export async function POST(req) {
  try {
    // A guest may move in their own practice game: `isWhitePlayer` /
    // `isBlackPlayer` below are the authorisation, resolved from the game's own
    // seat columns, and the AI branch never awards rating or trophies.
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { gameId, from, to, promotion = "q" } = await req.json();
    const normalizedGameId = String(gameId ?? "").trim();

    if (!UUID_RE.test(normalizedGameId) || !from || !to) {
      return NextResponse.json(
        { error: "Invalid move payload" },
        { status: 400 },
      );
    }

    const userAliases = await getUserAliases(userId);

    // Lock the game row to prevent concurrent moves
    const [game] = await db
      .select()
      .from(chessGames)
      .where(eq(chessGames.id, normalizedGameId))
      .for("update")
      .limit(1);

    if (!game)
      return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const isWhitePlayer = userAliases.has(String(game.playerWhiteId));
    const isBlackPlayer = userAliases.has(String(game.playerBlackId));
    if (!isWhitePlayer && !isBlackPlayer) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    if (game.status !== "in_progress") {
      return NextResponse.json(
        { error: "Game is not active" },
        { status: 400 },
      );
    }

    const moves = await db
      .select()
      .from(chessMoves)
      .where(eq(chessMoves.gameId, normalizedGameId))
      .orderBy(asc(chessMoves.id));

    const lastFen =
      moves.length > 0 ? moves[moves.length - 1].fenAfter : undefined;
    const chess = new Chess(lastFen);

    const isWhite = isWhitePlayer;
    const expectedTurn = isWhite ? "w" : "b";
    if (chess.turn() !== expectedTurn) {
      return NextResponse.json({ error: "Not your turn" }, { status: 409 });
    }

    const playedMove = chess.move({ from, to, promotion });
    if (!playedMove) {
      return NextResponse.json({ error: "Illegal move" }, { status: 400 });
    }

    // The stored UCI describes the move chess.js just validated and applied —
    // never the request's `from`/`to`/`promotion`. `promotion` above defaults to
    // "q" so an omitted field still promotes, which means interpolating it here
    // used to append a queen to EVERY move ("e2e4q") and made the evaluator's
    // comparison against Stockfish's `bestmove` impossible. `toStoredUci` emits
    // the suffix only for a real promotion, with the piece actually played.
    const storedUci = toStoredUci(playedMove);
    if (!storedUci) {
      return NextResponse.json({ error: "Illegal move" }, { status: 400 });
    }

    await db.insert(chessMoves).values({
      gameId: normalizedGameId,
      playedBy: userId,
      moveUci: storedUci,
      moveSan: playedMove.san,
      fenAfter: chess.fen(),
    });

    if (chess.isGameOver()) {
      const isDraw =
        chess.isDraw() ||
        chess.isStalemate() ||
        chess.isInsufficientMaterial() ||
        chess.isThreefoldRepetition();
      const winnerId = isDraw ? null : userId;

      await db.transaction(async (tx) => {
        const [lockedGame] = await tx
          .select()
          .from(chessGames)
          .where(eq(chessGames.id, normalizedGameId))
          .for("update");
        if (!lockedGame || lockedGame.status === "finished") return;

        await tx
          .update(chessGames)
          .set({
            status: "finished",
            winnerId,
            result: isDraw ? "draw" : "win",
            endedAt: new Date(),
          })
          .where(eq(chessGames.id, normalizedGameId));

        // The winner banks the pot out of the escrow both seats funded at join.
        // It runs inside the transaction that claimed the terminal write (the
        // row was re-read `FOR UPDATE` and was not already `finished`), so the
        // coins commit with the checkmate that earned them. A DRAW pays nobody
        // and leaves the stakes escrowed for the match's void refund; an AI
        // game was never escrowed and pays nothing.
        const stake = Number(lockedGame.betAmount) || 0;
        if (!isDraw && !lockedGame.isAiGame && winnerId && stake > 0) {
          const payout = await payPvpPot({
            tx,
            gameKey: "chess",
            matchId: normalizedGameId,
            winnerClerkId: winnerId,
            stake,
          });
          if (payout > 0) {
            await tx
              .update(chessGames)
              .set({ payout: payout.toFixed(2) })
              .where(eq(chessGames.id, normalizedGameId));
          }
        } else if (isDraw && !lockedGame.isAiGame && stake > 0) {
          // A DRAW is VOID: nobody won, so both stakes go back rather than
          // being stranded in escrow for a match that will never settle. The
          // ledger refuses this if the match's seats were already paid, so a
          // draw can never hand a winner their stake back on top of a prize.
          await refundMatchWagers({
            clerkIds: [lockedGame.playerWhiteId, lockedGame.playerBlackId],
            stake,
            matchId: normalizedGameId,
            gameKey: "chess",
            tx,
          });
        }

        // Competitive PvP finish. Draws and AI matches never move Elo or
        // trophies (chess vs AI is free play).
        if (!isDraw && !lockedGame.isAiGame && winnerId) {
          const loserClerkId =
            lockedGame.playerWhiteId === winnerId
              ? lockedGame.playerBlackId
              : lockedGame.playerWhiteId;

          // Per-game Elo — the game row only reaches a terminal state once and
          // the rating_events journal makes a replay a no-op. The winner comes
          // from the server-side chess.js result, never the client.
          if (loserClerkId) {
            await applyRatingResult({
              tx,
              gameKey: "chess",
              matchId: String(normalizedGameId),
              winnerClerkId: winnerId,
              loserClerkId,
            }).catch(() => {});
            // Per-game trophies — the same authoritative win (+30 / −30).
            await applyTrophyResult({
              tx,
              gameKey: "chess",
              matchId: String(normalizedGameId),
              winnerClerkId: winnerId,
              loserClerkId,
            }).catch(() => {});
          }
        }
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        fen: chess.fen(),
        move: playedMove.san,
        isGameOver: chess.isGameOver(),
      },
    });
  } catch (error) {
    console.error("chess move error", {
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
