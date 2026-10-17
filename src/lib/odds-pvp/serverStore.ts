// src/lib/odds-pvp/serverStore.ts
//
// THE money rules for a staked Odds (PvP) match. Both seats are escrowed the
// moment the second player takes the seat (`/api/odds/join`), and the pot is
// paid on whichever path ends the match: the deciding round, an explicit
// forfeit, a timeout forfeit, or the inactivity cleanup. A match that ends
// without a winner — an exact tie, or a game both players walked away from —
// is VOIDED instead: both stakes come back, so no stake is ever stranded.
//
// Every route asks THIS file what a win is worth, so the number the UI
// displays (`/api/odds/pvp/status`) is always the number the ledger moves.
//
// The pot is the two stakes minus the shared house rake (`PVP_WINNER_SHARE`),
// i.e. 1.8× the winner's own stake at the current 10% rake. A free match
// (wager 0) moves nothing, and `settlePayout` independently refuses to credit
// a seat that has no funding debit row — so a legacy unmounted row can never
// mint coins.

import { PVP_WINNER_SHARE } from "../games/economy";
import { refundMatchWagers, settlePayout } from "../tokens/wager";

/** What a win pays: the pot (both seats' stakes) minus the shared rake. */
export function oddsPvpPayout(wager: unknown): number {
  const stake = Number(wager);
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  return Number((2 * stake * PVP_WINNER_SHARE).toFixed(2));
}

/**
 * Credit the winner out of the escrow both seats paid at join.
 *
 * MUST run inside the caller's settlement transaction, on the single terminal
 * write for that match, so the coins commit with (or roll back with) the
 * result that earned them. Returns the amount actually handed over.
 */
export async function payOddsPvpWinner({
  tx,
  gameId,
  winnerId,
  wager,
}: {
  tx: any;
  gameId: number | string;
  winnerId: string | null | undefined;
  wager: unknown;
}): Promise<number> {
  const payout = oddsPvpPayout(wager);
  if (payout <= 0 || !winnerId) return 0;
  // Annotated rather than inferred: `strict` is off in this project, where a
  // discriminated union is not narrowed by `if (!x.ok)`. `applied` is what the
  // LEDGER did — a retry, a refunded match or a seat paid before all report 0.
  const paid: { ok: boolean; applied?: boolean } = await settlePayout({
    clerkId: winnerId,
    amount: payout,
    matchId: gameId,
    gameKey: "odds-pvp",
    tx,
  });
  return paid.ok && paid.applied ? payout : 0;
}

/**
 * Void the match: both seats get their stake back. Used for a match that ended
 * without a winner (an exact tie, or an abandoned game reclaimed by the
 * cleanup sweep). `refundMatchWagers` skips a seat that was never charged and
 * one that was already paid, so calling it on a free or half-settled match is
 * safe — it can never credit a stake twice.
 */
export async function refundOddsPvpStakes({
  tx,
  gameId,
  clerkIds,
  wager,
}: {
  tx: any;
  gameId: number | string;
  clerkIds: (string | null | undefined)[];
  wager: unknown;
}): Promise<number> {
  const refunded: { ok: true; refunded: number } = await refundMatchWagers({
    clerkIds,
    stake: Number(wager),
    matchId: gameId,
    gameKey: "odds-pvp",
    tx,
  });
  return refunded.refunded;
}
