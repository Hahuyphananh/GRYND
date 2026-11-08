/**
 * QA harness (not the game).
 *
 * It builds the real adapter against the real engine assets and plays one
 * complete self-play game, publishing the report as `window.__SELFPLAY__` for
 * `scripts/check-selfplay.mjs` and `scripts/check-tiers.mjs`.
 *
 * Tiers and length come from the URL so the same page covers the full sweep:
 *   harness.html?white=hard&black=easy&maxPlies=16
 */

import { coerceChessAiDifficulty } from "./chessDifficulty";
import { createChessEngine } from "./engine";
import { playSelfPlay } from "./selfplay";

const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");

const line = (text: string) => {
  const row = document.createElement("div");
  row.textContent = text;
  logEl?.appendChild(row);
};

const ENGINE_URL = new URL("engine/stockfish-nnue-16-single.js", document.baseURI).href;

const params = new URLSearchParams(window.location.search);
const whiteTier = coerceChessAiDifficulty(params.get("white") ?? "hard");
const blackTier = coerceChessAiDifficulty(params.get("black") ?? "easy");
const requestedPlies = Number(params.get("maxPlies") ?? 300);
const maxPlies = Number.isFinite(requestedPlies) && requestedPlies > 0 ? requestedPlies : 300;

type HarnessResult =
  | { running: true; plies: number }
  | {
      running: false;
      ok: true;
      whiteTier: string;
      blackTier: string;
      report: Awaited<ReturnType<typeof playSelfPlay>>;
    }
  | { running: false; ok: false; whiteTier: string; blackTier: string; error: string };

declare global {
  interface Window {
    __SELFPLAY__?: HarnessResult;
  }
}

window.__SELFPLAY__ = { running: true, plies: 0 };

const engine = createChessEngine({ url: ENGINE_URL });

async function run() {
  const boot = await engine.ready();
  if (statusEl) {
    statusEl.textContent = `${whiteTier} vs ${blackTier} — engine ready in ${Math.round(boot.bootMs)} ms`;
  }
  line(`engine: ${boot.identity} (boot ${Math.round(boot.bootMs)} ms)`);
  line(`tiers: ${whiteTier} (White) vs ${blackTier} (Black), max ${maxPlies} plies`);

  const report = await playSelfPlay(engine, {
    whiteTier,
    blackTier,
    maxPlies,
    onPly: (ply) => {
      window.__SELFPLAY__ = { running: true, plies: ply.ply };
      if (statusEl)
        statusEl.textContent = `${whiteTier} vs ${blackTier} — ${ply.san} (ply ${ply.ply})`;
    },
  });

  window.__SELFPLAY__ = { running: false, ok: true, whiteTier, blackTier, report };
  line(
    `finished: ${report.plies} plies, ${report.termination ?? "unfinished"}, winner ${report.winner ?? "none"}, ` +
      `${Math.round(report.durationMs)} ms`
  );
  if (statusEl) {
    statusEl.textContent = `${whiteTier} vs ${blackTier}: ${report.termination ?? "unfinished"} after ${report.plies} plies`;
  }
}

run()
  .catch((error: unknown) => {
    const message = String((error as Error)?.stack ?? error);
    window.__SELFPLAY__ = { running: false, ok: false, whiteTier, blackTier, error: message };
    line(`self-play failed: ${message}`);
    if (statusEl) statusEl.textContent = "self-play failed";
  })
  .finally(() => engine.dispose());
