import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq, and } from "drizzle-orm";
import {
  ROUND_TIMEOUT_MS,
  currentRoundOf,
  isCurrentOddsState,
} from "../../../../../lib/odds";
import type { OddsGameState } from "../../../../../lib/odds";
import { applyLeaderboardCounters } from "../../../../../lib/leaderboardCounters";
import { applyRatingResult } from "../../../../../lib/rating";
import { applyTrophyResult } from "../../../../../lib/trophyStore";
import {
  payOddsPvpWinner,
  voidUnsupportedOddsMatch,
} from "../../../../../lib/odds-pvp/serverStore";

/** The same window the pick route honours, so the sweep can never disagree. */
const TIMEOUT_MS = ROUND_TIMEOUT_MS;

export async function POST(req: Request) {
  try {
    // Require auth — callers should be authenticated (or use a secret key)
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Find all active PvP games
    const games = await db
      .select()
      .from(oddsGames)
      .where(and(eq(oddsGames.status, "playing"), eq(oddsGames.isAi, false)));

    let forfeited = 0;

    for (const game of games) {
      // ── Retired rules: cannot be played, must not stay escrowed ──
      if (!isCurrentOddsState(game.gameState)) {
        await db.transaction(async (tx: any) => {
          const [locked] = await tx
            .select()
            .from(oddsGames)
            .where(eq(oddsGames.id, game.id))
            .for("update");
          if (!locked || locked.status !== "playing") return;
          if (isCurrentOddsState(locked.gameState)) return;
          await voidUnsupportedOddsMatch({
            tx,
            gameId: locked.id,
            wager: locked.wager,
            clerkIds: [locked.player1Id, locked.player2Id],
          });
        });
        forfeited++;
        continue;
      }

      const state = game.gameState as OddsGameState;
      if (state.gameOver) continue;

      const now = Date.now();
      const roundAge = state.roundStartedAt ? now - state.roundStartedAt : 0;
      if (roundAge <= TIMEOUT_MS) continue;

      // One submission per seat per round, so "done" is simply "predicted".
      const live = currentRoundOf(state);
      const p1Done = live.player1Prediction !== null;
      const p2Done = live.player2Prediction !== null;

      // Only forfeit when exactly one player hasn't submitted (the inactive
      // one). If both are done the round should have resolved already.
      if (p1Done && !p2Done) {
        // Player 2 timed out
        await forfeitPlayer(game.id, game.player2Id!, game.player1Id, game.wager, "player1");
        forfeited++;
      } else if (!p1Done && p2Done) {
        // Player 1 timed out
        await forfeitPlayer(game.id, game.player1Id, game.player2Id!, game.wager, "player2");
        forfeited++;
      } else if (!p1Done && !p2Done) {
        // Both inactive — game abandoned. Cancel it (refund both).
        // Only trigger if the round has been idle for more than 2x timeout
        if (roundAge > TIMEOUT_MS * 2) {
          await cancelAbandonedGame(game.id, game.player1Id, game.player2Id!, game.wager);
          forfeited++;
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: { cleaned: forfeited, checked: games.length },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Cleanup failed" },
      { status: 500 },
    );
  }
}

async function forfeitPlayer(
  gameId: number,
  forfeiterId: string,
  winnerId: string,
  wager: number,
  winner: "player1" | "player2",
) {
  await db.transaction(async (tx: any) => {
    // Lock the row
    const [game] = await tx
      .select()
      .from(oddsGames)
      .where(eq(oddsGames.id, gameId))
      .for("update");

    if (!game || game.status !== "playing") return;

    // Persist the game-over state so refetches reflect the end.
    const forfeitedState = game.gameState
      ? { ...(game.gameState as any), gameOver: true, winner }
      : undefined;

    // The idle player's stake is forfeit and the opponent banks the pot, from
    // the escrow both seats paid at join.
    const payout = await payOddsPvpWinner({
      tx,
      gameId,
      winnerId,
      wager,
    });

    // Mark game as finished (forfeit)
    await tx
      .update(oddsGames)
      .set({
        status: "finished",
        winner,
        result: winner === "player1" ? "player1_won" : "player2_won",
        payout,
        ...(forfeitedState ? { gameState: forfeitedState } : {}),
        endedAt: new Date(),
      })
      .where(eq(oddsGames.id, gameId));

    // Leaderboard counters (fire-and-forget)
    applyLeaderboardCounters({
      clerkId: winnerId,
      game: "odds",
      outcome: "win",
      isPvpWin: true,
    }).catch(() => {});
    applyLeaderboardCounters({
      clerkId: forfeiterId,
      game: "odds",
      outcome: "loss",
    }).catch(() => {});

    // Per-game Elo — inactivity forfeit: the opponent wins, the idle player
    // records the loss. Both sides come from the game row, never the client.
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
  });
}

async function cancelAbandonedGame(
  gameId: number,
  player1Id: string,
  player2Id: string,
  wager: number,
) {
  await db.transaction(async (tx: any) => {
    const [game] = await tx
      .select()
      .from(oddsGames)
      .where(eq(oddsGames.id, gameId))
      .for("update");

    if (!game || game.status !== "playing") return;

    // Persist the game-over state so polls/refetches reflect the end.
    const cancelledState = game.gameState
      ? { ...(game.gameState as any), gameOver: true, winner: null }
      : undefined;

    // Nobody won, so neither stake is won: both go back to the seats that
    // paid them (a stake is never left stranded in the ledger), and the row is
    // closed in the same write.
    await voidUnsupportedOddsMatch({
      tx,
      gameId,
      wager,
      clerkIds: [player1Id, player2Id],
      previousState: cancelledState,
      result: "cancelled",
    });
  });
}
