// standalone/chess-ai/spike/spike.js
//
// PHASE 1 — the engine gate.
//
// This page answers ONE question before any standalone app is designed: can the
// production chess engine (Stockfish 16, single-threaded WASM) run in a plain
// browser page, hosted as static files, with no server and no COOP/COEP headers?
//
// It boots the engine through the npm package's own worker entry, completes the
// UCI handshake, asks for a move in several positions at the three shipped
// difficulty tiers, and validates EVERY returned move with chess.js against the
// position it was asked about. It also records boot/search timings and checks
// that nothing was fetched from another origin.
//
// The result is published as `window.__SPIKE_RESULT__` for the runner
// (run-spike.mjs), which opens this page in headless Chrome and asserts it.
//
// This file is throwaway scaffolding for the gate. Phase 2 replaces it with the
// real `src/engine.ts` adapter.

import { Chess } from "chess.js";

const ENGINE_JS = new URL("engine/stockfish-nnue-16-single.js", document.baseURI).href;
const ENGINE_WASM = new URL("engine/stockfish-nnue-16-single.wasm", document.baseURI).href;

const logEl = document.getElementById("log");
const log = (text, tone = "") => {
  const row = document.createElement("div");
  row.textContent = text;
  if (tone) row.className = tone;
  logEl?.appendChild(row);
};

// Mirrors `CHESS_AI_SEARCH_SETTINGS` (src/lib/chessDifficulty.ts). Copied rather
// than imported on purpose: this spike must not drag the production module graph
// in, and Phase 2 imports the real table.
const TIERS = {
  easy: { skillLevel: 0, depth: 2, moveTimeMs: 150, multiPv: 5 },
  medium: { skillLevel: 8, depth: 6, moveTimeMs: 300, multiPv: 4 },
  hard: { skillLevel: 20, depth: 12, moveTimeMs: 500, multiPv: 1 },
};

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const CASES = [
  { name: "start position", fen: START_FEN, tier: "hard" },
  {
    name: "italian middlegame",
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    tier: "medium",
  },
  {
    name: "black to move (AI as White)",
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
    tier: "easy",
  },
  {
    name: "mate in one",
    fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
    tier: "hard",
    expectMate: true,
  },
  {
    name: "checkmated — no move exists",
    fen: "R5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1",
    tier: "hard",
    expectNoMove: true,
  },
  {
    name: "promotion available",
    fen: "8/4P3/8/8/8/8/8/k6K w - - 0 1",
    tier: "hard",
  },
  // Same position twice, so the runner can show cold vs warm search cost.
  { name: "start position (warm)", fen: START_FEN, tier: "hard" },
];

/**
 * A minimal UCI client over a Worker.
 *
 * The engine build posts every engine line as a worker message, so a turn is
 * "send commands, wait for the line that answers them". Waiters are registered
 * for the NEXT output only, which is enough because this client is strictly
 * sequential — the same discipline the real adapter will use.
 */
function createEngine(url, bootTimeoutMs) {
  const worker = new Worker(url);
  const waiters = new Set();
  const stats = { lines: 0, firstLineMs: null };
  const startedAt = performance.now();
  let failure = null;

  const rejectAll = (reason) => {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
  };

  worker.onmessage = (event) => {
    const line = String(event.data);
    stats.lines += 1;
    if (stats.firstLineMs === null) stats.firstLineMs = performance.now() - startedAt;
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(line)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  };

  worker.onerror = (event) => {
    event.preventDefault?.();
    failure = event.message || `worker failed to load ${url}`;
    rejectAll(failure);
  };

  const api = {
    stats,
    send(command) {
      if (failure) throw new Error(failure);
      worker.postMessage(command);
    },
    waitFor(predicate, timeoutMs, label) {
      if (failure) return Promise.reject(new Error(failure));
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`timed out waiting for ${label} (${timeoutMs} ms)`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async boot() {
      api.send("uci");
      await api.waitFor((line) => line.trim() === "uciok", bootTimeoutMs, "uciok");
      api.send("isready");
      await api.waitFor((line) => line.trim() === "readyok", bootTimeoutMs, "readyok");
      return performance.now() - startedAt;
    },
    dispose() {
      failure = failure ?? "disposed";
      rejectAll("disposed");
      worker.terminate();
    },
  };

  return api;
}

/** Ask for one move in `fen` and return the raw UCI token, or null for "(none)". */
async function search(engine, { fen, tier, timeoutMs }) {
  const settings = TIERS[tier];
  const startedAt = performance.now();
  engine.send(`setoption name Skill Level value ${settings.skillLevel}`);
  engine.send(`setoption name MultiPV value ${settings.multiPv}`);
  engine.send(`position fen ${fen}`);
  engine.send(`go depth ${settings.depth} movetime ${settings.moveTimeMs}`);
  const line = await engine.waitFor(
    (output) => output.startsWith("bestmove"),
    settings.moveTimeMs + Math.max(8_000, timeoutMs ?? 0),
    "bestmove"
  );
  const token = line.split(/\s+/)[1] ?? "";
  const uci = token === "(none)" || token === "0000" || token === "" ? null : token;
  return { uci, ms: performance.now() - startedAt, line };
}

/** Validate a UCI move against the position and return its SAN. */
function validate(fen, uci) {
  const game = new Chess(fen);
  const legal = new Set(
    game.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ""}`)
  );
  if (uci === null) return { legal: false, san: null, mate: false, legalCount: legal.size };
  if (!legal.has(uci)) return { legal: false, san: null, mate: false, legalCount: legal.size };
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci.slice(4) : undefined;
  const played = game.move({ from, to, promotion });
  return {
    legal: true,
    san: played?.san ?? null,
    mate: Boolean(played?.san?.includes("#")) || game.isCheckmate(),
    legalCount: legal.size,
  };
}

/**
 * The worker-entry spellings worth trying, most specific first.
 *
 * The package's single-threaded build reads the wasm path from the worker
 * script's hash and expects the `worker` marker there when it is loaded as a
 * Worker. The bare form (wasm sitting next to the script) is kept as a fallback
 * so the spike records what actually works instead of assuming it.
 */
function workerCandidates() {
  return [
    { label: "hash:wasm + worker", url: `${ENGINE_JS}#${encodeURIComponent(ENGINE_WASM)},worker` },
    { label: "hash:worker only", url: `${ENGINE_JS}#,worker` },
    { label: "bare script", url: ENGINE_JS },
  ];
}

async function bootFirstWorking(attempts) {
  for (const candidate of workerCandidates()) {
    const engine = createEngine(candidate.url, 8_000);
    const startedAt = performance.now();
    try {
      const bootMs = await engine.boot();
      attempts.push({
        form: candidate.label,
        ok: true,
        ms: Math.round(performance.now() - startedAt),
        bootMs: Math.round(bootMs),
      });
      return { engine, form: candidate.label, bootMs };
    } catch (error) {
      engine.dispose();
      attempts.push({
        form: candidate.label,
        ok: false,
        ms: Math.round(performance.now() - startedAt),
        error: String(error?.message ?? error),
      });
    }
  }
  return { engine: null, form: null, bootMs: null };
}

async function main() {
  const result = {
    ok: false,
    error: null,
    userAgent: navigator.userAgent,
    crossOriginIsolated: crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    engine: { js: ENGINE_JS, wasm: ENGINE_WASM, wasmMime: null, workerForm: null, attempts: [] },
    bootMs: null,
    firstLineMs: null,
    cases: [],
    resourceOrigins: [],
    consoleErrors: [],
  };

  // Whatever the engine asks for, record what the server claimed the wasm is.
  // `application/wasm` lets the streaming compiler run; anything else must fall
  // back to an ArrayBuffer compile — which is exactly the hazard on portal hosts.
  try {
    const head = await fetch(ENGINE_WASM, { method: "HEAD" });
    result.engine.wasmMime = head.headers.get("content-type");
  } catch (error) {
    result.consoleErrors.push(`wasm HEAD failed: ${String(error)}`);
  }

  const { engine, form, bootMs } = await bootFirstWorking(result.engine.attempts);
  if (!engine) {
    throw new Error(`no worker entry booted: ${JSON.stringify(result.engine.attempts)}`);
  }
  result.engine.workerForm = form;
  result.bootMs = Math.round(bootMs);
  result.firstLineMs = Math.round(engine.stats.firstLineMs ?? 0);
  log(`engine booted via ${form} in ${result.bootMs} ms`, "ok");

  for (const testCase of CASES) {
    const { uci, ms } = await search(engine, { fen: testCase.fen, tier: testCase.tier });
    const checked = validate(testCase.fen, uci);
    const entry = {
      name: testCase.name,
      tier: testCase.tier,
      uci,
      san: checked.san,
      legal: checked.legal,
      // The pass condition: a legal move, or the correct "no move exists" for a
      // mated position. `legal` stays raw so the report shows what was validated.
      correct: testCase.expectNoMove ? uci === null : checked.legal,
      legalCount: checked.legalCount,
      mate: checked.mate,
      ms: Math.round(ms),
      expectMate: Boolean(testCase.expectMate),
      expectNoMove: Boolean(testCase.expectNoMove),
    };
    result.cases.push(entry);
    log(
      `${testCase.name.padEnd(32)} ${testCase.tier.padEnd(7)} ${String(uci ?? "(none)").padEnd(7)}` +
        ` ${String(Math.round(ms)).padStart(4)} ms  ${checked.legal ? checked.san : "ILLEGAL"}`,
      checked.legal || testCase.expectNoMove ? "ok" : "bad"
    );
    if (!checked.legal && !testCase.expectNoMove) {
      throw new Error(`${testCase.name}: engine returned an illegal move (${uci})`);
    }
  }

  // Keep the engine alive: the runner benchmarks it under CPU throttling after
  // the gate result is published. The worker dies with the page.
  window.__spikeBenchmark = async ({ rounds = 3 } = {}) => {
    const benchFens = [
      START_FEN,
      "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    ];
    const tiers = {};
    for (const tier of Object.keys(TIERS)) {
      const samples = [];
      let illegal = 0;
      for (let round = 0; round < rounds; round += 1) {
        for (const fen of benchFens) {
          const { uci, ms } = await search(engine, { fen, tier, timeoutMs: 20_000 });
          if (!validate(fen, uci).legal) illegal += 1;
          samples.push(Math.round(ms));
        }
      }
      samples.sort((a, b) => a - b);
      tiers[tier] = {
        samples,
        medianMs: samples[Math.floor(samples.length / 2)],
        maxMs: samples[samples.length - 1],
        illegal,
      };
    }
    // A control that runs on the page's MAIN thread: if its duration does not
    // grow under CPU throttling, the throttle itself is not reaching this page
    // and the engine numbers below prove nothing about slowdown.
    const mainThreadStart = performance.now();
    let sink = 0;
    for (let i = 0; i < 3_000_000; i += 1) sink += i % 7;
    const mainThreadMs = Math.round(performance.now() - mainThreadStart);
    if (sink === -1) console.warn("unreachable");

    // A movetime-capped search cannot show CPU throttling: the engine stops at
    // the same wall-clock budget and merely searches fewer nodes. A fixed-depth
    // search has no time cap, so its duration is the honest compute signal —
    // and the transposition table is cleared first, so a warm hash cannot make
    // the second measurement cheaper than the first.
    const fixedDepthStart = performance.now();
    engine.send("setoption name Clear Hash value true");
    engine.send("setoption name Skill Level value 20");
    engine.send("setoption name MultiPV value 1");
    engine.send(`position fen ${START_FEN}`);
    engine.send("go depth 12");
    await engine.waitFor((output) => output.startsWith("bestmove"), 120_000, "bestmove (depth 12)");
    const fixedDepthMs = Math.round(performance.now() - fixedDepthStart);

    return { rounds, tiers, fixedDepthMs, mainThreadMs };
  };

  result.resourceOrigins = [
    ...new Set(
      performance
        .getEntriesByType("resource")
        .map((entry) => {
          try {
            return new URL(entry.name).origin;
          } catch {
            return "invalid";
          }
        })
        .filter((origin) => origin !== "null" && origin !== "invalid")
    ),
  ];

  result.ok = true;
  return result;
}

main()
  .then((result) => {
    window.__SPIKE_RESULT__ = result;
  })
  .catch((error) => {
    window.__SPIKE_RESULT__ = {
      ok: false,
      error: String(error?.stack ?? error?.message ?? error),
      engine: { attempts: window.__SPIKE_RESULT__?.engine?.attempts ?? [] },
    };
    log(`spike failed: ${String(error?.message ?? error)}`, "bad");
  });
