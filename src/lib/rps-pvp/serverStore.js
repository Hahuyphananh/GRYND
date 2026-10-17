// src/lib/rps-pvp/serverStore.js
//
// Shared server-side helpers for RPS PvP (best-of-7) matches.
// Extracted from the inline settlement in `/api/rps/pvp/forfeit`
// so the user-initiated forfeit route and the realtime-server
// disconnect-forfeit route settle identically — and now so the ROUND
// settlement (`/api/rps/pvp/choose`) pays the same pot through the same
// helper.
//
// TWO STAKES BUY THE POT: both seats are escrowed when the second player
// joins (`/api/rps/pvp/join`), and the winner is paid from that escrow on
// whichever path ends the match first — the deciding round or a forfeit.
// The pot math lives here (`rpsPvpPayout`) so the routes cannot disagree
// about what a win is worth.

import { db } from "../../db/client";
import { rpsPvpGames } from "../../db/schema";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { PVP_WINNER_SHARE } from "../games/economy";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { settlePayout } from "../tokens/wager";
import { eq } from "drizzle-orm";

/**
 * What a win pays: both seats' stakes (the pot) minus the shared house rake,
 * so a 2× pot pays 1.8× the winner's own stake at the current 10% rake. Pure,
 * so the display math in `/api/rps/pvp/status` can never drift from the coins
 * that actually move. A free match (wager 0) pays nothing.
 */
export function rpsPvpPayout(betAmount) {
  const stake = Number(betAmount);
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  return Number((2 * stake * PVP_WINNER_SHARE).toFixed(2));
}

/**
 * Credit the winner out of the escrow both seats paid at join. MUST run inside
 * the caller's settlement transaction, on the single terminal-write path, so
 * the coins commit with the result that earned them. Idempotent per
 * match+seat through the ledger, and a seat with no debit row (a legacy free
 * match, or one whose escrow never ran) is paid nothing rather than minted.
 * Returns the amount actually handed over.
 */
export async function payRpsPvpWinner({ tx, gameId, winnerId, betAmount }) {
  const payout = rpsPvpPayout(betAmount);
  if (payout <= 0 || !winnerId) return 0;
  const paid = await settlePayout({
    clerkId: winnerId,
    amount: payout,
    matchId: gameId,
    gameKey: "rps-pvp",
    tx,
  });
  // `applied` is what the LEDGER did: a retry, a VOIDED match, or a seat that
  // cannot be credited reports 0, so the routes never claim a payout that did
  // not happen.
  return paid.ok && paid.applied ? payout : 0;
}

// Forfeit an in-progress RPS PvP match. The forfeiter loses and the
// opponent banks the win (trophies + Elo) AND the pot: both seats were
// escrowed at join, and the forfeiter's stake is forfeit by definition.
// Only valid while the match is `matched` (both players joined); terminal
// matches are left untouched (so a forfeit can never pay twice); `active`
// (waiting) games are cancelled via the /cancel route instead — nothing was
// escrowed for those.
export async function forfeitRpsPvpGame({ userId, gameId }) {
  return await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(rpsPvpGames)
      .where(eq(rpsPvpGames.id, gameId))
      .for("update");

    if (!locked) return { error: "Game not found", status: 404 };
    if (locked.status === "finished" || locked.status === "cancelled") {
      return { error: "Game already finished", status: 400 };
    }
    if (locked.status !== "matched") {
      return { error: "Game is not in progress", status: 400 };
    }
    if (locked.player1Id !== userId && locked.player2Id !== userId) {
      return { error: "Forbidden", status: 403 };
    }

    // The forfeiter loses; the opponent wins the pot minus the rake.
    const forfeiterIsPlayer1 = locked.player1Id === userId;
    const winnerId = forfeiterIsPlayer1
      ? locked.player2Id
      : locked.player1Id;

    const betAmount = Number(locked.betAmount);

    const [finished] = await tx
      .update(rpsPvpGames)
      .set({
        player1Choice: null,
        player2Choice: null,
        outcome: forfeiterIsPlayer1 ? "player2" : "player1",
        winnerId,
        result: forfeiterIsPlayer1 ? "player2" : "player1",
        status: "finished",
        endedAt: new Date(),
      })
      .where(eq(rpsPvpGames.id, gameId))
      .returning();

    // Pay the winner inside the same transaction as the terminal write: the
    // row lock above makes this the only forfeit that can settle (a retry sees
    // `finished` and bails), and the payout rolls back with the result if the
    // credit fails.
    const winnerPayout = await payRpsPvpWinner({
      tx,
      gameId,
      winnerId,
      betAmount,
    });

    return {
      game: finished,
      winnerId,
      winnerPayout,
      forfeiterId: userId,
      betAmount,
    };
  });
}

// Best-effort leaderboard stats for a forfeited match. Failures are
// swallowed so they can never roll the settlement.
export function recordForfeitStats(result) {
  if (!result || !result.game) return;
  // The counters are driven by the explicit outcome: the opponent who stayed
  // banks a PvP win, the forfeiter takes a loss. Trophies/Elo are applied
  // separately below.
  applyLeaderboardCounters({
    clerkId: result.winnerId,
    game: "rps-pvp",
    outcome: "win",
    isPvpWin: true,
  }).catch(() => {});
  applyLeaderboardCounters({
    clerkId: result.forfeiterId,
    game: "rps-pvp",
    outcome: "loss",
  }).catch(() => {});

  // Per-game Elo — a competitive forfeit (the winner is the opponent who
  // stayed, resolved server-side in the settle transaction above). Runs on
  // its own transaction; the rating_events journal makes a replayed forfeit
  // (disconnect + poll, double submit) a no-op.
  applyRatingResult({
    gameKey: "rps-pvp",
    matchId: String(result.game.id),
    winnerClerkId: result.winnerId,
    loserClerkId: result.forfeiterId,
  }).catch(() => {});
  // Per-game trophies — the same authoritative forfeit (+30 / −30), on the
  // same idempotent path.
  applyTrophyResult({
    gameKey: "rps-pvp",
    matchId: String(result.game.id),
    winnerClerkId: result.winnerId,
    loserClerkId: result.forfeiterId,
  }).catch(() => {});
}
