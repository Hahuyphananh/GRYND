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

import { eq } from "drizzle-orm";
import { oddsGames } from "../../db/schema";
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

/**
 * Close a match that cannot produce a winner, in ONE terminal write.
 *
 * Two cases use it:
 *
 *   1. a row still carrying the RETIRED rules (no target in its `game_state`),
 *      which the current engine cannot resolve — refunding is the only honest
 *      end, and leaving it `playing` would strand both stakes;
 *   2. an exact tie after all five rounds (`result: "draw"`), where neither
 *      seat may be paid.
 *
 * The refund runs FIRST inside the caller's transaction, then the terminal row
 * is written with `winner: null`, `payout: 0`. Both halves are idempotent, and
 * the ledger's terminal-move guards make this mutually exclusive with a payout
 * on the same match: a stake can be returned or paid, never both.
 *
 * The state handed in is persisted verbatim (a tombstone for the audit trail),
 * so history stays inspectable.
 */
export async function voidUnsupportedOddsMatch({
  tx,
  gameId,
  wager,
  clerkIds,
  previousState,
  result = "cancelled",
}: {
  tx: any;
  gameId: number | string;
  wager: unknown;
  clerkIds: (string | null | undefined)[];
  /** State to persist on the terminal row (defaults to leaving it untouched). */
  previousState?: unknown;
  result?: "cancelled" | "draw";
}): Promise<number> {
  const refunded = await refundOddsPvpStakes({ tx, gameId, clerkIds, wager });

  await tx
    .update(oddsGames)
    .set({
      status: "finished",
      winner: null,
      result,
      payout: 0,
      ...(previousState !== undefined ? { gameState: previousState } : {}),
      endedAt: new Date(),
    })
    .where(eq(oddsGames.id, Number(gameId)));

  return refunded;
}
