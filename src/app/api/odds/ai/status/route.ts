import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requirePracticePlayer } from "../../../../../lib/auth/guestSession";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import { isCurrentOddsState, viewForPlayer } from "../../../../../lib/odds";
import type { InteractiveOddsState } from "../../../../../lib/odds";

export async function GET() {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!process.env.DATABASE_URL) {
      return NextResponse.json({
        success: true,
        data: { active: false },
      });
    }

    // Find the user's currently active interactive AI game (most recent first)
    const [game] = await db
      .select()
      .from(oddsGames)
      .where(
        and(
          eq(oddsGames.player1Id, userId),
          eq(oddsGames.status, "playing"),
          eq(oddsGames.isAi, true),
        ),
      )
      .orderBy(desc(oddsGames.createdAt))
      .limit(1);

    if (!game) {
      return NextResponse.json({
        success: true,
        data: { active: false },
      });
    }

    const state = game.gameState as InteractiveOddsState;

    // A practice row from the retired rules cannot be projected or resumed.
    // It is reported as active with NO state, which is exactly the signal the
    // match page already uses to abandon a leftover duel: it calls
    // `/api/odds/ai/leave` and mints a fresh session.
    if (!isCurrentOddsState(state)) {
      return NextResponse.json({
        success: true,
        data: {
          active: true,
          gameId: game.id,
          wager: game.wager,
          retired: true,
          gameState: null,
          rounds: [],
          gameOver: false,
          winner: null,
          payout: 0,
        },
      });
    }

    // The player is always player1 in AI mode — the projection hides the AI's
    // pending prediction (and the live round's target) until the reveal. The
    // `rounds` list is read from that same projection: handing out
    // `state.rounds` here would leak the live target.
    const view = viewForPlayer(state, true);
    return NextResponse.json({
      success: true,
      data: {
        active: true,
        gameId: game.id,
        wager: game.wager,
        gameState: view,
        rounds: view.rounds,
        gameOver: state?.gameOver ?? false,
        winner: state?.winner ?? null,
        // A vs-AI duel moves no coins (`/pick` and `/end` skip every payout
        // when `game.isAi`), so there is no prize to advertise. This used to
        // report `wager * 2` — a 0%-edge pot the ledger never paid.
        payout: 0,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch status" },
      { status: 500 },
    );
  }
}
