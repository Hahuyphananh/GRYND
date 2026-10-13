// ── Server-side payout helper for the Precision PvP casino game ─────────
//
// Mirror of the Hex Duel `/api/hex-duel/multiplayer/end` route pattern
// (`src/app/api/hex-duel/multiplayer/end/route.ts`). Specifically:
//   * Increments `gamesWon` on the winner, `currentStreak = 0` and
//     `gamesLost += 1` on the loser.
//   * Credits the winner the pot minus the house rake
//     (`PRECISION_PAYOUT_MULTIPLIER`) out of the escrow both seats paid at
//     pairing, through `settlePayout`.
//   * Calls `applyLeaderboardCounters({ game: "Precision", ... })` so
//     weekly / monthly leaderboards stay consistent with how every
//     other PvP game (Uno, Hex Duel, Pool, Chess) contributes.
//
// Idempotency: anchored on the match row's `payout_processed_at` column,
// claimed under `SELECT ... FOR UPDATE` (see `claimPayout` in serverStore),
// so repeat callers (both clients re-fetching after a blip, double
// socket-broadcast + poll, page reload during end-popup, a retry after the
// instance that settled the match died) only pay out ONCE per matchId. The
// previous in-process `globalThis` Set could not do that on a serverless
// deploy, where the two callers routinely land on different instances.
//
// Why a SEPARATE helper rather than rolling payout into `recordRoundStop`?
//   1. `recordRoundStop` is the latency-critical gameplay path — settlement
//      (balances, stats, leaderboards, Elo/trophies) stays out of it.
//   2. The route handler at `/api/precision/finish-match` (or its
//      socket equivalent) is the natural seam for re-introducing the
//      auth boundary, leaderboard updates, and DB transactions.
//   3. The canonical match row is read (and its payout claim stamped) here at
//      the moment of payout, so the helper is resilient to later state
//      writes and to a retry after the settling instance died.
//
// This helper does NOT mutate `users` rows that are owned by other
// games' code paths. It only touches the shared `balance`,
// `gamesWon`, `gamesLost`, `currentStreak` columns — every PvP
// game's payout helper already touches those same columns by
// design, so no schema migration is required and no other game's
// flow is affected.

import { and, eq, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { users } from "../../db/schema";
import { PVP_WINNER_SHARE } from "../games/economy";
import { settlePayout } from "../tokens/wager";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { claimPayout, readMatch, releasePayoutClaim } from "./serverStore";
import { normalizeStake } from "../games/stakes";
import type { PlayerSeat } from "./types";

/** Payout multiplier applied to the winning seat's wager when a match
 *  ends: the whole pot (both seats' stakes) minus the shared house rake, so
 *  2 × (1 − PVP_RAKE_PCT) = 1.9× at the current 5% rake. Derived from the
 *  shared rake rather than a second local constant, so the two can never
 *  drift apart. Pure winner-take-all — the loser's wager is forfeit and does
 *  NOT return. */
export const PRECISION_PAYOUT_MULTIPLIER = 2 * PVP_WINNER_SHARE;

export interface ProcessMatchFinishedPayoutArgs {
  matchId: string;
  /** Optional overrides — by default the helper resolves winnerSeat /
   *  wager from the canonical match state. The args are exposed so
   *  callers can short-circuit if they already have the data. */
  winnerSeat?: PlayerSeat;
  wager?: number;
}

export interface ProcessMatchFinishedPayoutResult {
  success: boolean;
  /** True when the request is a no-op because payout was already
   *  processed for this matchId (idempotency). */
  alreadyProcessed: boolean;
  payout: number;
  /** New balance of the winning seat (0 if no payout or already
   *  processed). */
  newBalance: number;
  /** Final settled score. */
  finalScore: { seat1: number; seat2: number } | null;
  /** UserId of the seat that took the match. */
  winnerUserId: string | null;
  reason?:
    | "Match not found"
    | "Match has no winner yet"
    | "No players in match"
    | "Wager is invalid";
}

/**
 * Idempotently transfers the winner's payout for a finished Precision
 * match. Mirrors Hex Duel's settlement flow:
 *
 *   1. Look up the match row in `precision_matches`. Abort if missing
 *      or if `winnerSeat` is null (should never happen since callers
 *      only invoke this on `phase === "finished"`).
 *   2. Compute `payout = wager × PRECISION_PAYOUT_MULTIPLIER`. Clamp
 *      to a minimum of 0 to stay safe against negative/NaN wagers.
 *   3. Atomic Drizzle transaction:
 *        - `UPDATE users SET gamesWon += 1` on the winner.
 *        - `UPDATE users SET currentStreak = 0, gamesLost += 1` on
 *          the loser.
 *        - credit the winner's prize through `settlePayout` — the same
 *          transaction, so the coins commit with the result that earned
 *          them. A free match (wager 0) moves nothing.
 *   4. Fire-and-forget leaderboard counters (no await so a no-op
 *      leaderboard failure can't stall the response).
 *
 * Returns `{ alreadyProcessed: true }` if the matchId has already
 * been paid out — callers can use this to deduplicate retry traffic
 * without losing the response shape.
 */
export async function processMatchFinishedPayout(
  args: ProcessMatchFinishedPayoutArgs,
): Promise<ProcessMatchFinishedPayoutResult> {
  const matchId = String(args?.matchId ?? "");
  if (!matchId) {
    return {
      success: false,
      alreadyProcessed: false,
      payout: 0,
      newBalance: 0,
      finalScore: null,
      winnerUserId: null,
      reason: "Match not found",
    };
  }

  // Read the persisted row FIRST — the match has to look payable before we
  // claim the payout. Claiming first would permanently mark a merely
  // unfinished match as paid, and the legitimate retry could then never pay.
  const row = await readMatch(matchId);
  if (!row) {
    return {
      success: false,
      alreadyProcessed: false,
      payout: 0,
      newBalance: 0,
      finalScore: null,
      winnerUserId: null,
      reason: "Match not found",
    };
  }
  const match = row.state;
  if (match.winnerSeat === null) {
    return {
      success: false,
      alreadyProcessed: false,
      payout: 0,
      newBalance: 0,
      finalScore: match.score ?? null,
      winnerUserId: null,
      reason: "Match has no winner yet",
    };
  }
  if (!Array.isArray(match.players) || match.players.length < 2) {
    return {
      success: false,
      alreadyProcessed: false,
      payout: 0,
      newBalance: 0,
      finalScore: match.score ?? null,
      winnerUserId: null,
      reason: "No players in match",
    };
  }

  // Resolve authoritatively from serverStore. The page can OPTIONALLY
  // pass overrides so callers with already-resolved data skip a stale
  // lookup, but the canonical path always uses serverStore because it
  // is the only source of truth for `winnerSeat` and `wager`.
  const resolvedWinnerSeat: PlayerSeat | null =
    (args.winnerSeat ?? match.winnerSeat) as PlayerSeat | null;
  if (resolvedWinnerSeat === null) {
    return {
      success: false,
      alreadyProcessed: false,
      payout: 0,
      newBalance: 0,
      finalScore: match.score ?? null,
      winnerUserId: null,
      reason: "Match has no winner yet",
    };
  }
  // A stored wager is always a legal one (`normalizeStake` truncates it to
  // whole coins and clamps it to the game's ceiling); 0 means a free match,
  // which is what a practice / AI row carries.
  const resolvedWager = normalizeStake(args.wager ?? match.wager ?? 0);

  const winnerPlayer = match.players.find(
    (p) => p.seat === resolvedWinnerSeat,
  );
  const loserPlayer = match.players.find(
    (p) => p.seat !== resolvedWinnerSeat,
  );
  if (!winnerPlayer || !loserPlayer) {
    return {
      success: false,
      alreadyProcessed: false,
      payout: 0,
      newBalance: 0,
      finalScore: match.score ?? null,
      winnerUserId: winnerPlayer?.userId ?? null,
      reason: "No players in match",
    };
  }

  // Free AI matches still pass through the finished-match endpoint so
  // the result UI has one canonical path, but they never touch balances,
  // wagered stats, leaderboards, or payout records.
  if (match.isAiGame) {
    // Nothing to claim: no balance, no stat, no leaderboard row moves, so
    // repeating this call is harmless.
    return {
      success: true,
      alreadyProcessed: false,
      payout: 0,
      newBalance: 0,
      finalScore: match.score ?? null,
      winnerUserId: winnerPlayer.userId,
    };
  }

  // The winner takes the pot minus the house rake out of the escrow both
  // seats paid when the lobby paired (see `createMatchForPairing`). A free
  // match — or a stub row whose wager never funded — pays nothing, and
  // `settlePayout` independently refuses to credit a seat with no debit row.
  const payout = Number(
    (resolvedWager * PRECISION_PAYOUT_MULTIPLIER).toFixed(2),
  );

  // ── Claim the payout ─────────────────────────────────────────────
  // Stamps `payout_processed_at` inside a `SELECT ... FOR UPDATE`
  // transaction. Exactly one caller — across instances — wins the claim;
  // the loser reports the same result with `alreadyProcessed: true`, so two
  // clients hitting the endpoint simultaneously still render identically and
  // the balance moves once.
  const claim = await claimPayout(matchId);
  if (!claim.claimed) {
    return {
      success: true,
      alreadyProcessed: true,
      payout,
      newBalance: 0,
      finalScore: match.score ?? null,
      winnerUserId: winnerPlayer.userId,
    };
  }

  // ── Atomic stat update ───────────────────────────────────────────
  // Stakes are retired, so only the win/loss counters move. Both updates
  // target distinct rows and are wrapped together for atomicity.
  let newBalance = 0;
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          gamesWon: sql`${users.gamesWon} + 1`,
        })
        .where(eq(users.clerkId, winnerPlayer.userId));

      await tx
        .update(users)
        .set({
          currentStreak: sql`0`,
          gamesLost: sql`${users.gamesLost} + 1`,
        })
        .where(eq(users.clerkId, loserPlayer.userId));

      // The balance move rides the same transaction as the win/loss counters,
      // so the prize commits with the result that earned it (and rolls back
      // with it if anything here fails). Idempotent per match+seat through the
      // ledger's `(reference_type, reference_id)` key.
      if (payout > 0) {
        // Annotated: `strict` is off in this project, where `if (!x.ok)` does
        // not narrow a discriminated union (see the tower-arena call site).
        const paid: { ok: boolean; balance?: number } = await settlePayout({
          clerkId: winnerPlayer.userId,
          amount: payout,
          matchId,
          gameKey: "precision",
          tx,
        });
        if (paid.ok) newBalance = paid.balance;
      }
    });
  } catch (err) {
    // If the DB write failed, release the claim so a retry from a polling
    // client can win it again. Without this the match would stay marked as
    // paid without any balance having moved.
    await releasePayoutClaim(matchId);
    console.error("[precision] payout transaction failed:", err);
    return {
      success: false,
      alreadyProcessed: false,
      payout: 0,
      newBalance: 0,
      finalScore: match.score ?? null,
      winnerUserId: winnerPlayer.userId,
    };
  }

  // ── Leaderboard + big-win side effects (fire-and-forget) ────────
  // Outside the main transaction because the leaderboard helper uses
  // its own connection pool, and these tables can be slow without
  // blocking the user's payout response.
  applyLeaderboardCounters({
    clerkId: winnerPlayer.userId,
    game: "Precision",
    outcome: "win",
    isPvpWin: true,
  }).catch((err) => {
    console.error("[precision] leaderboard (winner) failed:", err);
  });
  applyLeaderboardCounters({
    clerkId: loserPlayer.userId,
    game: "Precision",
    outcome: "loss",
  }).catch((err) => {
    console.error("[precision] leaderboard (loser) failed:", err);
  });

  // Per-game Elo — both seats come from the canonical match row and the
  // winner from `winnerSeat` (never a client value). This runs on the same
  // claim-guarded path as everything else above, so a retry from the other
  // client cannot move a rating twice; the rating_events journal backs that
  // up independently.
  applyRatingResult({
    gameKey: "precision",
    matchId,
    winnerClerkId: winnerPlayer.userId,
    loserClerkId: loserPlayer.userId,
  }).catch((err) => {
    console.error("[precision] rating update failed:", err);
  });

  // Per-game trophies — the same authoritative result (+30 / −30). AI matches
  // never reach this point (isAiGame short-circuits above) and the payout
  // claim guard means a match settles only once, so this cannot double-apply;
  // the trophy_events journal keeps it idempotent regardless.
  applyTrophyResult({
    gameKey: "precision",
    matchId,
    winnerClerkId: winnerPlayer.userId,
    loserClerkId: loserPlayer.userId,
  }).catch((err) => {
    console.error("[precision] trophy update failed:", err);
  });

  return {
    success: true,
    alreadyProcessed: false,
    payout,
    newBalance,
    finalScore: match.score ?? null,
    winnerUserId: winnerPlayer.userId,
  };
}

