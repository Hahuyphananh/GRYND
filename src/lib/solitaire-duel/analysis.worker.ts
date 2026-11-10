// src/lib/solitaire-duel/analysis.worker.ts
//
// The native-browser analysis worker. No third-party worker runtime: Next
// bundles this file through `new Worker(new URL(...))` in the hook.
//
// It imports ONLY the pure analysis engine. It has no React, no fetch and no
// store access, so the UI thread cannot be blocked by the deep comparison and
// the worker cannot reach UI state.
//
// Protocol: { id, deal, moves } in; { id, analysis } or { id, error } out.

import { analyzeSolitaireGame } from "./analysis";
import type { SolitaireMove } from "./types";

type AnalysisRequest = {
  id: string;
  deal: unknown;
  moves: { kind: string; move: SolitaireMove }[];
};

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalysisRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (event) => {
  const request = event.data;
  if (
    !request ||
    typeof request.id !== "string" ||
    !request.deal ||
    !Array.isArray(request.moves)
  ) {
    return;
  }
  try {
    const analysis = analyzeSolitaireGame({
      deal: request.deal as Parameters<typeof analyzeSolitaireGame>[0]["deal"],
      moves: request.moves,
    });
    scope.postMessage({ id: request.id, analysis });
  } catch (error) {
    scope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : "Solitaire analysis failed",
    });
  }
};
