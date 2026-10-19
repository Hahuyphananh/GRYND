import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames } from "../../../../../db/schema";
import { requireStake } from "../../../../../lib/games/stakes";

/**
 * POST /api/hex-duel/multiplayer/create
 *
 * Open a lobby for a staked duel. The stake is REQUIRED and legal — an online
 * ranked match always plays for coins (`requireStake`) — and is stored on the
 * row so the JOINING transaction can escrow both seats at the amount the
 * creator agreed to. Nothing is debited here: a lobby waiting for an opponent
 * costs nothing, exactly like every other duel on the platform.
 */
export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

    const { wager } = await req.json().catch(() => ({} as { wager?: unknown }));
    // The entry-point gate: a crafted request can neither open a free table nor
    // name a wager outside the game's bounds.
    const stake = requireStake(wager, "hex-duel");
    if (!stake.ok) {
      return NextResponse.json(
        { success: false, error: stake.error, code: stake.code },
        { status: stake.status },
      );
    }

    const [game] = await db
      .insert(hexDuelGames)
      .values({
        player1Id: userId,
        wagerAmount: stake.stake.toFixed(2),
        winner: "pending",
        result: "pending",
        status: "waiting",
        isAiGame: false,
        // Migration 0054: server-authoritative turn columns. Leaving
        // both null while the game is in `waiting` is correct — the
        // `/multiplayer/join` route sets `current_turn = 'player1'`
        // and `last_action_seq = 0` the moment player2 joins.
      } as any)
      .returning({ id: hexDuelGames.id });

    return NextResponse.json({ success: true, gameId: game.id, wager: stake.stake, newBalance: null });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || "Unable to create game" }, { status: 500 });
  }
}
