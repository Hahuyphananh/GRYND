import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { eq } from "drizzle-orm";
import { poolMatches } from "../../../../db/schema";

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

    const nextTurnUserId = state.turn === 2 ? match.player2Id : match.player1Id;

    await db
      .update(poolMatches)
      .set({ gameState: state, currentTurnUserId: nextTurnUserId ?? null })
      .where(eq(poolMatches.id, String(matchId)));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: "server_error" },
      { status: 500 },
    );
  }
}
