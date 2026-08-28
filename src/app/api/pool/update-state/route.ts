import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { eq } from "drizzle-orm";
import { poolMatches } from "../../../../db/schema";
import { logError } from "../../../../lib/logError";

function getVersionFromGameState(gameState: unknown): number {
  if (!gameState || typeof gameState !== "object") return 0;
  const maybeVersion = (gameState as Record<string, unknown>).version;
  return typeof maybeVersion === "number" && Number.isFinite(maybeVersion)
    ? maybeVersion
    : 0;
}

export async function POST(req: Request) {
  try {
    const { matchId, state } = await req.json();
    if (!matchId || !state)
      return NextResponse.json(
        { ok: false, error: "bad_request" },
        { status: 400 },
      );

    const [match] = await db
      .select()
      .from(poolMatches)
      .where(eq(poolMatches.id, String(matchId)))
      .limit(1);

    if (!match) {
      return NextResponse.json(
        { ok: false, error: "match_not_found" },
        { status: 404 },
      );
    }

    // Accept all lifecycle states so the polling fallback always has the
    // latest ball positions. Version-based dedup prevents stale overwrites.
    const currentVersion = getVersionFromGameState(match.gameState);
    const incomingVersion = Number(state.version ?? 0);
    if (!Number.isFinite(incomingVersion) || incomingVersion <= currentVersion) {
      return NextResponse.json({ ok: true, skipped: true, reason: "stale_version" });
    }

    const nextTurnUserId = state.turn === 2 ? match.player2Id : match.player1Id;
    await db
      .update(poolMatches)
      .set({
        gameState: state,
        currentTurnUserId: nextTurnUserId ?? null,
      })
      .where(eq(poolMatches.id, String(matchId)));
    return NextResponse.json({ ok: true });
  } catch (error) {
    await logError({
      errorType: "pool_state_update_error",
      errorMessage: error instanceof Error ? error.message : "Pool state update failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/pool/update-state",
      game: "Pool",
      metadata: { operation: "update_state" },
    });
    return NextResponse.json(
      { ok: false, error: "server_error" },
      { status: 500 },
    );
  }
}
