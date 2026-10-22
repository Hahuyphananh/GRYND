// src/app/api/odds/pvp/pick/route.ts
//
// ONE submission per round, for a staked Odds duel.
//
// Body: { gameId, exact } | { gameId, min, max }  (or the same object under
// `prediction`).
//
// The route owns everything the client must not: the row lock, the timeout
// forfeit, the duplicate-submission guard, range validation, round resolution
// and settlement. The round's TARGET never leaves the server except through
// `viewForPlayer`, and only once the round has resolved.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq } from "drizzle-orm";
import {
  ROUND_TIMEOUT_MS,
  currentRoundOf,
  isCurrentOddsState,
  parsePrediction,
  resolveRound,
  submitPrediction,
  viewForPlayer,
} from "../../../../../lib/odds";
import type { OddsGameState } from "../../../../../lib/odds";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { applyRatingResult } from "../../../../../lib/rating";
import { applyTrophyResult } from "../../../../../lib/trophyStore";
import {
  payOddsPvpWinner,
  voidUnsupportedOddsMatch,
} from "../../../../../lib/odds-pvp/serverStore";

export async function POST(req: Request) {
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

    const body = await req.json();
    const gameId = Number(body.gameId);

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid game ID" }, { status: 400 });
    }

    // A CLAIM is not a call: it asks the route to settle a round the caller
    // already submitted, once the opponent has gone quiet. It carries no
    // prediction at all, so it can never overwrite a pending call — and it is
    // only honoured after the timeout branch below agrees the round is due.
    const claimOnly = body?.claim === true;

    // Validate the prediction BEFORE taking a row lock: a malformed request
    // must not block the match row for everyone else.
    const parsed = claimOnly
      ? null
      : parsePrediction(
          body?.prediction && typeof body.prediction === "object"
            ? body.prediction
            : { exact: body?.exact, min: body?.min, max: body?.max },
        );
    // `in` rather than `!parsed.ok`: `strict` is off in this project, so the
    // boolean discriminant is widened and truthiness does not narrow the union.
    if (parsed && "error" in parsed) {
      return NextResponse.json(
        { success: false, error: parsed.error },
        { status: 400 },
      );
    }
    // `in` again rather than the boolean discriminant — see the note above.
    const prediction =
      parsed && !("error" in parsed) ? parsed.prediction : null;

    const result = await db.transaction(async (tx: any) => {
      const [game] = await tx
        .select()
        .from(oddsGames)
        .where(eq(oddsGames.id, gameId))
        .for("update");

      if (!game) throw new Error("Game not found");
      if (game.status !== "playing") throw new Error("Game is not active");
      if (game.isAi) throw new Error("Use AI pick endpoint for AI games");

      const isPlayer1 = game.player1Id === userId;
      const isPlayer2 = game.player2Id === userId;
      if (!isPlayer1 && !isPlayer2)
        throw new Error("You are not part of this game");

      // A match written by the RETIRED rules (pick a hidden number, predict the
      // opponent's, shrinking range) has no target and cannot be played under
      // this engine. Void it and give both stakes back inside this transaction
      // so no wager is ever stranded — `refundMatchWagers` and the ledger's
      // terminal-move guards make the void idempotent and mutually exclusive
      // with a payout.
      if (!isCurrentOddsState(game.gameState)) {
        const refunded = await voidUnsupportedOddsMatch({
          tx,
          gameId,
          wager: game.wager,
          clerkIds: [game.player1Id, game.player2Id],
        });
        return {
          voided: true as const,
          refunded,
          view: null,
          round: null,
          winner: null,
          payout: 0,
          gameOver: true,
          resolved: true,
        };
      }

      const state = game.gameState as OddsGameState;
      if (state.gameOver) throw new Error("Game is already over");

      const live = currentRoundOf(state);

      // ── Timeout: the caller locked in, the opponent never did, and the round
      // has been open longer than the timeout. The seat that actually CALLED
      // the round banks the pot from the escrow both seats paid at join, inside
      // this transaction. The row lock above makes this the single settlement.
      //
      // The direction is the whole point. `mineSubmitted && !opponentSubmitted`
      // is a claim. The mirror case — I never submitted, my opponent did — is
      // the seat that ran out the clock, so handing it the pot here would let a
      // player who ignored the round steal a staked match by asking late. That
      // request falls through to the duplicate/late-pick refusal below instead.
      const now = Date.now();
      const roundAge = state.roundStartedAt ? now - state.roundStartedAt : 0;
      const mineSubmitted = isPlayer1
        ? live.player1Prediction !== null
        : live.player2Prediction !== null;
      const opponentSubmitted = isPlayer1
        ? live.player2Prediction !== null
        : live.player1Prediction !== null;

      if (roundAge > ROUND_TIMEOUT_MS && mineSubmitted && !opponentSubmitted) {
        const forfeiterId = isPlayer1 ? game.player2Id : game.player1Id;
        const winnerId = userId;
        const payout = await payOddsPvpWinner({
          tx,
          gameId,
          winnerId,
          wager: game.wager,
        });
        const winner: "player1" | "player2" = isPlayer1
          ? "player1"
          : "player2";

        // Persist the game-over state so the opponent's refetch reflects the
        // match ending (not just the submitter).
        const forfeitedState: OddsGameState = {
          ...state,
          gameOver: true,
          winner,
        };

        await tx
          .update(oddsGames)
          .set({
            status: "finished",
            winner,
            result: winner === "player1" ? "player1_won" : "player2_won",
            payout,
            gameState: forfeitedState,
            endedAt: new Date(),
          })
          .where(eq(oddsGames.id, gameId));

        applyLeaderboardCounters({
          clerkId: winnerId,
          game: "odds",
          outcome: "win",
          isPvpWin: true,
        }).catch(() => {});
        applyLeaderboardCounters({
          clerkId: forfeiterId!,
          game: "odds",
          outcome: "loss",
        }).catch(() => {});

        // Per-game Elo — timeout forfeit: the opponent wins, resolved
        // server-side from the game row's seat columns.
        applyRatingResult({
          gameKey: "odds-pvp",
          matchId: String(gameId),
          winnerClerkId: winnerId,
          loserClerkId: forfeiterId,
        }).catch(() => {});
        // Per-game trophies — the same authoritative forfeit (+30 / −30).
        applyTrophyResult({
          gameKey: "odds-pvp",
          matchId: String(gameId),
          winnerClerkId: winnerId,
          loserClerkId: forfeiterId,
        }).catch(() => {});

        return {
          voided: false as const,
          refunded: 0,
          view: viewForPlayer(forfeitedState, isPlayer1),
          round: null,
          winner,
          payout,
          gameOver: true,
          resolved: true,
        };
      }

      // A claim the timeout branch did not accept (the opponent is still on
      // the clock) is refused here rather than being stored as a call.
      if (claimOnly) {
        throw Object.assign(
          new Error("Your opponent is still on the clock — nothing to claim yet"),
          { status: 400 },
        );
      }

      // ── Duplicate submission: locked in is locked in ──
      if (mineSubmitted)
        throw Object.assign(
          new Error("You already submitted for this round"),
          { status: 400 },
        );

      if (!prediction) {
        throw Object.assign(new Error("A prediction is required"), {
          status: 400,
        });
      }

      const submitted = submitPrediction(
        state,
        isPlayer1 ? "player1" : "player2",
        prediction,
      );

      // Opponent has not submitted yet — save my locked-in prediction and hide
      // theirs. Nothing resolves, so the target stays secret.
      if (!submitted.roundComplete) {
        await tx
          .update(oddsGames)
          .set({ gameState: submitted.updatedState })
          .where(eq(oddsGames.id, gameId));

        return {
          voided: false as const,
          refunded: 0,
          view: viewForPlayer(submitted.updatedState, isPlayer1),
          round: null,
          winner: null,
          payout: 0,
          gameOver: false,
          resolved: false,
        };
      }

      // Both predictions in — score the round on the SERVER against the one
      // target. The winner below comes from that same resolver, never a client
      // value, so the pot always follows the scoreboard.
      const { round, updatedState } = resolveRound(submitted.updatedState);
      let payout = 0;

      if (updatedState.gameOver) {
        const winner = updatedState.winner; // null = draw
        const player1Won = winner === "player1";
        const winnerId = player1Won ? game.player1Id : game.player2Id;

        if (winner) {
          payout = await payOddsPvpWinner({
            tx,
            gameId,
            winnerId,
            wager: game.wager,
          });
          await tx
            .update(oddsGames)
            .set({
              status: "finished",
              winner,
              result: player1Won ? "player1_won" : "player2_won",
              payout,
              gameState: updatedState,
              endedAt: new Date(),
            })
            .where(eq(oddsGames.id, gameId));

          // Apply leaderboard counters (fire-and-forget)
          const loserId = player1Won ? game.player2Id : game.player1Id;
          applyLeaderboardCounters({
            clerkId: winnerId!,
            game: "odds",
            outcome: "win",
            isPvpWin: true,
          }).catch(() => {});
          applyLeaderboardCounters({
            clerkId: loserId!,
            game: "odds",
            outcome: "loss",
          }).catch(() => {});

          // Per-game Elo — the match winner comes from the server-side Odds
          // engine (updatedState.winner), never a client value.
          applyRatingResult({
            gameKey: "odds-pvp",
            matchId: String(gameId),
            winnerClerkId: winnerId!,
            loserClerkId: loserId!,
          }).catch(() => {});
          // Per-game trophies — the same authoritative result (+30 / −30).
          applyTrophyResult({
            gameKey: "odds-pvp",
            matchId: String(gameId),
            winnerClerkId: winnerId!,
            loserClerkId: loserId!,
          }).catch(() => {});
        } else {
          // Exact tie after all five rounds — no winner, so neither stake is
          // won: the whole escrow is VOIDED back to both seats. Without this
          // the two stakes would sit in the ledger forever (the payout path
          // pays nothing when there is no winner).
          // One terminal write: the helper refunds both seats and records the
          // draw (winner null, payout 0) on this same idempotent path.
          await voidUnsupportedOddsMatch({
            tx,
            gameId,
            wager: game.wager,
            clerkIds: [game.player1Id, game.player2Id],
            previousState: updatedState,
            result: "draw",
          });

          // Per-game Elo — an exact tie after every round is a DRAW: both
          // ratings move by K × (0.5 − expected), so neither side is punished
          // by the seating order.
          applyRatingResult({
            gameKey: "odds-pvp",
            matchId: String(gameId),
            winnerClerkId: String(game.player1Id),
            loserClerkId: String(game.player2Id),
            result: "draw",
          }).catch(() => {});
        }

        return {
          voided: false as const,
          refunded: 0,
          view: viewForPlayer(updatedState, isPlayer1),
          round,
          winner,
          payout: winner ? payout : 0,
          gameOver: true,
          resolved: true,
        };
      }

      // Round resolved, match continues — the next round is already open with
      // a fresh target and clue.
      await tx
        .update(oddsGames)
        .set({ gameState: updatedState })
        .where(eq(oddsGames.id, gameId));

      return {
        voided: false as const,
        refunded: 0,
        gameState: viewForPlayer(updatedState, isPlayer1),
        round,
        winner: null,
        payout: 0,
        gameOver: false,
        resolved: true,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        resolved: result.resolved,
        round: result.round,
        gameState: result.view,
        winner: result.winner,
        payout: result.payout,
        gameOver: result.gameOver,
        voided: result.voided,
      },
    });
  } catch (error: any) {
    const status = error?.status === 400 ? 400 : 500;
    return NextResponse.json(
      { success: false, error: error.message || "Failed to process pick" },
      { status },
    );
  }
}
