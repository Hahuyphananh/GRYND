import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq, and, or, desc } from "drizzle-orm";
import { viewForPlayer } from "../../../../../lib/odds";
import type { PvPInteractiveOddsState } from "../../../../../lib/odds";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import { oddsPvpPayout } from "../../../../../lib/odds-pvp/serverStore";

export async function GET(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }


    // TWO ways in:
    //
    //   GET ?gameId=<id>  ONE match, by id. This is what the MATCH page reads
    //                     (`/casino/odds/game/<id>`), including the waiting
    //                     host whose second seat is still open — the lobby
    //                     only creates, so the board has to be able to load
    //                     the exact game its URL names.
    //   GET (no param)    the legacy "my most recent live duel" read.
    //
    // Either way the viewer must be a participant: the payload carries a
    // per-viewer sanitized state, and a stranger must not be able to pull the
    // other seat's view.
    const requestedId = Number(new URL(req.url).searchParams.get("gameId"));
    const byId = Number.isInteger(requestedId) && requestedId > 0;

    let game: any = null;
    if (byId) {
      const [row] = await db
        .select()
        .from(oddsGames)
        .where(eq(oddsGames.id, requestedId));
      if (!row) {
        return NextResponse.json(
          { success: false, error: "Match not found" },
          { status: 404 },
        );
      }
      if (row.player1Id !== userId && row.player2Id !== userId) {
        return NextResponse.json(
          { success: false, error: "Not part of this match" },
          { status: 403 },
        );
      }
      if (row.isAi) {
        return NextResponse.json(
          { success: false, error: "Not a PvP match" },
          { status: 400 },
        );
      }
      if (row.status === "cancelled") {
        return NextResponse.json(
          { success: false, error: "This lobby was cancelled" },
          { status: 410 },
        );
      }
      game = row;
    } else {
      // Find the user's most recent active interactive PvP game
      const [row] = await db
        .select()
        .from(oddsGames)
        .where(
          and(
            or(eq(oddsGames.player1Id, userId), eq(oddsGames.player2Id, userId)),
            eq(oddsGames.status, "playing"),
            eq(oddsGames.isAi, false),
          ),
        )
        .orderBy(desc(oddsGames.createdAt))
        .limit(1);
      game = row ?? null;
    }

    if (!game) {
      return NextResponse.json({
        success: true,
        data: { active: false },
      });
    }

    const isPlayer1 = game.player1Id === userId;
    const opponentId = isPlayer1 ? game.player2Id : game.player1Id;
    // A table whose second seat is still open has a gameState row from the
    // moment it was created, but no duel: the match page must render its
    // WAITING card for it, so the state is only handed out once both seats are
    // in. `status` is what the client keys off.
    const waitingForOpponent = game.status === "waiting" || !game.player2Id;
    const state = waitingForOpponent
      ? null
      : (game.gameState as PvPInteractiveOddsState | null);

    // Full seat identity (real username + official icon + equipped name
    // color) for both seats — one shared query. The AI seat (never in
    // this PvP-only route, but defensively) resolves to nulls.
    const identity = await getSeatIdentity(game.player1Id, game.player2Id);
    const mySeat = isPlayer1 ? identity.player1 : identity.player2;
    const oppSeat = isPlayer1 ? identity.player2 : identity.player1;

    // Phase-aware: has the user already submitted their part of the
    // current phase (number in "pick", prediction in "predict")?
    const userHasPendingPick =
      state &&
      !state.gameOver &&
      ((state.phase === "predict" &&
        (isPlayer1 ? state.player1Prediction !== null : state.player2Prediction !== null)) ||
        (state.phase === "pick" &&
          (isPlayer1 ? state.player1Pick !== null : state.player2Pick !== null)));

    return NextResponse.json({
      success: true,
      data: {
        active: true,
        gameId: game.id,
        // waiting | playing | finished — the match page's stage.
        status: game.status,
        wager: game.wager,
        isPlayer1,
        opponentId,
        myName: mySeat?.name ?? null,
        myIconKey: mySeat?.iconKey ?? null,
        myNameColor: mySeat?.nameColor ?? null,
        myProfileFrame: mySeat?.profileFrame ?? null,
        opponentName: oppSeat?.name ?? null,
        opponentIconKey: oppSeat?.iconKey ?? null,
        opponentNameColor: oppSeat?.nameColor ?? null,
        opponentProfileFrame: oppSeat?.profileFrame ?? null,
        gameState: state ? viewForPlayer(state, isPlayer1) : null,
        rounds: state?.rounds ?? [],
        gameOver: state?.gameOver ?? false,
        winner: state?.winner ?? null,
        // The SAME helper the settlement pays through, so the prize shown here
        // is exactly what a win credits (both stakes minus the shared rake).
        payout: oddsPvpPayout(game.wager),
        userHasPendingPick,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch PvP status" },
      { status: 500 },
    );
  }
}
