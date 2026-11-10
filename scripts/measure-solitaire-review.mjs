// scripts/measure-solitaire-review.mjs
//
// PHASE 6 measurement harness for Game Review. Run with:
//
//   node --import tsx scripts/measure-solitaire-review.mjs
//
// It reports, for 100 / 200 / 300-move legal logs and for a real solved game:
//   * wall-clock analysis time,
//   * heap growth during the analysis,
//   * compact cached payload size,
//   * full review API payload size (deal + log + analysis).
//
// The 100/200/300 logs are legal draw cycles against the tutorial deal: the
// stock empties, the waste recycles, and the log stays playable indefinitely.
// They exercise the per-move candidate scoring loop at a stable cost, which is
// what makes the 100 -> 200 -> 300 scaling meaningful. The solved line is the
// realistic end-to-end case.

import { performance } from "node:perf_hooks";

import { analyzeSolitaireGame } from "../src/lib/solitaire-duel/analysis.ts";
import { compactAnalysis } from "../src/lib/solitaire-duel/analysisCache.ts";
import { canonicalMoveLog } from "../src/lib/solitaire-duel/soloPersistence.ts";
import { solvableDealFromSeed, solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";
import { TUTORIAL_DEAL } from "../src/lib/solitaire-duel/tutorial.ts";

const KB = (bytes) => Math.round((bytes / 1024) * 10) / 10;

const draws = (count) =>
  Array.from({ length: count }, () => ({ kind: "draw", move: { kind: "draw" } }));

function measure(label, deal, rawMoves) {
  const canonical = canonicalMoveLog(rawMoves);
  if (!canonical.ok) throw new Error(`${label}: fixture log is not canonical`);

  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const analysis = analyzeSolitaireGame({ deal, moves: canonical.log });
  const elapsedMs = performance.now() - started;
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;

  const compact = compactAnalysis(analysis);
  const reviewPayload = { deal, moves: canonical.log, analysis };

  return {
    label,
    moves: canonical.log.length,
    analysisMs: Math.round(elapsedMs * 10) / 10,
    msPerMove: Math.round((elapsedMs / canonical.log.length) * 100) / 100,
    heapDeltaMb: Math.round((heapDelta / (1024 * 1024)) * 10) / 10,
    compactAnalysisKb: KB(Buffer.byteLength(JSON.stringify(compact), "utf8")),
    reviewPayloadKb: KB(Buffer.byteLength(JSON.stringify(reviewPayload), "utf8")),
    ratings: analysis.summary.ratings,
    complete: analysis.complete,
  };
}

const rows = [100, 200, 300].map((count) =>
  measure(`legal draw cycle (${count})`, TUTORIAL_DEAL, draws(count))
);

const solvedDeal = solvableDealFromSeed(7);
const solvedLine = (solveDealLine(solvedDeal) ?? []).map((move) => ({
  kind: move.kind,
  move,
}));
rows.push(measure(`solved seed 7 (${solvedLine.length})`, solvedDeal, solvedLine));

console.table(
  rows.map(({ label, moves, analysisMs, msPerMove, heapDeltaMb, compactAnalysisKb, reviewPayloadKb }) => ({
    label,
    moves,
    analysisMs,
    msPerMove,
    heapDeltaMb,
    compactAnalysisKb,
    reviewPayloadKb,
  }))
);
console.log(JSON.stringify(rows, null, 2));
