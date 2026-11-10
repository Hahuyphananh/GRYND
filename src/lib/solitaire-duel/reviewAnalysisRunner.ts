// src/lib/solitaire-duel/reviewAnalysisRunner.ts
//
// ONE analysis per game, on a worker when the browser has one.
//
// The runner is deliberately framework-free so the hard parts are testable in
// Node: single-flight by game key, a no-worker fallback, worker-error fallback,
// a timeout, and cancellation that terminates the worker instead of letting a
// late answer reach a page the player has already left.
//
// It never touches React state; the hook above it owns that bridge.

import type { GameAnalysis } from "./analysis";
import type { SolitaireDeal } from "./types";

export type ReviewAnalysisMove = { kind: string; move: unknown };

/** The tiny surface of a Worker this module needs (also easy to fake in tests). */
export type ReviewAnalysisWorker = {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type ReviewAnalysisRunner = {
  analyze(input: {
    key: string;
    deal: SolitaireDeal;
    moves: readonly ReviewAnalysisMove[];
  }): Promise<GameAnalysis>;
  cancel(): void;
};

export class ReviewAnalysisCancelledError extends Error {
  constructor() {
    super("Solitaire review analysis was cancelled");
    this.name = "ReviewAnalysisCancelledError";
  }
}

type Run = {
  key: string;
  worker: ReviewAnalysisWorker | null;
  timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<GameAnalysis>;
  resolve: (analysis: GameAnalysis) => void;
  reject: (error: unknown) => void;
  done: boolean;
};

export function createReviewAnalysisRunner({
  createWorker,
  fallback,
  timeoutMs = 20_000,
}: {
  /** Return null when the environment has no Worker. Throwing is caught too. */
  createWorker: () => ReviewAnalysisWorker | null;
  /** Runs on the main thread only when the worker is unavailable or fails. */
  fallback: (deal: SolitaireDeal, moves: readonly ReviewAnalysisMove[]) => Promise<GameAnalysis>;
  timeoutMs?: number;
}): ReviewAnalysisRunner {
  let active: Run | null = null;

  function dispose(run: Run) {
    if (run.timer !== null) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    if (run.worker) {
      run.worker.onmessage = null;
      run.worker.onerror = null;
      run.worker.terminate();
      run.worker = null;
    }
    if (active === run) active = null;
  }

  function settle(run: Run, analysis: GameAnalysis) {
    if (run.done) return;
    run.done = true;
    dispose(run);
    run.resolve(analysis);
  }

  function fail(run: Run, error: unknown) {
    if (run.done) return;
    run.done = true;
    dispose(run);
    run.reject(error instanceof Error ? error : new Error("Solitaire analysis failed"));
  }

  async function runFallback(run: Run, deal: SolitaireDeal, moves: readonly ReviewAnalysisMove[]) {
    try {
      settle(run, await fallback(deal, moves));
    } catch (error) {
      fail(run, error);
    }
  }

  function analyze({
    key,
    deal,
    moves,
  }: {
    key: string;
    deal: SolitaireDeal;
    moves: readonly ReviewAnalysisMove[];
  }): Promise<GameAnalysis> {
    // Same game: reuse the in-flight/completed promise. Selecting another move
    // is NOT a new analysis, and this is the guard that makes that structural.
    if (active && !active.done && active.key === key) return active.promise;
    if (active) cancel();

    let resolve!: (analysis: GameAnalysis) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<GameAnalysis>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const run: Run = { key, worker: null, timer: null, promise, resolve, reject, done: false };
    active = run;

    let worker: ReviewAnalysisWorker | null = null;
    try {
      worker = createWorker();
    } catch {
      worker = null;
    }
    if (!worker) {
      void runFallback(run, deal, moves);
      return promise;
    }
    run.worker = worker;

    const fallBackFromWorker = () => {
      if (run.done) return;
      if (run.timer !== null) {
        clearTimeout(run.timer);
        run.timer = null;
      }
      if (run.worker) {
        run.worker.onmessage = null;
        run.worker.onerror = null;
        run.worker.terminate();
        run.worker = null;
      }
      void runFallback(run, deal, moves);
    };

    worker.onmessage = (event) => {
      const data = event?.data as
        | { id?: unknown; analysis?: GameAnalysis; error?: unknown }
        | null
        | undefined;
      if (!data || String(data.id) !== key) return;
      if (data.analysis) settle(run, data.analysis);
      else fallBackFromWorker();
    };
    worker.onerror = () => fallBackFromWorker();
    run.timer = setTimeout(fallBackFromWorker, Math.max(1, timeoutMs));

    try {
      worker.postMessage({ id: key, deal, moves });
    } catch {
      fallBackFromWorker();
    }
    return promise;
  }

  function cancel() {
    const run = active;
    if (!run) return;
    if (run.done) {
      active = null;
      return;
    }
    run.done = true;
    dispose(run);
    run.reject(new ReviewAnalysisCancelledError());
  }

  return { analyze, cancel };
}
