"use client";

// The single bridge between the review page and the analysis worker.
//
// Lifecycle:
//   data arrives → ONE runner per game key → worker (or fallback) → result
//   selected move changes → no effect at all (the hook is NOT keyed on it)
//   route changes / unmount → cleanup terminates the worker
//
// The worker is created here and nowhere else, so a re-render can never spawn a
// second analysis for the same game.

import { useEffect, useState } from "react";

import { analyzeSolitaireGame, type GameAnalysis } from "../lib/solitaire-duel/analysis";
import {
  createReviewAnalysisRunner,
  ReviewAnalysisCancelledError,
  type ReviewAnalysisMove,
  type ReviewAnalysisWorker,
} from "../lib/solitaire-duel/reviewAnalysisRunner";
import type { SolitaireDeal } from "../lib/solitaire-duel/types";

export type ReviewAnalysisState = {
  status: "idle" | "analyzing" | "ready" | "error";
  analysis: GameAnalysis | null;
  error: string | null;
};

const IDLE: ReviewAnalysisState = { status: "idle", analysis: null, error: null };

export function useSolitaireReviewAnalysis({
  enabled,
  gameKey,
  deal,
  moves,
  initialAnalysis = null,
}: {
  enabled: boolean;
  gameKey: string | null;
  deal: SolitaireDeal | null;
  moves: readonly ReviewAnalysisMove[] | null;
  /** Server-cached analysis from the review API. When present, no worker runs. */
  initialAnalysis?: GameAnalysis | null;
}): ReviewAnalysisState {
  const [state, setState] = useState<ReviewAnalysisState>(IDLE);

  useEffect(() => {
    if (!enabled || !gameKey || !deal || !moves) {
      setState(IDLE);
      return undefined;
    }

    // A cached analysis is the whole answer: do not spawn a worker, do not
    // re-analyse. The cache key is the game + exact log + engine version, so a
    // hit is exactly the analysis this game would compute.
    if (initialAnalysis) {
      setState({ status: "ready", analysis: initialAnalysis, error: null });
      return undefined;
    }

    let live = true;
    const runner = createReviewAnalysisRunner({
      createWorker: () => {
        if (typeof Worker === "undefined") return null;
        try {
          return new Worker(
            // @ts-expect-error Next bundles this URL form; tsc's CommonJS
            // module target rejects `import.meta`, not the browser API.
            new URL("../lib/solitaire-duel/analysis.worker.ts", import.meta.url),
            { type: "module" },
          ) as unknown as ReviewAnalysisWorker;
        } catch {
          return null;
        }
      },
      // The fallback runs on the main thread only when the browser has no
      // usable Worker, so the engine is already part of this page's chunk.
      fallback: async (inputDeal, inputMoves) =>
        analyzeSolitaireGame({
          deal: inputDeal,
          moves: inputMoves as Parameters<typeof analyzeSolitaireGame>[0]["moves"],
        }),
    });

    setState({ status: "analyzing", analysis: null, error: null });
    runner
      .analyze({ key: gameKey, deal, moves })
      .then((analysis) => {
        if (live) setState({ status: "ready", analysis, error: null });
      })
      .catch((error: unknown) => {
        if (!live || error instanceof ReviewAnalysisCancelledError) return;
        setState({
          status: "error",
          analysis: null,
          error: error instanceof Error ? error.message : "Analysis unavailable",
        });
      });

    return () => {
      live = false;
      runner.cancel();
    };
    // Deliberately NOT keyed on the selected move: one analysis per game.
  }, [enabled, gameKey, deal, moves, initialAnalysis]);

  return state;
}
