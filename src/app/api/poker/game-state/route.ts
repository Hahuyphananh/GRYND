import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { applyLeaderboardCounters } from "../../../../lib/leaderboardCounters";

type Seat = {
  seat: number;
  clerkId: string | null;
  name?: string;
  isAI?: boolean;
  stack?: number;
};
type StoredMeta = { hostClerkId?: string; state?: any };

function normalizePlayersFromSeats(seats: Seat[]) {
  return seats
    .filter((s) => s.clerkId)
    .map((s) => ({
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
  const gameIdParam = searchParams.get("gameId");
  const gameId = Number(gameIdParam);

  if (!code && !Number.isFinite(gameId)) {
    return NextResponse.json(
      { error: "Missing code or gameId" },
      { status: 400 },
    );
  }

  const gameRows = code
    ? await db.select().from(pokerGames).where(eq(pokerGames.gameCode, code))
    : await db.select().from(pokerGames).where(eq(pokerGames.id, gameId));
  const [game] = gameRows;
  if (!game)
    return NextResponse.json({ error: "Game not found" }, { status: 404 });

  const meta = (game.playerPositions ?? {}) as StoredMeta;
  const seats = (game.players ?? []) as Seat[];

  const state = meta.state ?? {
    id: game.id,
    inviteCode: game.gameCode,
    players: normalizePlayersFromSeats(seats),
    community: game.communityCards ?? [],
    deck: [], // Never expose the deck — server controls card dealing
    deckHash: game.deck ? String((game.deck as any[]).length) : "0",
    pot: Number(game.pot ?? 0),
    currentTurn: game.currentTurn ?? 0,
    stage: game.round === "preflop" ? "pre-flop" : (game.round ?? "pre-flop"),
    smallBlind: Number(game.smallBlind ?? 10),
    bigBlind: Number(game.bigBlind ?? 20),
    replayVisible: false,
    dealerIndex: game.dealerPosition ?? 0,
    waiting: game.status !== "active",
  };

  return NextResponse.json({
    success: true,
    game: {
      ...state,
      hostClerkId: meta.hostClerkId,
      // Private games are virtual chips — the client needs to know so it
      // can skip the wallet-balance caps on buy-in.
      isPrivate: Boolean(game.isPrivate),
    },
  });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { gameCode, state } = await req.json();
  if (!gameCode || !state)
    return NextResponse.json({ error: "Missing data" }, { status: 400 });

  const [game] = await db
    .select()
    .from(pokerGames)
    .where(eq(pokerGames.gameCode, gameCode));
  if (!game)
    return NextResponse.json({ error: "Game not found" }, { status: 404 });

  const hadWinner = !!game.winner;

  const seats = (game.players ?? []) as Seat[];
  const seatedIds = seats
    .filter((s) => s.clerkId)
    .map((s) => s.clerkId as string);
  const meta = (game.playerPositions ?? {}) as StoredMeta;

  if (
    meta.hostClerkId &&
    userId !== meta.hostClerkId &&
    !seatedIds.includes(userId)
  ) {
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

  await db
    .update(pokerGames)
    .set({
      players: mergedSeats,
      playerPositions: {
        ...(meta || {}),
        hostClerkId: meta.hostClerkId || userId,
        state: {
          ...state,
          deck: undefined, // Never persist client deck
          deckHash: game.deck ? String((game.deck as any[]).length) : undefined,
        },
      },
      communityCards: state.community ?? [],
      pot: String(state.pot ?? 0),
      currentTurn: state.currentTurn ?? 0,
      round: state.stage ?? "pre-flop",
      dealerPosition: state.dealerIndex ?? 0,
      status: state.waiting ? "waiting" : "active",
      winner: state.winnerId ?? null,
    })
    .where(eq(pokerGames.gameCode, gameCode));

  // Track leaderboard stats when a new winner is determined. PRIVATE games
  // are virtual chips — nothing is won or lost for real, so they never
  // count toward ranked stats (no farming leaderboards in play-money
  // games).
  const newWinnerId = (state as any)?.winnerId as string | undefined;
  if (newWinnerId && !hadWinner && !game.isPrivate) {
    const players = (state as any)?.players as any[] | undefined;
    if (players && Array.isArray(players)) {
      const humanPlayers = players.filter(
        (p: any) => !p.isAI && p.id,
      );
      const isPvp = humanPlayers.length > 1;
      const pot = Math.max(0, Math.floor(Number((state as any)?.pot) || 0));

      // Track winner
      applyLeaderboardCounters({
        clerkId: newWinnerId,
        game: "Poker",
        betAmount: pot || 1,
        payout: pot,
        isPvpWin: isPvp,
      }).catch(() => {});

      // Track losers (all human players who aren't the winner)
      for (const p of humanPlayers) {
        if (p.id !== newWinnerId) {
          applyLeaderboardCounters({
            clerkId: p.id,
            game: "Poker",
            betAmount: pot || 1,
            payout: 0,
          }).catch(() => {});
        }
      }
    }
  }

  return NextResponse.json({ success: true });
}
