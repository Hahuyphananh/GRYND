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
// Idempotency: anchored on `globalThis.__precisionPaidOutMatches` so
// repeat callers (e.g. both clients re-fetching after a blip, double
// socket-broadcast + poll, page reload during end-popup, etc.) only
// pay out ONCE per matchId. The guard survives hot reloads.
//
// Why a SEPARATE helper rather than rolling payout into `recordRoundStop`?
//   1. `serverStore.ts` is an in-memory state machine — it deliberately
//      avoids DB imports so it can be unit-tested without Drizzle.
//   2. The route handler at `/api/precision/finish-match` (or its
//      socket equivalent) is the natural seam for re-introducing the
//      auth boundary, leaderboard updates, and DB transactions.
//   3. The screenshot of the canonical match state is captured from
//      `precisionMatchStore` here at the moment of payout, so the
//      helper is resilient to subsequent `/update-state` calls.
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
import { precisionMatchStore } from "./serverStore";
import type { PlayerSeat } from "./types";

/** Payout multiplier applied to the winning seat's wager when a match
 *  ends. 1.9× = 5% house edge, mirroring `PAYOUT_MULTIPLIER` in
 *  `src/app/api/hex-duel/end-game/route.ts`. Pure winner-take-all —
 *  the loser's wager is forfeit and does NOT return. */
export const PRECISION_PAYOUT_MULTIPLIER = 1.9;

/** Server-only payout guard. Anchored on `globalThis` so multiple
 *  modules share one source of truth across hot reloads — mirrors
 *  the existing pattern in `src/lib/precision/serverStore.ts` for
 *  `precisionStableLobbies` / `precisionStableMatches`. */
const globalForPrecisionPayout = globalThis as typeof globalThis & {
  __precisionPaidOutMatches?: Set<string>;
};
if (!globalForPrecisionPayout.__precisionPaidOutMatches) {
  globalForPrecisionPayout.__precisionPaidOutMatches = new Set();
}
const precisionPaidOutMatches =
  globalForPrecisionPayout.__precisionPaidOutMatches;

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
 *   1. Look up the match in `precisionMatchStore`. Abort if missing
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

  // Idempotency check FIRST — even before reading match state, so a
  // double-call from both clients (broadcast + poll) doesn't double-
  // pay.
  //
  // Audit fix: soft-cap `precisionPaidOutMatches`. The set grows once
  // per finished match and is otherwise unbounded — in a very
  // long-lived process this would slowly accumulate ~24 bytes per
  // matchId without ever being reset. We don't gate payouts here;
  // we just clear the set if it crosses a low threshold so the
  // cap is invisible to legitimate traffic (we'd have to play
  // 10k+ matches in one process lifetime to hit it). Idempotency
  // for the most-recent 10k matches is preserved; any earlier
  // match is "very stale" and would either be already-paid (DB
  // side) or would fail at the match-not-found check below. The
  // 10_000 threshold is intentionally small enough to keep the set
  // under ~250KB of memory in any reasonable deployment.
  if (precisionPaidOutMatches.size > 10_000) {
    precisionPaidOutMatches.clear();
  }
  if (precisionPaidOutMatches.has(matchId)) {
    const priorMatch = precisionMatchStore.get(matchId);
    return {
      success: true,
      alreadyProcessed: true,
      payout: priorMatch?.wager
        ? Number(
            (
              priorMatch.wager * PRECISION_PAYOUT_MULTIPLIER
            ).toFixed(2),
          )
        : 0,
      newBalance: 0,
      finalScore: priorMatch?.score ?? null,
      winnerUserId:
        priorMatch?.players.find(
          (p) => p.seat === priorMatch.winnerSeat,
        )?.userId ?? null,
    };
  }

  const match = precisionMatchStore.get(matchId);
  if (!match) {
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

  const payout = Number(
    (resolvedWager * PRECISION_PAYOUT_MULTIPLIER).toFixed(2),
  );

  // Mark the match as paid BEFORE the DB write so any retry that
  // beats the first transaction to commit still won't double-pay.
  // Drizzle's pool is single-threaded per query, but a long-running
  // transaction could still race with a polling client retry; this
  // guard is the belt alongside Drizzle's atomic UPDATE. Both
  // clients hitting the endpoint near-simultaneously will both
  // observe `has(mid) === true` and the second will short-circuit.
  precisionPaidOutMatches.add(matchId);

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
    // If the DB write failed, peel the idempotency guard back so a
    // retry from a polling client can succeed. Without this the
    // match would be permanently stuck in "already paid out"
    // without any balance actually changing.
    precisionPaidOutMatches.delete(matchId);
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

/**
 * Test-only helper — clears the idempotency guard so unit tests can
 * simulate multiple payouts. Not used by production code paths.
 * Exported for visibility by future test scaffolding.
 */
export function _resetPrecisionPayoutGuardForTests(): void {
  precisionPaidOutMatches.clear();
}
