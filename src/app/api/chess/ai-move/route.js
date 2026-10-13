// src/app/api/chess/ai-move/route.js
//
// Advance a Chess VS-AI game by one AI move.
//
// WHO CALLS THIS, AND WHEN
// ------------------------
// The AI board, right after the human's move has been ACCEPTED AND PERSISTED by
// the existing `/api/chess/move` route (and on load, when the human plays Black
// and the bot therefore has the first move). The body is `{ gameId }` and
// nothing else is read — no FEN, no move, no difficulty, no player id, no turn
// indicator. Everything that decides the answer comes from the database:
//
//   1. the caller must hold a seat of the game (resolved from the row, aliases
//      included, exactly as `/api/chess/move` does),
//   2. the game must be a VS-AI game that is still in progress,
//   3. the position is rebuilt from the PERSISTED history,
//   4. it must be the AI's turn in that position,
//   5. the strength comes from the row's `ai_difficulty` (a legacy NULL plays at
//      the documented default, never at something the client asked for),
//   6. the move comes from `chessGameplayEngine` — the Stage 1 server-side
//      chooser — and is re-validated with chess.js before it is stored.
//
// The write is a single transaction that re-reads the row `FOR UPDATE` and
// re-checks all of the above before appending, so two concurrent requests (a
// double-click, a retry, two tabs) can only ever produce ONE move row, and a
// retry after success is refused instead of appended twice. The terminal state
// is written in that same transaction, so a mating AI move and the game's finish
// can never come apart.
//
// This route does NOT touch PvP: `isAiGame` is checked before anything else, and
// nothing here can move, finish or rate a two-player game. It awards no rating,
// no trophies and no leaderboard counters — a VS-AI game is free play.
//
// The behaviour lives in src/lib/chessAiTurn.ts (`advanceAiTurn`), where it is
// tested against an injected store and engine; this file owns the session, the
// database handles and the HTTP shape.

import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { chessGames, chessMoves, users } from "../../../../db/schema";
import {
  advanceAiTurn,
  parseAiTurnRequest,
} from "../../../../lib/chessAiTurn";

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

/** The exact columns the turn logic reads — never a wider row. */
const GAME_COLUMNS = {
  id: chessGames.id,
  playerWhiteId: chessGames.playerWhiteId,
  playerBlackId: chessGames.playerBlackId,
  status: chessGames.status,
  isAiGame: chessGames.isAiGame,
  aiDifficulty: chessGames.aiDifficulty,
};

const MOVE_COLUMNS = {
  id: chessMoves.id,
  playedBy: chessMoves.playedBy,
  moveUci: chessMoves.moveUci,
  moveSan: chessMoves.moveSan,
  fenAfter: chessMoves.fenAfter,
};

export async function POST(req) {
  try {
    // A guest may play their own practice game: seat ownership inside the turn
    // logic is the authorization, and an AI game never awards rating or
    // trophies.
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // `gameId` is the ONLY field read from the request, and it must be a uuid.
    const parsed = parseAiTurnRequest(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { gameId } = parsed;

    const userAliases = await getUserAliases(userId);

    const result = await advanceAiTurn(
      { gameId, humanMatches: (id) => userAliases.has(id) },
      { reader: gameReader(), store: turnStore(gameId) },
    );

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          reason: result.reason,
          // The authoritative snapshot travels with a refusal so a client that
          // raced, retried or reloaded can resync instead of guessing.
          ...(result.state ? { state: result.state } : {}),
        },
        { status: result.status },
      );
    }

    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    console.error("chess ai-move error", {
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

/** The plain reads the turn logic is assessed against. */
function gameReader() {
  return {
    loadGame: async (gameId) => {
      const [row] = await db
        .select(GAME_COLUMNS)
        .from(chessGames)
        .where(eq(chessGames.id, gameId))
        .limit(1);
      return row ?? null;
    },
    loadMoves: async (gameId) =>
      db
        .select(MOVE_COLUMNS)
        .from(chessMoves)
        .where(eq(chessMoves.gameId, gameId))
        .orderBy(asc(chessMoves.id)),
  };
}

/**
 * The transactional seam `claimAiMove` runs inside.
 *
 * `lockGame` is `SELECT … FOR UPDATE`: within this transaction the game row is
 * held, which is what makes the re-check and the append atomic against a
 * concurrent request.
 */
function turnStore(gameId) {
  return {
    run: (fn) =>
      db.transaction(async (tx) =>
        fn({
          lockGame: async () => {
            const [row] = await tx
              .select(GAME_COLUMNS)
              .from(chessGames)
              .where(eq(chessGames.id, gameId))
              .for("update")
              .limit(1);
            return row ?? null;
          },
          loadMoves: () =>
            tx
              .select(MOVE_COLUMNS)
              .from(chessMoves)
              .where(eq(chessMoves.gameId, gameId))
              .orderBy(asc(chessMoves.id)),
          appendMove: async (move) => {
            await tx.insert(chessMoves).values({ gameId, ...move });
          },
          finishGame: async ({ winnerId, result }) => {
            // Stakes are retired: no pot, no rake, no payout to move.
            await tx
              .update(chessGames)
              .set({
                status: "finished",
                winnerId,
                result,
                payout: "0",
                endedAt: new Date(),
              })
              .where(
                and(
                  eq(chessGames.id, gameId),
                  eq(chessGames.status, "in_progress"),
                ),
              );
          },
        }),
      ),
  };
}
