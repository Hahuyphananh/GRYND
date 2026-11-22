// src/app/api/solitaire-puzzle/ai/route.ts
//
// POST — start a Puzzle vs AI practice session.
//
// The body is ONLY `{ botId, level?, puzzleCount? }`:
//
//   botId        one of the six EXISTING Solitaire opponents. An unknown id is
//                refused; it never silently becomes a different bot.
//   level        1–5, the library's difficulty band. Optional: the player may
//                pick any puzzle instead.
//   puzzleCount  1–5, how many puzzles the race contains. Default 1.
//
// Everything competitive is absent by construction: the created row is
// `mode: "ai"`, `is_ai: true`, untimed, and can never enter the human queue,
// the ranked history or a settlement. The manifest is chosen server-side from a
// server-generated seed, so a client cannot hand us a puzzle set.
//
// PRACTICE AUTH: `requirePracticePlayer` — signed-in accounts AND guests may
// practise; neither can rate anything from this route.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import {
  isSolitaireBotId,
  publicSolitaireBot,
  solitaireBotFor,
} from "../../../../lib/solitaire-duel/bots";
import {
  createPuzzlePracticeSession,
  fetchPuzzleSession,
} from "../../../../lib/solitaire-puzzle/serverStore";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // `create: true` mints the signed guest cookie when a signed-out visitor
  // starts practice. Follow-up reads/moves still require that existing guest.
  const gate = await requirePracticePlayer({ create: true });
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const botId = body?.botId;
  if (!isSolitaireBotId(botId)) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Unknown bot. Choose rookie, felix, ace, professor, grandmaster or perfect.",
      },
      { status: 400 },
    );
  }

  const levelRaw = body?.level;
  const level =
    levelRaw === undefined || levelRaw === null ? null : Number(levelRaw);
  if (level !== null && (!Number.isInteger(level) || level < 1 || level > 5)) {
    return NextResponse.json(
      { success: false, error: "level must be an integer from 1 to 5" },
      { status: 400 },
    );
  }

  const countRaw = body?.puzzleCount;
  const puzzleCount =
    countRaw === undefined || countRaw === null ? 1 : Number(countRaw);
  if (!Number.isInteger(puzzleCount) || puzzleCount < 1 || puzzleCount > 5) {
    return NextResponse.json(
      { success: false, error: "puzzleCount must be an integer from 1 to 5" },
      { status: 400 },
    );
  }

  try {
    const session = await createPuzzlePracticeSession({
      userId,
      botId,
      level,
      puzzleCount,
    });

    // Read back through the ONE projection so this route cannot widen the
    // client boundary (no manifest, no start state, no solution line).
    const read = await fetchPuzzleSession({ userId, sessionId: session.id });
    if ("error" in read) {
      return NextResponse.json(
        { success: false, error: read.error },
        { status: read.status },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        sessionId: session.id,
        view: read.view,
        // The opponent is always explicitly AI to the client.
        opponent: {
          kind: "ai" as const,
          bot: publicSolitaireBot(solitaireBotFor(botId)),
        },
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_puzzle_ai_create_error",
      errorMessage:
        error instanceof Error ? error.message : "Puzzle vs AI session creation failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-puzzle/ai",
      game: "Puzzle vs AI",
      metadata: { operation: "create_practice_session" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
