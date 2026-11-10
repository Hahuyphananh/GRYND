// src/lib/solitaire-duel/analysisCache.ts
//
// ONE CACHED GAME REVIEW ANALYSIS, keyed by the game and the exact canonical
// move log and the engine version.
//
// WHY THIS EXISTS. The Phase 4 review computed the analysis in a browser
// worker on every visit. The result is deterministic and depends only on
// `{deal, moves}` plus the engine version, so paying for it again after a
// refresh (or on a second device) is wasted CPU. This module stores that one
// result in Postgres and the review routes return it.
//
// THE IDENTITY IS THE CONSTRAINT. A cached row is addressable only by:
//
//   game_kind        duel | solo | daily
//   game_id          the match / result id
//   log_digest       SHA-256 of the canonical ordered log (server-computed)
//   engine_version   ANALYSIS_VERSION, bumped whenever scoring changes
//
// A row is therefore unusable if the move log OR the engine version changes:
// both are part of the key, and the unique index makes a duplicate record
// impossible. `onConflictDoUpdate` converges two concurrent cold requests on
// one row; whichever computed second rewrites the same deterministic bytes.
//
// WHAT IS STORED. `compactAnalysis()` copies only the analysis itself: per-move
// ply/kind/rating/tags/scores/regret/eligibility/reason codes, the key moments,
// and the summary. It never stores the deal, the move log, a board snapshot, or
// any prose — commentary still comes from the translation templates.
//
// FAILURE IS NEVER FATAL. The cache is an optimisation: a read or write error
// is swallowed and the caller falls back to computing the analysis (or, if the
// engine refuses the log, to no analysis at all). A failed write leaves no row,
// so the next review retries it. Nothing here writes Elo, trophies, rewards,
// settlement, leaderboards or the move history.

import { and, eq, ne, or } from "drizzle-orm";

import { db } from "../../db/client";
import { solitaireAnalysisCache } from "../../db/schema";
import {
  ANALYSIS_VERSION,
  analyzeSolitaireGame,
  type GameAnalysis,
} from "./analysis";
import type { ReviewGameKind } from "./review";
import type { CanonicalMoveLogEntry } from "./soloPersistence";
import type { SolitaireDeal } from "./types";

const GAME_KINDS: readonly ReviewGameKind[] = Object.freeze(["duel", "solo", "daily"]);
const DIGEST = /^[0-9a-f]{64}$/;

export type AnalysisCacheIdentity = {
  readonly gameKind: ReviewGameKind;
  readonly gameId: string;
  /** SHA-256 of the canonical ordered log. */
  readonly logDigest: string;
  /** ANALYSIS_VERSION the analysis was produced by. */
  readonly engineVersion: number;
};

/**
 * Normalise a cache identity, or null when it cannot address a row.
 *
 * The digest must be a full SHA-256 because it is the move-log identity: a
 * truncated or arbitrary value could collide two different games onto one
 * cached result. The version must be a positive integer.
 */
export function analysisCacheIdentity({
  gameKind,
  gameId,
  logDigest,
  engineVersion = ANALYSIS_VERSION,
}: {
  gameKind: unknown;
  gameId: unknown;
  logDigest: unknown;
  engineVersion?: unknown;
}): AnalysisCacheIdentity | null {
  if (!GAME_KINDS.includes(gameKind as ReviewGameKind)) return null;
  if (typeof gameId !== "string" || gameId.trim() === "" || gameId.length > 64) {
    return null;
  }
  if (typeof logDigest !== "string" || !DIGEST.test(logDigest)) return null;
  if (
    typeof engineVersion !== "number" ||
    !Number.isInteger(engineVersion) ||
    engineVersion < 1
  ) {
    return null;
  }
  return {
    gameKind: gameKind as ReviewGameKind,
    gameId,
    logDigest,
    engineVersion,
  };
}

/**
 * The compact, JSON-safe analysis payload.
 *
 * Built field by field rather than by storing the object as handed in: a future
 * field on `GameAnalysis` must be added here deliberately, so a board snapshot
 * or a log could never start riding along implicitly. No commentary text exists
 * in this shape.
 */
export function compactAnalysis(analysis: GameAnalysis): GameAnalysis {
  return {
    version: analysis.version,
    reconstructable: analysis.reconstructable,
    complete: analysis.complete,
    rejectedAt: analysis.rejectedAt,
    perMove: (analysis.perMove ?? []).map((move) => ({
      ply: move.ply,
      kind: move.kind,
      rating: move.rating,
      tags: [...(move.tags ?? [])],
      scoreBefore: move.scoreBefore,
      scoreAfter: move.scoreAfter,
      delta: move.delta,
      regret: move.regret,
      commentaryEligible: move.commentaryEligible,
      reasonCodes: [...(move.reasonCodes ?? [])],
    })),
    moments: (analysis.moments ?? []).map((moment) => ({
      ply: moment.ply,
      rating: moment.rating,
      tags: [...(moment.tags ?? [])],
      reasonCodes: [...(moment.reasonCodes ?? [])],
    })),
    summary: {
      movesAnalyzed: analysis.summary.movesAnalyzed,
      ratings: { ...analysis.summary.ratings },
      accuracy: analysis.summary.accuracy,
      totalRegret: analysis.summary.totalRegret,
      averageRegret: analysis.summary.averageRegret,
      deepSearchMoves: analysis.summary.deepSearchMoves,
      informationFair: true,
    },
  };
}

/** A stored row is usable only when it belongs to the requested engine version. */
function isStoredAnalysis(
  value: unknown,
  engineVersion: number
): value is GameAnalysis {
  if (!value || typeof value !== "object") return false;
  const stored = value as Partial<GameAnalysis>;
  return (
    stored.version === engineVersion &&
    typeof stored.reconstructable === "boolean" &&
    typeof stored.complete === "boolean" &&
    Array.isArray(stored.perMove) &&
    Array.isArray(stored.moments) &&
    Boolean(stored.summary) &&
    typeof stored.summary === "object"
  );
}

/** The cached analysis for exactly this game + log + version, or null. */
export async function readCachedAnalysis(
  identity: AnalysisCacheIdentity
): Promise<GameAnalysis | null> {
  const rows = await db
    .select({ analysis: solitaireAnalysisCache.analysis })
    .from(solitaireAnalysisCache)
    .where(
      and(
        eq(solitaireAnalysisCache.gameKind, identity.gameKind),
        eq(solitaireAnalysisCache.gameId, identity.gameId),
        eq(solitaireAnalysisCache.logDigest, identity.logDigest),
        eq(solitaireAnalysisCache.engineVersion, identity.engineVersion)
      )
    )
    .limit(1);

  const stored = rows[0]?.analysis;
  return isStoredAnalysis(stored, identity.engineVersion) ? stored : null;
}

/**
 * Persist one analysis.
 *
 * The unique identity makes this idempotent; `onConflictDoUpdate` heals a row
 * whose stored payload failed validation and lets two concurrent first views
 * converge on one record. Rows for the same game under an OLD digest or engine
 * version are removed, so a version bump never leaves a second cached analysis
 * behind for the same game.
 */
export async function storeCachedAnalysis(
  identity: AnalysisCacheIdentity,
  analysis: GameAnalysis
): Promise<void> {
  const compact = compactAnalysis(analysis);

  await db
    .insert(solitaireAnalysisCache)
    .values({
      gameKind: identity.gameKind,
      gameId: identity.gameId,
      logDigest: identity.logDigest,
      engineVersion: identity.engineVersion,
      analysis: compact,
    })
    .onConflictDoUpdate({
      target: [
        solitaireAnalysisCache.gameKind,
        solitaireAnalysisCache.gameId,
        solitaireAnalysisCache.logDigest,
        solitaireAnalysisCache.engineVersion,
      ],
      set: { analysis: compact },
    });

  await db
    .delete(solitaireAnalysisCache)
    .where(
      and(
        eq(solitaireAnalysisCache.gameKind, identity.gameKind),
        eq(solitaireAnalysisCache.gameId, identity.gameId),
        or(
          ne(solitaireAnalysisCache.logDigest, identity.logDigest),
          ne(solitaireAnalysisCache.engineVersion, identity.engineVersion)
        )
      )
    );
}

export type AnalysisCacheLoad = {
  readonly analysis: GameAnalysis | null;
  /** True only for a row read from the cache; false for a fresh computation. */
  readonly cached: boolean;
};

/**
 * Optional seams. Production uses the real db-backed reader/writer and the real
 * engine; tests inject fakes so the lifecycle can be asserted without Postgres.
 */
export type AnalysisCacheDeps = {
  read?: (identity: AnalysisCacheIdentity) => Promise<GameAnalysis | null>;
  store?: (identity: AnalysisCacheIdentity, analysis: GameAnalysis) => Promise<void>;
  analyze?: (input: {
    deal: SolitaireDeal;
    moves: readonly CanonicalMoveLogEntry[];
  }) => GameAnalysis;
};

/**
 * Read the cached analysis, or compute and store it exactly once.
 *
 * Order matters: the cache is consulted BEFORE the engine, so a hit never pays
 * for the deep comparison. Only a reconstructable analysis is stored or
 * returned — a log the engine refused is reported as "no analysis" and the
 * review UI still rebuilds every board from the deal and the log.
 */
export async function loadOrComputeAnalysis(
  {
    gameKind,
    gameId,
    logDigest,
    deal,
    moves,
    engineVersion = ANALYSIS_VERSION,
  }: {
    gameKind: ReviewGameKind;
    gameId: string;
    logDigest: string;
    deal: SolitaireDeal;
    moves: readonly CanonicalMoveLogEntry[];
    engineVersion?: number;
  },
  deps: AnalysisCacheDeps = {}
): Promise<AnalysisCacheLoad> {
  const identity = analysisCacheIdentity({
    gameKind,
    gameId,
    logDigest,
    engineVersion,
  });
  if (!identity) return { analysis: null, cached: false };

  const read = deps.read ?? readCachedAnalysis;
  const store = deps.store ?? storeCachedAnalysis;
  const analyze =
    deps.analyze ??
    (({ deal: inputDeal, moves: inputMoves }) =>
      analyzeSolitaireGame({ deal: inputDeal, moves: inputMoves }));

  let cached: GameAnalysis | null = null;
  try {
    cached = await read(identity);
  } catch {
    // A cache outage must never take the review down: compute instead.
    cached = null;
  }
  if (cached) return { analysis: cached, cached: true };

  const analysis = analyze({ deal, moves });
  if (!analysis.reconstructable) return { analysis: null, cached: false };

  try {
    await store(identity, analysis);
  } catch {
    // Best effort. No row was written, so the next review retries safely.
  }

  return { analysis, cached: false };
}
