/**
 * Stockfish 16 (WASM) wrapper — server-side position evaluation AND gameplay.
 *
 * TWO CALLERS, ONE ENGINE
 * -----------------------
 * This module began as the evaluator's engine only. Chess VS-AI gameplay now
 * needs a search too ("which move should the bot play?"), and it deliberately
 * reuses THIS instance rather than starting a second one: one engine costs
 * ~600 KB of wasm plus boot, and two of them would fight for the same single
 * vCPU. So `analyzePosition` is the one entry point for both, and everything
 * below is shared.
 *
 * The consequence that matters: a search's UCI options PERSIST on the engine
 * instance between calls. A gameplay search that set `Skill Level 0` would
 * leave a later EVALUATION running at beginner strength — producing a
 * confidently wrong, still-successful-looking report. So every call now sends
 * its options explicitly, with `FULL_SKILL_LEVEL` as the documented default,
 * and nothing is ever inherited. See `analyzePosition`.
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

/**
 * Stockfish `Skill Level` bounds. 20 is the engine's own default and means
 * "full strength"; 0 is its weakest, and the option works by internally capping
 * the search and randomising its choice — which is what makes a low tier play
 * like a beginner instead of merely searching less.
 */
export const MIN_ENGINE_SKILL_LEVEL = 0;
export const MAX_ENGINE_SKILL_LEVEL = 20;
/** The skill level every caller gets unless it asks for less. */
export const FULL_SKILL_LEVEL = MAX_ENGINE_SKILL_LEVEL;

/** MultiPV bounds — how many ranked candidate moves a search may report. */
export const MIN_ENGINE_MULTIPV = 1;
export const MAX_ENGINE_MULTIPV = 5;
export const DEFAULT_ENGINE_MULTIPV = 1;

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
  /**
   * The engine's ranked candidate moves, best first (rank 1).
   *
   * Empty only when the search reported no `pv` at all. A weaker gameplay tier
   * chooses from these instead of always taking `bestMoveUci`, which is how the
   * difficulty tiers differ from one another. Every entry is the engine's own
   * output — nothing here is ever synthesised.
   */
  candidates: EngineCandidate[];
  /**
   * The options this search was ISSUED with — the resolved values behind the
   * `setoption` lines this call sends, so a caller can see what its `go` was
   * configured with (and a test can pin the per-call reset).
   *
   * NOTE: these are what we SENT, not a readback from the engine. MultiPV's
   * effect is independently observable on the engine's side (`candidates.length`
   * is the number of ranked lines the engine actually emitted), and Skill
   * Level's effect is behavioural (a weaker tier chooses differently).
   */
  settings: { skillLevel: number; multiPv: number };
};

/** One ranked MultiPV line, reduced to what a move chooser needs. */
export type EngineCandidate = {
  /** 1-based MultiPV rank; 1 is the engine's best move in this position. */
  rank: number;
  /** The candidate's FIRST move as lowercase UCI, or null when the line had no pv. */
  uci: string | null;
  /** Centipawns from the SIDE TO MOVE's point of view (UCI convention). */
  cp: number | null;
  /** Moves to mate for the side to move, if the line ends in mate. */
  mate: number | null;
};

export type EngineOptions = {
  /** Search depth ceiling. Clamped to MIN_ENGINE_DEPTH..MAX_ENGINE_DEPTH. */
  depth?: number;
  /** Hard per-position time cap in ms (also sent to the engine). */
  moveTimeMs?: number;
  /**
   * Stockfish `Skill Level`, clamped to MIN..MAX_ENGINE_SKILL_LEVEL. Defaults to
   * `FULL_SKILL_LEVEL` (20) — the default is load bearing, see the file header:
   * it is what stops a gameplay search's weaker setting reaching a later
   * evaluation on the same instance.
   */
  skillLevel?: number;
  /**
   * How many ranked candidates to report, clamped to MIN..MAX_ENGINE_MULTIPV.
   * Defaults to 1, which reproduces the pre-MultiPV behaviour exactly.
   */
  multiPv?: number;
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

/**
 * One `info … ` line, reduced to what a MultiPV search can be ranked by.
 *
 * `multipv` defaults to 1 when the engine omits it (single-PV output), which is
 * exactly the shape this module parsed before MultiPV support existed — so the
 * evaluator's reading of a search is unchanged.
 */
export function parseInfoLine(line: string): {
  multipv: number;
  cp: number | null;
  mate: number | null;
  depth: number | null;
  /** The principal variation's moves, in order. Empty when the line has none. */
  pv: string[];
} | null {
  if (!line.startsWith("info ") || !line.includes(" score ")) return null;
  // `\bdepth` deliberately does not match `seldepth`.
  const depthMatch = /\bdepth (\d+)/.exec(line);
  const cpMatch = /score cp (-?\d+)/.exec(line);
  const mateMatch = /score mate (-?\d+)/.exec(line);
  if (!cpMatch && !mateMatch) return null;
  const multipvMatch = /\bmultipv (\d+)/.exec(line);
  // `\bpv ` cannot match inside `multipv`: both sides of that boundary are word
  // characters, so there is no word boundary there.
  const pvMatch = /\bpv (.+)$/.exec(line);
  return {
    multipv: multipvMatch ? Number(multipvMatch[1]) : 1,
    cp: cpMatch ? Number(cpMatch[1]) : null,
    mate: mateMatch ? Number(mateMatch[1]) : null,
    depth: depthMatch ? Number(depthMatch[1]) : null,
    pv: pvMatch ? pvMatch[1].trim().split(/\s+/) : [],
  };
}

/**
 * Parses the last `info ... score cp|mate ...` line of a search.
 *
 * Kept as the original public shape (and now a thin wrapper over
 * `parseInfoLine`), so nothing that already depended on it changes.
 */
export function parseScoreLine(line: string): {
  cp: number | null;
  mate: number | null;
  depth: number | null;
} | null {
  const parsed = parseInfoLine(line);
  if (!parsed) return null;
  return { cp: parsed.cp, mate: parsed.mate, depth: parsed.depth };
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
  // Options are ALWAYS resolved to an explicit value — never left to the
  // instance's current state (see the file header). `undefined` therefore means
  // full strength / single PV, not "whatever the last caller set".
  const skillLevel = clampInt(
    options.skillLevel,
    MIN_ENGINE_SKILL_LEVEL,
    MAX_ENGINE_SKILL_LEVEL,
    FULL_SKILL_LEVEL,
  );
  const multiPv = clampInt(options.multiPv, MIN_ENGINE_MULTIPV, MAX_ENGINE_MULTIPV, DEFAULT_ENGINE_MULTIPV);

  // Guard against a FEN smuggling extra UCI commands into the engine's stdin.
  const safeFen = String(fen ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!safeFen) throw new ChessEngineError("empty FEN");

  return enqueueSearch(async () => {
    const engine = await getEngine();

    let score: { cp: number | null; mate: number | null; depth: number | null } | null = null;
    /**
     * Rank → candidate, LAST report wins. MultiPV lines arrive interleaved per
     * depth (rank 1, 2, 3… then rank 1, 2, 3… deeper), so overwriting per rank
     * keeps the deepest completed report for each — which is what the engine
     * prints immediately before `bestmove`.
     */
    const candidatesByRank = new Map<number, EngineCandidate>();
    const scoreListener = (line: string) => {
      const parsed = parseInfoLine(String(line));
      if (!parsed) return;
      candidatesByRank.set(parsed.multipv, {
        rank: parsed.multipv,
        uci: parsed.pv[0] ?? null,
        cp: parsed.cp,
        mate: parsed.mate,
      });
      // `score` stays the RANK 1 line — the engine's own best — which is what it
      // held before MultiPV support existed, so the evaluator reads the same
      // number it always did. With the default `multiPv` of 1 every line is
      // rank 1, making the two paths identical.
      if (parsed.multipv === 1) {
        score = { cp: parsed.cp, mate: parsed.mate, depth: parsed.depth }; // deepest/last report before bestmove
      }
    };
    engine.addMessageListener(scoreListener);

    const startedAt = Date.now();
    try {
      // ── Per-call option reset (load bearing — see the file header) ──────
      // Sent on EVERY search, before `position`/`go`, so a search can never
      // inherit the previous caller's settings. UCI engines consume stdin in
      // order, so these take effect before the search they precede; the engine
      // is idle here (boot completed `uci`/`isready`, and the queue guarantees no
      // other search is mid-flight), so no extra handshake is needed.
      engine.onCustomMessage(`setoption name Skill Level value ${skillLevel}`);
      engine.onCustomMessage(`setoption name MultiPV value ${multiPv}`);
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
        candidates: [...candidatesByRank.values()].sort((a, b) => a.rank - b.rank),
        settings: { skillLevel, multiPv },
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
