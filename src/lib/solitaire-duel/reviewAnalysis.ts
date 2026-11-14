// src/lib/solitaire-duel/reviewAnalysis.ts
//
// THE ONE DOOR TO A GAME REVIEW ANALYSIS — cache first, allowance second,
// engine last.
//
// Both review routes (solo/daily and duel) used to call
// `loadOrComputeAnalysis` directly, which meant an unlimited number of deep
// analyses per account. They now call this module, which applies the GRYND PRO
// rule in the right order:
//
//   1. CACHE HIT  → the analysis is already stored for this exact game + log +
//                   engine version. Serve it and consume NOTHING. Re-opening a
//                   game, refreshing, or opening it on another device is free.
//   2. CACHE MISS → take one fresh analysis from today's allowance
//                   (src/lib/solitaire-duel/analysisAllowance.ts). The free plan
//                   gets FREE_ANALYSES_PER_DAY; a PRO member is unlimited and is
//                   never written to the usage table.
//   3. DENIED     → return no analysis plus the allowance, so the surface can
//                   say "3 of 3 used today" and point at the upgrade page. The
//                   game itself stays fully reviewable: the deal and the log are
//                   still served, only the scored analysis is withheld.
//   4. ALLOWED    → compute (or read a racing twin's row) and store it, exactly
//                   as before.
//
// THE LIMIT IS NEVER TRUSTED FROM THE CLIENT. `playerId` comes from Clerk or the
// signed guest cookie in the route, and PRO status comes from
// `getMembershipTier` on the server — never from a header, body or flag.

import { getMembershipTier } from "../stripe/subscriptions";

import {
  analysisCacheIdentity,
  loadOrComputeAnalysis,
  readCachedAnalysis,
  type AnalysisCacheDeps,
  type AnalysisCacheIdentity,
} from "./analysisCache";
import {
  consumeAnalysisAllowance,
  readAnalysisAllowance,
  type AnalysisAllowance,
  type AnalysisAllowanceDeps,
} from "./analysisAllowance";
import type { GameAnalysis } from "./analysis";
import type { ReviewGameKind } from "./review";
import type { CanonicalMoveLogEntry } from "./soloPersistence";
import type { SolitaireDeal } from "./types";

export type ReviewAnalysis = {
  /** The analysis, or null when the day's allowance is spent (or unusable). */
  readonly analysis: GameAnalysis | null;
  /** True when the analysis came from the cache (costs no allowance). */
  readonly cached: boolean;
  /** True only when a free account's daily allowance is spent. */
  readonly limited: boolean;
  readonly allowance: AnalysisAllowance;
};

export type ReviewAnalysisDeps = AnalysisCacheDeps &
  AnalysisAllowanceDeps & {
    /** PRO resolution seam (tests); production reads the subscription row. */
    isPro?: (playerId: string) => Promise<boolean>;
  };

/** Server-side PRO check; an unreadable membership means "free". */
async function resolveIsPro(
  playerId: string,
  isGuest: boolean,
  deps: ReviewAnalysisDeps,
): Promise<boolean> {
  if (isGuest) return false;
  try {
    const resolve = deps.isPro ?? (async (id: string) => (await getMembershipTier(id)) === "pro");
    return await resolve(playerId);
  } catch {
    return false;
  }
}

export async function loadReviewAnalysis(
  {
    gameKind,
    gameId,
    logDigest,
    deal,
    moves,
    playerId,
    isGuest = false,
    now = new Date(),
  }: {
    gameKind: ReviewGameKind;
    gameId: string;
    /** SHA-256 of the caller's own canonical log, computed by the route. */
    logDigest: string;
    deal: SolitaireDeal;
    moves: readonly CanonicalMoveLogEntry[];
    /** The authenticated (or signed guest) identity — never a query param. */
    playerId: string;
    isGuest?: boolean;
    now?: Date;
  },
  deps: ReviewAnalysisDeps = {},
): Promise<ReviewAnalysis> {
  const isPro = await resolveIsPro(playerId, isGuest, deps);

  const identity: AnalysisCacheIdentity | null = analysisCacheIdentity({
    gameKind,
    gameId,
    logDigest,
  });

  let cachedAnalysis: GameAnalysis | null = null;
  if (identity) {
    try {
      cachedAnalysis = await (deps.read ?? readCachedAnalysis)(identity);
    } catch {
      // A cache outage is not a cache hit: fall through to the allowance.
      cachedAnalysis = null;
    }
  }

  if (cachedAnalysis) {
    // Re-viewing an analysed game is free — read the allowance for display only.
    const allowance = await readAnalysisAllowance(
      { playerId, isPro, now },
      deps,
    );
    return { analysis: cachedAnalysis, cached: true, limited: false, allowance };
  }

  const gate = await consumeAnalysisAllowance({ playerId, isPro, now }, deps);
  if (!gate.allowed) {
    return { analysis: null, cached: false, limited: true, allowance: gate.allowance };
  }

  const loaded = await loadOrComputeAnalysis(
    { gameKind, gameId, logDigest, deal, moves },
    deps,
  );

  return {
    analysis: loaded.analysis,
    cached: loaded.cached,
    limited: false,
    allowance: gate.allowance,
  };
}
