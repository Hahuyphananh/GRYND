// src/lib/tokens/pvpPot.ts
//
// The shared pot arithmetic for a staked 1v1 match, so no game re-derives it:
//
//   pvpPotPayout  — what a win pays (the two escrowed stakes minus the shared
//                   house rake, i.e. 1.8× the winner's own stake at the
//                   current 10% rake). Pure, so display math and the coins that
//                   move can never drift apart.
//   payPvpPot     — credit the winner out of the escrow both seats paid,
//                   inside the caller's settlement transaction. Returns what
//                   the LEDGER actually applied (0 on a retry, on a match
//                   whose stakes were refunded, or on a seat that has no
//                   funding debit row — so a call can never invent coins).
//   refundPvpPot  — void a match: both stakes back to the seats that paid them.
//
// Games with their own module for this (`src/lib/rps-pvp/serverStore.js`,
// `src/lib/odds-pvp/serverStore.ts`) keep their exported names as thin
// wrappers over this file, so every game agrees on the same rules.

import { PVP_WINNER_SHARE } from "../games/economy";
import { refundMatchWagers, settlePayout } from "./wager";

/** What a win pays: the pot (both seats' stakes) minus the shared rake. */
export function pvpPotPayout(stake: unknown): number {
  const amount = Number(stake);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number((2 * amount * PVP_WINNER_SHARE).toFixed(2));
}

/** Credit the winner the pot. Call inside the match's settlement transaction. */
export async function payPvpPot({
  tx,
  gameKey,
  matchId,
  winnerClerkId,
  stake,
}: {
  tx: any;
  gameKey: string;
  matchId: unknown;
  winnerClerkId: string | null | undefined;
  stake: unknown;
}): Promise<number> {
  const payout = pvpPotPayout(stake);
  if (payout <= 0 || !winnerClerkId) return 0;
  // Annotated rather than inferred: `strict` is off in this project, where a
  // discriminated union is not narrowed by `if (!x.ok)`.
  const paid: { ok: boolean; applied?: boolean } = await settlePayout({
    clerkId: winnerClerkId,
    amount: payout,
    matchId,
    gameKey,
    tx,
  });
  return paid.ok && paid.applied ? payout : 0;
}

/** Void the match: both seats get their stake back (never more, never twice). */
export async function refundPvpPot({
  tx,
  gameKey,
  matchId,
  clerkIds,
  stake,
}: {
  tx: any;
  gameKey: string;
  matchId: unknown;
  clerkIds: (string | null | undefined)[];
  stake: unknown;
}): Promise<number> {
  const refunded: { ok: true; refunded: number } = await refundMatchWagers({
    clerkIds,
    stake: Number(stake),
    matchId,
    gameKey,
    tx,
  });
  return refunded.refunded;
}
