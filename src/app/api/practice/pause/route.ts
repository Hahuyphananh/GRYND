import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import {
  getPracticePause,
  isPracticePauseGame,
  setPracticePause,
} from "../../../../lib/practicePause";

// GET /api/practice/pause?game=<key>&matchId=<id>
// → { game, matchId, paused, pausedAtMs }
//
// POST /api/practice/pause { game, matchId, paused: boolean }
// → { ok, paused }
//
// Both handlers are free-play only: the service refuses a row whose game is
// not a live human-vs-AI match, and only a seated participant may toggle it.

const NO_STORE = { "Cache-Control": "no-store" } as const;

function parseGame(value: unknown) {
  return isPracticePauseGame(value) ? value : null;
}

export async function GET(req: Request) {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const { searchParams } = new URL(req.url);
    const game = parseGame(searchParams.get("game"));
    const matchId = searchParams.get("matchId");
    if (!game || !matchId) {
      return NextResponse.json(
        { error: "game and matchId are required" },
        { status: 400, headers: NO_STORE },
      );
    }

    const state = await getPracticePause({ game, matchId, userId: gate.playerId! });
    if ("error" in state) {
      return NextResponse.json(
        { error: state.error },
        { status: state.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { game, matchId, ...state },
      { headers: NO_STORE },
    );
  } catch (error) {
    await logError({
      errorType: "practice_pause_read_error",
      errorMessage: error instanceof Error ? error.message : "Practice pause read failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/practice/pause",
      metadata: { operation: "read_pause" },
    });
    return NextResponse.json(
      { error: "Unable to read pause state" },
      { status: 500, headers: NO_STORE },
    );
  }
}

export async function POST(req: Request) {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const body = await req.json().catch(() => ({}));
    const game = parseGame(body?.game);
    const matchId = typeof body?.matchId === "string" ? body.matchId : "";
    const paused = body?.paused;
    if (!game || !matchId || typeof paused !== "boolean") {
      return NextResponse.json(
        { error: "game, matchId and paused (boolean) are required" },
        { status: 400, headers: NO_STORE },
      );
    }

    const result = await setPracticePause({
      game,
      matchId,
      userId: gate.playerId!,
      paused,
    });
    if ("error" in result) {
      return NextResponse.json(
        { ok: false, error: result.error, paused: null },
        { status: result.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { ok: true, paused: result.paused },
      { headers: NO_STORE },
    );
  } catch (error) {
    await logError({
      errorType: "practice_pause_toggle_error",
      errorMessage: error instanceof Error ? error.message : "Practice pause toggle failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/practice/pause",
      metadata: { operation: "toggle_pause" },
    });
    return NextResponse.json(
      { ok: false, error: "Unable to toggle pause" },
      { status: 500, headers: NO_STORE },
    );
  }
}
