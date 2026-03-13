import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

type Seat = { seat: number; clerkId: string | null; name?: string; isAI?: boolean; stack?: number };
type StoredMeta = { hostClerkId?: string; state?: any };

function normalizePlayersFromSeats(seats: Seat[]) {
  return seats.filter((s) => s.clerkId).map((s) => ({
    id: s.clerkId,
    name: s.name || (s.isAI ? "AI" : "Player"),
    stack: s.stack ?? 1000,
    hand: [],
    isAI: !!s.isAI,
    hasFolded: false,
    lastAction: "",
    currentBet: 0,
    seatIndex: s.seat,
  }));
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });

  const [game] = await db.select().from(pokerGames).where(eq(pokerGames.gameCode, code));
  if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

  const meta = (game.playerPositions ?? {}) as StoredMeta;
  const seats = (game.players ?? []) as Seat[];

  const state = meta.state ?? {
    id: game.id,
    inviteCode: game.gameCode,
    players: normalizePlayersFromSeats(seats),
    community: game.communityCards ?? [],
    deck: game.deck ?? [],
    pot: Number(game.pot ?? 0),
    currentTurn: game.currentTurn ?? 0,
    stage: game.round === "preflop" ? "pre-flop" : game.round ?? "pre-flop",
    smallBlind: Number(game.smallBlind ?? 10),
    bigBlind: Number(game.bigBlind ?? 20),
    replayVisible: false,
    dealerIndex: game.dealerPosition ?? 0,
    waiting: game.status !== "active",
  };

  return NextResponse.json({ success: true, game: { ...state, hostClerkId: meta.hostClerkId } });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { gameCode, state } = await req.json();
  if (!gameCode || !state) return NextResponse.json({ error: "Missing data" }, { status: 400 });

  const [game] = await db.select().from(pokerGames).where(eq(pokerGames.gameCode, gameCode));
  if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

  const seats = (game.players ?? []) as Seat[];
  const seatedIds = seats.filter((s) => s.clerkId).map((s) => s.clerkId as string);
  const meta = (game.playerPositions ?? {}) as StoredMeta;

  if (meta.hostClerkId && userId !== meta.hostClerkId && !seatedIds.includes(userId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const playersBySeat = Array.isArray(state.players)
    ? state.players.reduce((acc: Record<number, any>, p: any) => {
        if (typeof p?.seatIndex === "number") acc[p.seatIndex] = p;
        return acc;
      }, {})
    : {};

  const mergedSeats = seats.map((seat) => {
    const fromState = playersBySeat[seat.seat];
    return fromState
      ? {
          ...seat,
          clerkId: fromState.id ?? seat.clerkId,
          name: fromState.name ?? seat.name,
          isAI: !!fromState.isAI,
          stack: fromState.stack ?? seat.stack ?? 1000,
        }
      : seat;
  });

  await db.update(pokerGames).set({
    players: mergedSeats,
    playerPositions: { ...(meta || {}), hostClerkId: meta.hostClerkId || userId, state },
    communityCards: state.community ?? [],
    deck: state.deck ?? [],
    pot: String(state.pot ?? 0),
    currentTurn: state.currentTurn ?? 0,
    round: state.stage ?? "pre-flop",
    dealerPosition: state.dealerIndex ?? 0,
    status: state.waiting ? "waiting" : "active",
    winner: state.winnerId ?? null,
  }).where(eq(pokerGames.gameCode, gameCode));

  return NextResponse.json({ success: true });
}
