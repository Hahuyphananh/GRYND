// src/lib/hex-duel/settle.ts
//
// ONE settlement for every way a Hex Duel match can end.
//
// Three routes finish a match — `/multiplayer/end` (the server's own replay
// found the winning capital capture), `/multiplayer/resign` (the losing seat
// conceded) and `/multiplayer/disconnect-forfeit` (the losing seat's grace
// window expired) — and all three must move money in exactly the same way.
// Duplicating "mark the row, pay the pot, count the stats" three times is how
// payouts drift, so it lives here once.
//
// The transaction belongs to the CALLER: this runs inside the transaction that
// claimed the match, so the coins commit with the result that earned them. The
// pot arithmetic itself is `payPvpPot` (src/lib/tokens/pvpPot.ts) — the shared
// 2 × stake × 90% at the platform's 10% rake — and the ledger refuses a payout
// with no funding debit, so this cannot mint coins.

import { eq, sql } from "drizzle-orm";
import { hexDuelGames, users } from "../../db/schema";
import { payPvpPot } from "../tokens/pvpPot";
import type { DuelPlayer } from "./rules";
import { hexDuelClerkInSeat } from "./authority";

type Tx = any;

export interface HexDuelSettleArgs {
  tx: Tx;
  game: {
    id: number;
    player1Id: string | null;
    player2Id: string | null;
    player1Moves?: number | null;
    player2Moves?: number | null;
    player1Territory?: number | null;
    player2Territory?: number | null;
    wagerAmount: unknown;
  };
  /** The seat the SERVER decided won this match. */
  winnerSeat: DuelPlayer;
  /** The seat whose client asked to finish (drives the row's `result` label). */
  callerSeat: DuelPlayer;
  /** Optional match statistics reported by the finishing client. */
  stats?: {
    player1Moves?: number;
    player2Moves?: number;
    player1Territory?: number;
    player2Territory?: number;
    durationSeconds?: number;
  };
}

export interface HexDuelSettleResult {
  payout: number;
  stake: number;
  winnerClerkId: string | null;
  callerWon: boolean;
  endedAt: Date;
}

/**
 * Finalise the match row, count both seats and pay the winner the pot.
 *
 * IDEMPOTENT BY CONSTRUCTION at the call sites: each route starts by checking
 * the row is not already `completed` inside the same transaction (and takes a
 * `SELECT … FOR UPDATE` on it), so this body runs once per match. `payPvpPot`
 * adds its own per-match ledger guard on top.
 */
export async function settleHexDuelMatch({
  tx,
  game,
  winnerSeat,
  callerSeat,
  stats,
}: HexDuelSettleArgs): Promise<HexDuelSettleResult> {
  const seats = { player1Id: game.player1Id, player2Id: game.player2Id };
  const loserSeat: DuelPlayer = winnerSeat === "player1" ? "player2" : "player1";
  const winnerClerkId = hexDuelClerkInSeat(seats, winnerSeat);
  const loserClerkId = hexDuelClerkInSeat(seats, loserSeat);
  const stake = Number(game.wagerAmount) || 0;
  const callerWon = winnerSeat === callerSeat;
  const endedAt = new Date();

  // Counters for BOTH seats: the winner's streak keeps running, the loser's
  // resets. This runs only in the call that finalises the row, so nothing is
  // counted twice.
  if (winnerClerkId) {
    await tx
      .update(users)
      .set({ gamesWon: sql`${users.gamesWon} + 1` })
      .where(eq(users.clerkId, winnerClerkId));
  }
  if (loserClerkId) {
    await tx
      .update(users)
      .set({ currentStreak: sql`0`, gamesLost: sql`${users.gamesLost} + 1` })
      .where(eq(users.clerkId, loserClerkId));
  }

  await tx
    .update(hexDuelGames)
    .set({
      winner: winnerSeat,
      result: callerWon ? "win" : "loss",
      player1Moves: stats?.player1Moves ?? game.player1Moves ?? 0,
      player2Moves: stats?.player2Moves ?? game.player2Moves ?? 0,
      player1Territory: stats?.player1Territory ?? game.player1Territory ?? 1,
      player2Territory: stats?.player2Territory ?? game.player2Territory ?? 1,
      durationSeconds: stats?.durationSeconds ?? 0,
      status: "completed",
      currentTurn: null,
      endedAt,
    })
    .where(eq(hexDuelGames.id, game.id));

  // The pot, out of the escrow both seats paid at join. Returns what the LEDGER
  // applied: 0 for a free match, a retry, or a seat with no funding row.
  let payout = 0;
  if (winnerClerkId) {
    payout = await payPvpPot({
      tx,
      gameKey: "hex-duel",
      matchId: game.id,
      winnerClerkId,
      stake,
    });
    if (payout > 0) {
      await tx
        .update(hexDuelGames)
        .set({ payout: payout.toFixed(2) })
        .where(eq(hexDuelGames.id, game.id));
    }
  }

  return { payout, stake, winnerClerkId, callerWon, endedAt };
}
