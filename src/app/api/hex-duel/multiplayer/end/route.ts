import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames, users } from "../../../../../db/schema";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { logError } from "../../../../../lib/logError";
import { PVP_WINNER_SHARE } from "../../../../../lib/games/economy";
import { settleHexDuelMatch } from "../../../../../lib/hex-duel/settle";
import {
  hexDuelSeatFor,
  hexDuelSettledWinner,
  type StoredHexDuelAction,
} from "../../../../../lib/hex-duel/authority";
import type { DuelPlayer } from "../../../../../lib/hex-duel/rules";

// The shared pot multiplier: 2 stakes × the 90% winner share = 1.8× at the
// platform's 10% rake. Never a hand-written number — the payout actually moves
// through `payPvpPot`, which owns the same arithmetic.
const PAYOUT_MULTIPLIER = 2 * PVP_WINNER_SHARE;

/**
 * POST /api/hex-duel/multiplayer/end
 *
 * Finish a Hex Duel match. The winner is the SERVER's decision.
 *
 * The request body may still carry `winner` (older clients send it) and is
 * IGNORED for settlement: the route rebuilds the board from the moves the
 * action endpoint accepted (`hex_duel_actions`) and asks the shared rulebook who
 * won. The row's own `winner` column is the only fallback, and only ever holds a
 * seat that was decided by that replay or by the resigning player's own
 * authenticated concession — a client cannot name itself the winner, so a
 * request can no longer mint a pot.
 *
 * Money moves exactly once, in the transaction that finalises the match: the
 * winner is paid `2 × stake × 90%` out of the escrow both seats funded at join
 * (`payPvpPot`, which refuses a payout with no funding debit). A retry, a second
 * client settling the same match, or a replayed request all see the completed
 * row and pay nothing more.
 */
export async function POST(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // them even when the throw happened during auth or JSON parsing.
  let clerkId: string | null = null;
  let gameIdFromBody: number | null = null;

  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    clerkId = userId ?? null;
    if (!clerkId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      gameId?: unknown;
      winner?: unknown;
      player1Moves?: number;
      player2Moves?: number;
      player1Territory?: number;
      player2Territory?: number;
      durationSeconds?: number;
      startedAt?: string;
    };
    const player1Moves = body.player1Moves;
    const player2Moves = body.player2Moves;
    const player1Territory = body.player1Territory;
    const player2Territory = body.player2Territory;
    const durationSeconds = body.durationSeconds;
    const requestedGameId = Number(body.gameId);
    gameIdFromBody =
      Number.isFinite(requestedGameId) && requestedGameId > 0 ? requestedGameId : null;
    // Note that no field of the parsed body decides the result below: the
    // finish request is a SIGNAL that the board is over, never a claim about who
    // won it. The `winner` field is read nowhere.

    // Atomic: find the caller's live multiplayer game and settle it exactly once.
    const result = await db.transaction(async (tx) => {
      // Find the game to settle. The client sends its `gameId` (so a stale tab
      // can never settle a newer match); older clients send nothing, and the
      // caller's most recent unfinished match is used. Either way the caller
      // must hold a seat — typed or(eq(...), eq(...)) instead of the raw
      // `sql\`(${...} = ${clerkId} OR ...)\`` template, whose parameter-binder
      // fragility under drizzle-orm/neon-serverless was a confirmed source of
      // 500s on the sibling `actions/route.ts`.
      const participant = or(
        eq(hexDuelGames.player1Id, clerkId),
        eq(hexDuelGames.player2Id, clerkId),
      );

      const [game] = await tx
        .select()
        .from(hexDuelGames)
        .where(
          gameIdFromBody
            ? and(eq(hexDuelGames.id, gameIdFromBody), participant)
            : and(participant, eq(hexDuelGames.isAiGame, false)),
        )
        .orderBy(desc(hexDuelGames.createdAt))
        .for("update")
        .limit(1);

      if (!game) {
        throw Object.assign(new Error("No active game found"), { _httpStatus: 404 });
      }

      const callerSlot = hexDuelSeatFor(game, clerkId);
      if (!callerSlot) {
        throw Object.assign(new Error("No active game found"), { _httpStatus: 404 });
      }

      const seats = { player1Id: game.player1Id, player2Id: game.player2Id };
      const stake = Number(game.wagerAmount) || 0;

      // Already settled (the opponent's client got here first, or this is a
      // retry): report the stored result and move nothing. The ledger would
      // refuse a second payout anyway — this keeps the response honest.
      if (game.status === "completed") {
        const settledWinner = game.winner === "player1" || game.winner === "player2" ? game.winner : null;
        const [fresh] = await tx
          .select({ balance: users.balance })
          .from(users)
          .where(eq(users.clerkId, clerkId))
          .limit(1);
        return {
          alreadyProcessed: true as const,
          won: settledWinner !== null && settledWinner === callerSlot,
          winner: settledWinner,
          wager: stake,
          payout: Number(game.payout || 0),
          multiplier: PAYOUT_MULTIPLIER,
          newBalance: fresh ? Number(fresh.balance) : undefined,
        };
      }

      // Rebuild the server's board from the moves it accepted, then ask the
      // rulebook (and, as a fallback, the row's own `winner` column — only ever
      // written by a replay or by a seat conceding) who won.
      const storedRows = await tx
        .select({
          userId: hexDuelActions.userId,
          actionType: hexDuelActions.actionType,
          sourceKey: hexDuelActions.sourceKey,
          targetKey: hexDuelActions.targetKey,
          troopCount: hexDuelActions.troopCount,
        })
        .from(hexDuelActions)
        .where(eq(hexDuelActions.gameId, game.id))
        .orderBy(asc(hexDuelActions.id));

      const settled = hexDuelSettledWinner(
        seats,
        storedRows as StoredHexDuelAction[],
        game.winner,
      );
      if (!settled.winner) {
        // No terminal result on the server yet (a capture the server has not
        // seen, or a live match). Leave the row — and the escrow — alone so the
        // move that ends it, or the seat that concedes, can settle it.
        throw Object.assign(new Error("Match result is not final"), {
          _httpStatus: 409,
          _code: "RESULT_PENDING",
        });
      }

      const winnerSeat: DuelPlayer = settled.winner;
      const callerWon = winnerSeat === callerSlot;

      // ONE settlement for every ending: the row, both seats' counters and the
      // pot (src/lib/hex-duel/settle.ts).
      const { payout } = await settleHexDuelMatch({
        tx,
        game,
        winnerSeat,
        callerSeat: callerSlot,
        stats: {
          player1Moves,
          player2Moves,
          player1Territory,
          player2Territory,
          durationSeconds,
        },
      });

      const [freshCaller] = await tx
        .select({ balance: users.balance })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      return {
        alreadyProcessed: false as const,
        won: callerWon,
        winner: winnerSeat,
        wager: stake,
        payout,
        multiplier: PAYOUT_MULTIPLIER,
        newBalance: freshCaller ? Number(freshCaller.balance) : undefined,
      };
    });

    // Record leaderboard stats (fire-and-forget, outside the transaction). Both
    // seats count, and only the settling call reaches this point.
    if (!result.alreadyProcessed) {
      const outcome = result.won ? "win" : "loss";
      applyLeaderboardCounters({
        clerkId: clerkId as string,
        game: "Hex Duel",
        outcome,
        isPvpWin: result.won,
      }).catch(() => {});
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    // Capture the real cause on `error.cause` so Vercel function logs
    // (and Sentry if wired up) finally show the actual failure mode:
    // Drizzle 0.45.x wraps every DB/network error in a
    // `DrizzleQueryError` whose `.message` is literally
    // `"Failed query: <sql>"` and whose real Postgres / network error
    // sits on `.cause`. Without this, every prior "real errors" log
    // only showed the useless wrapper.
    //
    // We also log Postgres-specific fields (`detail`, `hint`) since
    // those are the highest-signal fields on real errors once `.cause`
    // is surfaced.
    console.error(
      "[hex-duel/multiplayer/end] POST failed",
      {
        clerkId,
        gameId: gameIdFromBody,
        err: error?.message,
        stack: error?.stack,
        causeMessage: error?.cause?.message,
        causeCode: error?.cause?.code,
        causeName: error?.cause?.name,
        causeDetail: error?.cause?.detail,
        causeHint: error?.cause?.hint,
      },
    );
    const httpStatus: number =
      typeof error?._httpStatus === "number" ? error._httpStatus : 500;
    // A match the SERVER has not finished is a normal, actionable answer
    // (the board is still live); anything else is logged for ops.
    if (httpStatus >= 500) {
      await logError({
        errorType: "hex_duel_payout_error",
        errorMessage: error?.message || "Hex Duel payout failed",
        stackTrace: error?.stack,
        endpoint: "/api/hex-duel/multiplayer/end",
        game: "Hex Duel",
        metadata: { operation: "settle_match" },
      });
    }
    return NextResponse.json(
      {
        success: false,
        error: httpStatus >= 500 ? "Server error" : error?.message || "Unable to finish match",
        code: error?._code,
      },
      { status: httpStatus },
    );
  }
}
