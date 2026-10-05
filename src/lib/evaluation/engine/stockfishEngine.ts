/**
 * Stockfish 16 (WASM) wrapper — server-side position evaluation.
 *
 * WHY THIS PACKAGE (verified, not assumed)
 * ----------------------------------------
 * `stockfish@16` was already a dependency of this repo (package.json) but was
 * not imported anywhere, and its shipped `main` ("src/stockfish.js") DOES NOT
 * EXIST — so `require("stockfish")` throws MODULE_NOT_FOUND. The subpath below
 * is the only working entry point.
 *
 * Facts established by running it, before committing to it:
 *
 *   1. No native binaries. The package ships Emscripten output:
 *      `stockfish-nnue-16-single.js` (25 KB) + `stockfish-nnue-16-single.wasm`
 *      (575 KB). No node-gyp, no .node addons, no child_process. That is what
 *      makes it usable in a Vercel Function.
 *   2. It is the SINGLE-THREADED build, so it needs no SharedArrayBuffer, no
 *      COOP/COEP headers, no nested workers and no worker_threads — those are
 *      the parts of the other builds that break in serverless.
 *   3. NNUE is OFF by default in this build ("option name Use NNUE type check
 *      default false"), so the 40 MB `nn-5af11540bbfe.nnue` file is NOT read
 *      at runtime. Only the ~600 KB of js+wasm need to ship. Verified by
 *      evaluating from a directory containing just those two files.
 *   4. It evaluates correctly: a queen-up position scores +771 cp, and the
 *      position after scholar's mate is reported as `score mate 0`.
 *   5. Its input API is NOT `postMessage`: the single-threaded build routes
 *      stdin through `onCustomMessage`. `postMessage()` silently does nothing
 *      (the engine loads, prints its banner, then ignores every command).
 *
 * VERCEL DEPLOY REQUIREMENTS (see next.config.js)
 * -----------------------------------------------
 * Vercel supports Wasm in the Node.js runtime (vercel.com/docs/functions/
 * runtimes/wasm), which is what this uses. Two things must be configured for
 * the .wasm to reach the function bundle, because the Emscripten loader reads
 * it with a DYNAMIC path — `fs.readFileSync(path.join(__dirname, ...))` — which
 * file tracing cannot see:
 *
 *   - `serverExternalPackages: ["stockfish"]` so the loader runs from
 *     node_modules instead of being bundled (its `__dirname` must stay real),
 *   - `outputFileTracingIncludes` for the .wasm, or the file is missing at
 *     runtime and every evaluation fails.
 *
 * Budget: one engine instance is ~50 ms to boot, then ~100-250 ms per position
 * at the default depth (10) with a 200 ms cap. Positions are analysed ONE AT A
 * TIME through a mutex — the engine is a stateful single-threaded process, so
 * interleaved `go` commands would corrupt each other's scores.
 *
 * License: Stockfish is GPLv3. It is invoked here as a separate process-like
 * WASM module through its public UCI interface (not linked into our code), but
 * the GPL obligation is worth a conscious decision — it is already a dependency
 * of this repo.
 */

import path from "node:path";

/** The only working entry point of the `stockfish` package (see header). */
const STOCKFISH_MODULE_ID = "stockfish/src/stockfish-nnue-16-single.js";
const STOCKFISH_WASM_FILE = "stockfish-nnue-16-single.wasm";

/** How long boot/`isready` may take before we call the engine broken. */
const BOOT_TIMEOUT_MS = 10_000;
/** Slack added to a search's own time limit before we declare it hung. */
const SEARCH_SLACK_MS = 4_000;

/** Default search settings. Depth first, with a hard per-position time cap. */
export const DEFAULT_ENGINE_DEPTH = 10;
export const DEFAULT_ENGINE_MOVE_TIME_MS = 200;
export const MIN_ENGINE_DEPTH = 1;
export const MAX_ENGINE_DEPTH = 24;

export type EngineScore = {
  /** Centipawns, from the SIDE TO MOVE's point of view (UCI convention). */
  cp: number | null;
  /** Moves to mate for the side to move (negative = being mated), if any. */
  mate: number | null;
  /** Search depth the score was reported at. */
  depth: number | null;
  /** Engine's best move as lowercase UCI ("e2e4", "e7e8q"), or null. */
  bestMoveUci: string | null;
  /** Wall-clock milliseconds the search took. */
  ms: number;
};

export type EngineOptions = {
  /** Search depth ceiling. Clamped to MIN_ENGINE_DEPTH..MAX_ENGINE_DEPTH. */
  depth?: number;
  /** Hard per-position time cap in ms (also sent to the engine). */
  moveTimeMs?: number;
};

/** The bits of the Emscripten module this wrapper actually uses. */
type StockfishEngine = {
  onCustomMessage(command: string): void;
  addMessageListener(listener: (line: string) => void): void;
  removeMessageListener(listener: (line: string) => void): void;
  terminate?(): void;
};

type ConsoleLike = {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

/** `Stockfish(myConsole, wasmPath)` returns the module factory; call it to boot. */
type StockfishFactory = (
  consoleLike: ConsoleLike,
  wasmPath: string,
) => () => Promise<StockfishEngine>;

/** Raised when the engine cannot be booted or a search never answers. */
export class ChessEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChessEngineError";
  }
}

function engineDebugEnabled(): boolean {
  return process.env.CHESS_ENGINE_DEBUG === "1";
}

/**
 * The `fetch` this process had before Stockfish was ever loaded.
 *
 * The Emscripten glue contains a bare `fetch && (fetch = null)`, which NULLS
 * THE PROCESS'S GLOBAL `fetch` when the module boots. Measured: it is intact
 * after `require()`, null the moment the module factory resolves, and it stays
 * null for the life of the process.
 *
 * That is not a private detail of the engine. The very request that runs the
 * analysis calls the LLM provider straight afterwards, and the provider uses
 * `fetch` — without the repair below every evaluation would end with
 * "fetch is not a function", and any other route sharing the warm instance
 * would lose its HTTP client too. So this capture + restore is load bearing.
 */
const PRISTINE_FETCH = globalThis.fetch;

function repairGlobalFetch(): void {
  if (
    typeof PRISTINE_FETCH === "function" &&
    globalThis.fetch !== PRISTINE_FETCH
  ) {
    if (engineDebugEnabled()) {
      console.warn("[stockfish] restored the global fetch the engine nulled at boot");
    }
    globalThis.fetch = PRISTINE_FETCH;
  }
}

/** The engine's banner is noise; only forward it when explicitly debugging. */
const quietConsole: ConsoleLike = {
  log: () => {},
  error: (...args: unknown[]) => {
    if (engineDebugEnabled()) console.warn("[stockfish]", ...args);
  },
  warn: (...args: unknown[]) => {
    if (engineDebugEnabled()) console.warn("[stockfish]", ...args);
  },
};

/**
 * The Emscripten loader resolves the .wasm next to its own JS file, so the
 * directory must be resolved at runtime. `require.resolve` is correct under
 * Node/tsx; the cwd fallback covers a bundler that rewrites require.resolve.
 */
function resolveWasmPath(): string {
  try {
    const jsPath = require.resolve(STOCKFISH_MODULE_ID);
    return path.join(path.dirname(jsPath), STOCKFISH_WASM_FILE);
  } catch {
    return path.join(
      process.cwd(),
      "node_modules",
      "stockfish",
      "src",
      STOCKFISH_WASM_FILE,
    );
  }
}

function loadStockfishFactory(): StockfishFactory {
  const factory = require(STOCKFISH_MODULE_ID) as StockfishFactory;
  if (typeof factory !== "function") {
    throw new ChessEngineError(
      `unexpected stockfish export (${typeof factory}); the package layout changed`,
    );
  }
  return factory;
}

/** Waits for the first engine line matching `predicate`, or rejects on timeout. */
function waitForLine(
  engine: StockfishEngine,
  predicate: (line: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const listener = (line: string) => {
      const text = String(line);
      if (!predicate(text)) return;
      cleanup();
      resolve(text);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new ChessEngineError(`timed out waiting for ${label}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      engine.removeMessageListener(listener);
    };
    engine.addMessageListener(listener);
  });
}

/** Parses the last `info ... score cp|mate ...` line of a search. */
export function parseScoreLine(line: string): {
  cp: number | null;
  mate: number | null;
  depth: number | null;
} | null {
  if (!line.startsWith("info ") || !line.includes(" score ")) return null;
  // `\bdepth` deliberately does not match `seldepth`.
  const depthMatch = /\bdepth (\d+)/.exec(line);
  const cpMatch = /score cp (-?\d+)/.exec(line);
  const mateMatch = /score mate (-?\d+)/.exec(line);
  if (!cpMatch && !mateMatch) return null;
  return {
    cp: cpMatch ? Number(cpMatch[1]) : null,
    mate: mateMatch ? Number(mateMatch[1]) : null,
    depth: depthMatch ? Number(depthMatch[1]) : null,
  };
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Boots an engine and completes the UCI handshake. Shipped as a CJS module, so
 * the returned object's methods are used directly (no awaits inside the module
 * itself — all coordination happens through listeners).
 */
async function bootEngine(): Promise<StockfishEngine> {
  const factory = loadStockfishFactory();
  const createModule = factory(quietConsole, resolveWasmPath());

  let engine: StockfishEngine;
  try {
    engine = await createModule();
  } finally {
    // Booting the module nulls the global `fetch` (see PRISTINE_FETCH). Put it
    // back before this process does anything else — in the finally so a boot
    // that throws mid-way cannot leave the server without an HTTP client.
    repairGlobalFetch();
  }

  if (typeof engine?.onCustomMessage !== "function") {
    throw new ChessEngineError("stockfish booted without onCustomMessage()");
  }

  // Capture the engine identity while handshaking — "which engine judged this
  // game" is part of the audit trail for a non-hallucinated evaluation.
  let identity = "";
  const identityListener = (line: string) => {
    const text = String(line);
    if (!identity && text.startsWith("id name ")) identity = text.slice(8).trim();
  };
  engine.addMessageListener(identityListener);
  try {
    engine.onCustomMessage("uci");
    await waitForLine(engine, (l) => l === "uciok", BOOT_TIMEOUT_MS, "uciok");
    engine.onCustomMessage("isready");
    await waitForLine(engine, (l) => l === "readyok", BOOT_TIMEOUT_MS, "readyok");
  } catch (err) {
    engine.removeMessageListener(identityListener);
    try {
      engine.terminate?.();
    } catch {
      /* nothing useful to do */
    }
    throw err;
  }
  engine.removeMessageListener(identityListener);
  engineIdentity = identity || "Stockfish (unknown build)";
  return engine;
}

let engineIdentity = "";
let enginePromise: Promise<StockfishEngine> | null = null;

/**
 * Serialises every search. The engine is a single-threaded stateful object:
 * two concurrent `go` commands would interleave their `info`/`bestmove` output
 * and produce wrong scores, so all callers queue behind each other.
 */
let searchQueue: Promise<unknown> = Promise.resolve();

function enqueueSearch<T>(task: () => Promise<T>): Promise<T> {
  const run = searchQueue.then(task, task);
  // Keep the chain alive even when a task rejects.
  searchQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function getEngine(): Promise<StockfishEngine> {
  if (!enginePromise) {
    enginePromise = bootEngine().catch((err) => {
      // Never cache a failed boot — the next call must be able to retry.
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}

/** Identity reported by the engine ("Stockfish 16 64 POPCNT WASM Single-threaded"). */
export function getEngineIdentity(): string {
  return engineIdentity;
}

/**
 * Evaluates one FEN. Scores come back from the SIDE TO MOVE's point of view, as
 * UCI specifies; callers convert to their own perspective.
 *
 * Throws ChessEngineError if the engine cannot answer in time.
 */
export async function analyzePosition(
  fen: string,
  options: EngineOptions = {},
): Promise<EngineScore> {
  const depth = clampInt(options.depth, MIN_ENGINE_DEPTH, MAX_ENGINE_DEPTH, DEFAULT_ENGINE_DEPTH);
  const moveTimeMs = clampInt(options.moveTimeMs, 1, 10_000, DEFAULT_ENGINE_MOVE_TIME_MS);

  // Guard against a FEN smuggling extra UCI commands into the engine's stdin.
  const safeFen = String(fen ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!safeFen) throw new ChessEngineError("empty FEN");

  return enqueueSearch(async () => {
    const engine = await getEngine();

    let score: { cp: number | null; mate: number | null; depth: number | null } | null = null;
    const scoreListener = (line: string) => {
      const parsed = parseScoreLine(String(line));
      if (parsed) score = parsed; // keep the deepest/last report before bestmove
    };
    engine.addMessageListener(scoreListener);

    const startedAt = Date.now();
    try {
      engine.onCustomMessage(`position fen ${safeFen}`);
      engine.onCustomMessage(`go depth ${depth} movetime ${moveTimeMs}`);
      const bestLine = await waitForLine(
        engine,
        (l) => l.startsWith("bestmove"),
        moveTimeMs + SEARCH_SLACK_MS,
        "bestmove",
      );
      const ms = Date.now() - startedAt;
      const bestToken = bestLine.split(/\s+/)[1] ?? "";
      const bestMoveUci =
        bestToken && bestToken !== "(none)" && bestToken !== "0000" ? bestToken : null;
      const final = score as {
        cp: number | null;
        mate: number | null;
        depth: number | null;
      } | null;
      return {
        cp: final?.cp ?? null,
        mate: final?.mate ?? null,
        depth: final?.depth ?? null,
        bestMoveUci,
        ms,
      };
    } catch (err) {
      // An unanswered search leaves the engine mid-search: stop it, and drop the
      // instance so the next caller boots a clean one instead of reading stale
      // output.
      try {
        engine.onCustomMessage("stop");
      } catch {
        /* ignore */
      }
      try {
        engine.terminate?.();
      } catch {
        /* ignore */
      }
      enginePromise = null;
      throw err instanceof ChessEngineError
        ? err
        : new ChessEngineError(`stockfish search failed: ${String(err)}`);
    } finally {
      engine.removeMessageListener(scoreListener);
    }
  });
}

/** Shuts the engine down and forgets it. Safe to call when nothing is booted. */
export async function disposeChessEngine(): Promise<void> {
  const pending = enginePromise;
  enginePromise = null;
  if (!pending) return;
  try {
    const engine = await pending;
    engine.terminate?.();
  } catch {
    /* a boot that already failed has nothing to terminate */
  }
}
