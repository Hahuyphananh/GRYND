// ── Server-side payout helper for the Precision PvP casino game ─────────
//
// Mirror of the Hex Duel `/api/hex-duel/multiplayer/end` route pattern
// (`src/app/api/hex-duel/multiplayer/end/route.ts`). Specifically:
//   * Updates `users.balance += payout` via Drizzle ORM `sql` template.
//   * Increments `gamesWon` on the winner, `currentStreak = 0` and
//     `gamesLost += 1` on the loser.
//   * Calls `applyLeaderboardCounters({ game: "Precision", ... })` so
//     weekly / monthly leaderboards stay consistent with how every
//     other PvP game (Uno, Hex Duel, Pool, Chess) contributes.
//   * Records a big-win entry if the payout crosses the 1M token
//     threshold via `recordBigWinIfNeeded`.
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
//      (balances, stats, leaderboards, prestige) stays out of it.
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
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { recordBigWinIfNeeded } from "../bigWins";
import { applyPrestigeResult } from "../prestige";
import { claimPayout, readMatch, releasePayoutClaim } from "./serverStore";
import type { PlayerSeat } from "./types";

/** Payout multiplier applied to the winning seat's wager when a match
 *  ends. 1.9× = 5% house edge, mirroring `PAYOUT_MULTIPLIER` in
 *  `src/app/api/hex-duel/end-game/route.ts`. Pure winner-take-all —
 *  the loser's wager is forfeit and does NOT return. */
export const PRECISION_PAYOUT_MULTIPLIER = 1.9;

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
 *        - SELECT winner row for an accurate post-update balance.
 *        - `UPDATE users SET balance = balance + payout, gamesWon += 1`
 *          on the winner.
 *        - `UPDATE users SET currentStreak = 0, gamesLost += 1` on
 *          the loser.
 *   4. Fire-and-forget leaderboard counters (no await so a no-op
 *      leaderboard failure can't stall the response).
 *   5. If the payout exceeds `1_000_000` tokens, register a big-win
 *      entry outside the transaction.
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
  const resolvedWager = Number(
    args.wager ?? match.wager ?? 0,
  );
  if (!Number.isFinite(resolvedWager) || resolvedWager <= 0) {
    return {
      success: false,
      alreadyProcessed: false,
      payout: 0,
      newBalance: 0,
      finalScore: match.score ?? null,
      winnerUserId: null,
      reason: "Wager is invalid",
    };
  }

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

  // ── Atomic balance + stat update ─────────────────────────────────
  // We grab the winner's row first so we can return an accurate
  // post-update balance. Both updates target distinct rows so they
  // don't need to live in a single transaction, but we wrap them
  // together for atomicity anyway (matches Hex Duel's posture).
  let newBalance = 0;
  try {
    await db.transaction(async (tx) => {
      const [winnerRow] = await tx
        .update(users)
        .set({
          balance: sql`${users.balance} + ${payout}`,
          gamesWon: sql`${users.gamesWon} + 1`,
        })
        .where(eq(users.clerkId, winnerPlayer.userId))
        .returning({ balance: users.balance });
      newBalance = Number(winnerRow?.balance ?? 0);

      await tx
        .update(users)
        .set({
          currentStreak: sql`0`,
          gamesLost: sql`${users.gamesLost} + 1`,
        })
        .where(eq(users.clerkId, loserPlayer.userId));
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
    betAmount: resolvedWager,
    payout,
    isPvpWin: true,
  }).catch((err) => {
    console.error("[precision] leaderboard (winner) failed:", err);
  });
  applyLeaderboardCounters({
    clerkId: loserPlayer.userId,
    game: "Precision",
    betAmount: resolvedWager,
    payout: 0,
  }).catch((err) => {
    console.error("[precision] leaderboard (loser) failed:", err);
  });

  // Permanent Prestige — server-authoritative PvP hook. AI matches never
  // reach this point (isAiGame short-circuits above), and the
  // precisionPaidOutMatches guard means a match pays out only once, so
  // this can never double-apply. Fire-and-forget like the leaderboard
  // side-effects above; the prestige_results journal keeps the event
  // idempotent regardless.
  applyPrestigeResult({
    clerkId: winnerPlayer.userId,
    outcome: "win",
    source: "precision",
    sourceId: matchId,
  }).catch((err) => {
    console.error("[precision] prestige (winner) failed:", err);
  });
  applyPrestigeResult({
    clerkId: loserPlayer.userId,
    outcome: "loss",
    source: "precision",
    sourceId: matchId,
  }).catch((err) => {
    console.error("[precision] prestige (loser) failed:", err);
  });

  if (payout >= 1_000_000) {
    recordBigWinIfNeeded({
      userId: winnerPlayer.userId,
      username: winnerPlayer.name || "Player",
      game: "Precision",
      betAmount: resolvedWager,
      winAmount: payout,
      multiplier: PRECISION_PAYOUT_MULTIPLIER,
    }).catch((err) => {
      console.error("[precision] big-win record failed:", err);
    });
  }

  return {
    success: true,
    alreadyProcessed: false,
    payout,
    newBalance,
    finalScore: match.score ?? null,
    winnerUserId: winnerPlayer.userId,
  };
}

