// src/app/api/odds/pvp/status/route.ts
//
// The ONE authoritative read of a staked Odds match, per viewer.
//
//   GET ?gameId=<id>  ONE match, by id — what the match page reads, including
//                     the waiting host whose second seat is still open.
//   GET (no param)    the legacy "my most recent live duel" read the lobby uses
//                     to resume a player who navigated away.
//
// Either way the viewer must be a participant: the payload carries a
// per-viewer projection, and a stranger must never be able to pull the other
// seat's view (or the live round's target).
//
// LEGACY ROWS: a match still carrying the retired rules has no target and can
// never be played again. It is voided and refunded here — this is the one read
// every affected page performs, so it is the only place that reliably closes
// such a match instead of leaving both stakes escrowed forever. The void is
// idempotent and uses the same ledger guards as every other settlement.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq, and, or, desc } from "drizzle-orm";
import {
  ROUND_TIMEOUT_MS,
  currentRoundOf,
  hasSubmitted,
  isCurrentOddsState,
  viewForPlayer,
} from "../../../../../lib/odds";
import type { OddsGameState } from "../../../../../lib/odds";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import {
  oddsPvpPayout,
  voidUnsupportedOddsMatch,
} from "../../../../../lib/odds-pvp/serverStore";

const RETIRED_MESSAGE =
  "This match used retired rules and has been closed. Both stakes were refunded — open a new table from the lobby.";

const ABANDONED_MESSAGE =
  "Neither player called for too long, so the match was closed and both stakes refunded. Open a new table from the lobby.";

/**
 * Should a live match be swept as abandoned?
 *
 * Only when NEITHER seat has called the current round and the round has been
 * open for twice the timeout: one silent seat is a loss (the pick route settles
 * it for whoever called), two silent seats is a match nobody is playing. Pure,
 * so the cheap check runs on every read and the transaction only opens when it
 * is actually due.
 */
function isAbandoned(state: OddsGameState | null): boolean {
  if (!state || state.gameOver) return false;
  let live;
  try {
    live = currentRoundOf(state);
  } catch {
    return false;
  }
  if (
    live.player1Prediction !== null ||
    live.player2Prediction !== null
  ) {
    return false;
  }
  const age = state.roundStartedAt ? Date.now() - state.roundStartedAt : 0;
  return age > ROUND_TIMEOUT_MS * 2;
}

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
      // The user's most recent live duel, if any.
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

    if (!waitingForOpponent && !isCurrentOddsState(game.gameState)) {
      if (game.status === "playing") {
        await db.transaction(async (tx: any) => {
          const [locked] = await tx
            .select()
            .from(oddsGames)
            .where(eq(oddsGames.id, game.id))
            .for("update");
          // Re-check under the lock: another request may have settled it first.
          if (!locked || locked.status !== "playing") return;
          if (isCurrentOddsState(locked.gameState)) return;
          await voidUnsupportedOddsMatch({
            tx,
            gameId: locked.id,
            wager: locked.wager,
            clerkIds: [locked.player1Id, locked.player2Id],
          });
        });
      }
      return NextResponse.json({
        success: true,
        data: { active: false, retired: true, error: RETIRED_MESSAGE },
      });
    }

    const state = waitingForOpponent
      ? null
      : (game.gameState as OddsGameState);

    // A live match with both seats silent is abandoned in everything but name:
    // nothing can resolve it and it would hold two stakes in escrow forever.
    // This read is the one request every affected page makes, so — exactly like
    // the retired-row void above — it is where such a match is closed and both
    // stakes returned, in one idempotent terminal write.
    if (isAbandoned(state)) {
      const closed = await voidAbandonedMatch(game.id);
      if (closed) {
        return NextResponse.json({
          success: true,
          data: { active: false, abandoned: true, error: ABANDONED_MESSAGE },
        });
      }
    }
    // Full seat identity (real username + official icon + equipped name
    // color) for both seats — one shared query.
    const identity = await getSeatIdentity(game.player1Id, game.player2Id);
    const mySeat = isPlayer1 ? identity.player1 : identity.player2;
    const oppSeat = isPlayer1 ? identity.player2 : identity.player1;

    const view = state ? viewForPlayer(state, isPlayer1) : null;

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
        // The SANITIZED projection — the live round's target and the
        // opponent's pending prediction are null until the round resolves.
        gameState: view,
        rounds: view?.rounds ?? [],
        gameOver: state?.gameOver ?? false,
        winner: state?.winner ?? null,
        // The SAME helper the settlement pays through, so the prize shown here
        // is exactly what a win credits (both stakes minus the shared rake).
        payout: oddsPvpPayout(game.wager),
        userHasPendingPick: state ? hasSubmitted(state, isPlayer1) : false,
        opponentSubmitted: view?.opponentSubmitted ?? false,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch PvP status" },
      { status: 500 },
    );
  }
}

/**
 * Void + refund a match both players walked away from.
 *
 * Re-checks everything under the row lock (another request — or the cleanup
 * sweep — may have settled it in between), so a match can only ever be closed
 * once and the refund can never double-credit a stake.
 */
async function voidAbandonedMatch(gameId: number): Promise<boolean> {
  return db.transaction(async (tx: any) => {
    const [locked] = await tx
      .select()
      .from(oddsGames)
      .where(eq(oddsGames.id, gameId))
      .for("update");

    if (!locked || locked.status !== "playing") return false;
    const state = isCurrentOddsState(locked.gameState)
      ? (locked.gameState as OddsGameState)
      : null;
    if (!isAbandoned(state)) return false;

    await voidUnsupportedOddsMatch({
      tx,
      gameId: locked.id,
      wager: locked.wager,
      clerkIds: [locked.player1Id, locked.player2Id],
      previousState: { ...(state as OddsGameState), gameOver: true, winner: null },
      result: "cancelled",
    });
    return true;
  });
}
