// src/app/api/chess/create-ai-game/route.js
//
// Free practice vs the built-in engine: a signed-out visitor is issued a guest
// seat here (the only chess route that mints one). Chess vs AI is unrated — the
// game row is flagged `isAiGame`, so settlement skips ELO, trophies and
// counters. Online play (/api/chess/create-game, /join-game) keeps the age gate.
//
// WHAT THIS ROUTE DECIDES, AND WHAT IT DELEGATES
// ----------------------------------------------
// It owns exactly two things a request/session makes possible: resolving WHO is
// playing (the gate above — never a body field), and reading the body. Every
// other decision — which tier a body means, whether it is legal, which colour
// the human plays, which seat each player is written into — lives in
// src/lib/chessAiGameCreation.ts and src/lib/chessAiSeat.ts, where it is tested
// without a database.
//
// The seats are NEW as of this change. The row used to hold the human in White
// and `player_black_id = NULL`, and the board was decided by the browser: the
// lobby put `color=<white|black|random>` in the URL and the AI page rolled its
// own colour for `random`. So a player who chose Black was recorded as White and
// nothing on the row said where the bot sat. Now the human is written into the
// seat they chose and the bot (`CHESS_AI_PLAYER_ID`) into the other one, and the
// resolved colour is returned as `humanColor` so the board is drawn from the row
// instead of from client state. A `NULL` seat keeps meaning "unclaimed" for
// every other reader (available-games, join-game, the quick queue).
//
// Moving the AI's MOVE onto the server is NOT part of this change: nothing here
// generates, stores or authorises a move.

import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { db } from "../../../../db/client";
import { chessGames } from "../../../../db/schema";
import { NextResponse } from "next/server";
import {
  createChessAiGame,
  parseChessAiGameRequest,
} from "../../../../lib/chessAiGameCreation";

export async function POST(req) {
  try {
    const gate = await requirePracticePlayer({ create: true });
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // An absent or malformed body is not a 400. Its only meaningful content —
    // the tier and the colour — has a documented default, and a cached client
    // that sends nothing must still get a game. Nothing in the body is trusted
    // regardless: the player comes from the gate above.
    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const parsed = parseChessAiGameRequest(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    }

    const result = await createChessAiGame(
      {
        playerId: userId,
        difficulty: parsed.difficulty,
        color: parsed.color,
      },
      {
        insertGame: async (values) => {
          const [row] = await db
            .insert(chessGames)
            .values(values)
            .returning({ id: chessGames.id });
          return row ?? null;
        },
      },
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      gameId: result.gameId,
      // The server's own resolution of `random` — the client MUST draw its
      // board from this rather than rolling again.
      humanColor: result.humanColor,
      // The canonical tier that was persisted onto the row.
      aiDifficulty: result.aiDifficulty,
      // The same tier on the legacy 1–5 scale the AI page still reads from its
      // URL. Kept because the response shape is a contract with cached clients.
      difficultyLevel: result.difficultyLevel,
    });
  } catch (err) {
    console.error("Create-AI-game error:", err);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
