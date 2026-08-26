import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { eq } from "drizzle-orm";
import { poolMatches, poolLobbies } from "../../../../db/schema";
import { auth } from "@clerk/nextjs/server";

type PoolMatchRow = typeof poolMatches.$inferSelect;

function matchPayload(match: PoolMatchRow, userId: string | null) {
  const viewerSeat: 1 | 2 = userId && userId === match.player2Id ? 2 : 1;
  return {
    ok: true,
    match,
    viewerSeat,
    viewerName: "You",
    opponentName: match.player2Id === "AI" ? "AI" : "Opponent",
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const matchId = searchParams.get("matchId") || "";
  if (!UUID_RE.test(matchId)) {
    return NextResponse.json({ ok: false, error: "Invalid matchId" }, { status: 400 });
  }
  const { userId } = await auth();

  const [match] = await db
    .select()
    .from(poolMatches)
    .where(eq(poolMatches.id, matchId))
    .limit(1);
  if (match) return NextResponse.json(matchPayload(match, userId));

  const [lobbyMatch] = await db
    .select()
    .from(poolMatches)
    .where(eq(poolMatches.lobbyId, matchId))
    .limit(1);
  if (lobbyMatch) return NextResponse.json(matchPayload(lobbyMatch, userId));

  const [lobby] = await db
    .select()
    .from(poolLobbies)
    .where(eq(poolLobbies.id, matchId))
    .limit(1);
  return NextResponse.json({
    ok: true,
    match: lobby ? { id: lobby.id, status: lobby.status } : null,
  });
}
