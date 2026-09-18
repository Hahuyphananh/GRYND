import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

type Seat = {
  seat: number;
  clerkId: string | null;
  name?: string | null;
  isAI?: boolean;
  stack?: number;
  difficulty?: "easy" | "medium" | "hard";
};

/**
 * POST /api/poker/remove-ai
 *
 * Body: { gameCode: string, aiId: string }
 *
 * Removes an AI seat from a PRIVATE poker game. Only the host may remove
 * AIs (mirrors the add rule — the host who added them manages them), and
 * AIs only exist in private games.
 *
 *   1. Validates the caller is the game host and the game is private.
 *   2. Finds the AI's seat by its clerkId (`ai_...`) and clears it.
 *   3. Also drops the AI from the normalized state.players.
 *
 * Returns the updated game row so the client can refetch / reconcile.
 */
export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const gameCode = String(body?.gameCode ?? "").trim().toUpperCase();
    const aiId = String(body?.aiId ?? "").trim();
    if (!gameCode || !aiId) {
      return NextResponse.json({ error: "gameCode and aiId are required" }, { status: 400 });
    }

    const [game] = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.gameCode, gameCode));
    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    const meta =
      (game.playerPositions as { hostClerkId?: string; state?: any } | null) ||
      {};
    const isHost = meta.hostClerkId === userId;
    if (!isHost) {
      return NextResponse.json({ error: "Only the host can remove AIs" }, { status: 403 });
    }

    // AIs are private-only — nothing to remove in a public game.
    if (!game.isPrivate) {
      return NextResponse.json({ error: "AIs can only be managed in private games" }, { status: 400 });
    }

    const seats: Seat[] = Array.isArray(game.players) ? game.players : [];
    const targetSeat = seats.find((s) => s.clerkId === aiId && s.isAI);
    if (!targetSeat) {
      return NextResponse.json({ error: "AI seat not found" }, { status: 404 });
    }

    // Clear the seat (a human can later sit here).
    const updatedSeats = seats.map((s) =>
      s.seat === targetSeat.seat
        ? { seat: s.seat, clerkId: null, name: null, isAI: false, stack: 1000, difficulty: undefined }
        : s,
    );

    // Drop the AI from the normalized state.players too.
    const currentState = meta.state && typeof meta.state === "object" ? meta.state : null;
    const updatedState = currentState
      ? {
          ...currentState,
          players: Array.isArray(currentState.players)
            ? currentState.players.filter(
                (p: any) => !(p?.id === aiId && p?.isAI),
              )
            : currentState.players,
        }
      : currentState;

    const [updatedGame] = await db
      .update(pokerGames)
      .set({
        players: updatedSeats,
        playerPositions: { ...meta, state: updatedState },
      })
      .where(eq(pokerGames.gameCode, gameCode))
      .returning();

    return NextResponse.json({ success: true, game: updatedGame });
  } catch (err) {
    console.error("POKER REMOVE AI ERROR:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
