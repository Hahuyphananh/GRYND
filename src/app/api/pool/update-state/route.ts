import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { eq } from "drizzle-orm";
import { poolMatches } from "../../../../db/schema";

export async function POST(req: Request) {
  try {
    const { matchId, state } = await req.json();
    if (!matchId || !state) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    await db.update(poolMatches).set({ gameState: state, currentTurnUserId: String(state.turn ?? "") }).where(eq(poolMatches.id, String(matchId)));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
