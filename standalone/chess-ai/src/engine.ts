/**
 * Stockfish adapter for the standalone game — Phase 2.
 *
 * WHAT IT IS
 * ----------
 * The ONE place an AI move is requested. It owns the Worker, the UCI handshake,
 * serialisation, budgets and the "no move" case; it never invents a move.
 *
 * WHAT PHASE 1 PROVED (see standalone/chess-ai/spike/README.md)
 * ------------------------------------------------------------
 * The single-threaded Stockfish 16 build boots from a BARE worker URL with the
 * .wasm sitting beside the .js (the documented `#<wasm>,worker` form does not
 * boot), needs no COOP/COEP, and survives a wasm served as octet-stream.
 *
 * TRANSPORT SEAM
 * --------------
 * `transport` is injectable so the adapter's queue, timeouts and legality checks
 * are testable in Node with a fake engine — no browser, no WASM. The default is
 * the real Worker transport.
 *
 * TRUST BOUNDARY
 * --------------
 * Every engine answer is re-validated with chess.js against the position that
 * was searched. A malformed or illegal answer is an ERROR, never a substituted
 * move: a fabricated AI move is the one thing this module must not do.
 */

import { Chess } from "chess.js";

import { settingsForChessAiDifficulty, type ChessAiSearchSettings } from "./chessDifficulty";

export class ChessEngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ChessEngineError";
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** What the adapter needs from a UCI engine. */
export type EngineTransport = {
  send(command: string): void;
  subscribeLine(listener: (line: string) => void): () => void;
  subscribeError(listener: (message: string) => void): () => void;
  terminate(): void;
};

/** The real transport: the npm package's single-threaded build as a Worker. */
export function createWorkerTransport(url: string): EngineTransport {
  const worker = new Worker(url);
  const lineListeners = new Set<(line: string) => void>();
  const errorListeners = new Set<(message: string) => void>();

  worker.addEventListener("message", (event) => {
    const line = String((event as MessageEvent).data);
    for (const listener of [...lineListeners]) listener(line);
  });
  worker.addEventListener("error", (event) => {
    const message = (event as ErrorEvent).message || `the engine worker failed to load ${url}`;
    (event as Event).preventDefault?.();
    for (const listener of [...errorListeners]) listener(message);
  });

  return {
    send(command) {
      worker.postMessage(command);
    },
    subscribeLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    subscribeError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    terminate() {
      worker.terminate();
    },
  };
}

export type ChessEngineOptions = {
  /** Worker script URL, e.g. `engine/stockfish-nnue-16-single.js`. */
  url: string;
  /** Injectable for tests. */
  transport?: (url: string) => EngineTransport;
  bootTimeoutMs?: number;
  now?: () => number;
};

export type EngineChoice = {
  /** The engine's move in stored UCI, or null when the position has no moves. */
  uci: string | null;
  ms: number;
  settings: ChessAiSearchSettings;
};

export type ChessEngine = {
  ready(): Promise<{ bootMs: number; identity: string }>;
  chooseMove(
    fen: string,
    difficulty: unknown,
    options?: { timeoutMs?: number }
  ): Promise<EngineChoice>;
  dispose(): void;
};

const DEFAULT_BOOT_TIMEOUT_MS = 15_000;
/** Extra time a search may overrun its own movetime before it is a failure. */
const SEARCH_SLACK_MS = 10_000;

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export function createChessEngine(options: ChessEngineOptions): ChessEngine {
  const now = options.now ?? Date.now;
  const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const transport = (options.transport ?? createWorkerTransport)(options.url);

  let booted: Promise<{ bootMs: number; identity: string }> | null = null;
  let disposed = false;
  let failure: Error | null = null;
  let pending: {
    predicate: (line: string) => boolean;
    resolve: (line: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const fail = (error: Error) => {
    failure = error;
    if (pending) {
      const waiter = pending;
      pending = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  transport.subscribeError((message) => fail(new ChessEngineError(message)));

  const unsubscribe = transport.subscribeLine((line) => {
    const waiter = pending;
    if (!waiter || !waiter.predicate(line)) return;
    pending = null;
    clearTimeout(waiter.timer);
    waiter.resolve(line);
  });

  /** Wait for the NEXT line that matches, or reject. Commands are serialised. */
  function waitFor(
    predicate: (line: string) => boolean,
    timeoutMs: number,
    label: string
  ): Promise<string> {
    if (failure) return Promise.reject(failure);
    if (pending) {
      return Promise.reject(new ChessEngineError(`an engine wait was already pending (${label})`));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        reject(new ChessEngineError(`timed out waiting for ${label} (${timeoutMs} ms)`));
      }, timeoutMs);
      pending = { predicate, resolve, reject, timer };
    });
  }

  async function boot(): Promise<{ bootMs: number; identity: string }> {
    if (failure) throw failure;
    const startedAt = now();
    let identity = "Stockfish (unknown build)";
    const capture = transport.subscribeLine((line) => {
      if (line.startsWith("id name ")) identity = line.slice("id name ".length).trim();
    });
    try {
      transport.send("uci");
      await waitFor((line) => line.trim() === "uciok", bootTimeoutMs, "uciok");
      transport.send("isready");
      await waitFor((line) => line.trim() === "readyok", bootTimeoutMs, "readyok");
    } finally {
      capture();
    }
    return { bootMs: now() - startedAt, identity };
  }

  const bootOnce = (): Promise<{ bootMs: number; identity: string }> => {
    if (!booted) {
      booted = boot().catch((error) => {
        // A failed boot is not cached: the next call may retry (matching the
        // production engine wrapper's behaviour).
        booted = null;
        throw error instanceof ChessEngineError
          ? error
          : new ChessEngineError(String((error as Error)?.message ?? error), { cause: error });
      });
    }
    return booted;
  };

  // One search at a time: the engine is stateful and its info/bestmove lines
  // would interleave otherwise.
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return {
    ready() {
      if (disposed) return Promise.reject(new ChessEngineError("the engine was disposed"));
      return enqueue(bootOnce);
    },

    chooseMove(fen, difficulty, moveOptions = {}) {
      if (disposed) return Promise.reject(new ChessEngineError("the engine was disposed"));
      const settings = settingsForChessAiDifficulty(difficulty);
      return enqueue(async () => {
        await bootOnce();

        const position = String(fen ?? "").trim();
        if (!position) throw new ChessEngineError("no position was supplied");

        let chess: Chess;
        try {
          chess = new Chess(position);
        } catch (error) {
          throw new ChessEngineError(`"${position}" is not a valid chess position`, {
            cause: error,
          });
        }

        const legal = new Set(
          chess
            .moves({ verbose: true })
            .map((move) => `${move.from}${move.to}${move.promotion ?? ""}`)
        );
        // Nothing to play (mate/stalemate, or a draw with moves left): no search.
        if (legal.size === 0 || chess.isGameOver()) {
          return { uci: null, ms: 0, settings };
        }

        const searchFen = chess.fen();
        const timeoutMs = moveOptions.timeoutMs ?? settings.moveTimeMs + SEARCH_SLACK_MS;
        const startedAt = now();

        transport.send(`setoption name Skill Level value ${settings.skillLevel}`);
        transport.send(`setoption name MultiPV value ${settings.multiPv}`);
        transport.send(`position fen ${searchFen}`);
        transport.send(`go depth ${settings.depth} movetime ${settings.moveTimeMs}`);
        const line = await waitFor(
          (output) => output.startsWith("bestmove"),
          timeoutMs,
          "bestmove"
        );
        const ms = now() - startedAt;

        const token = line.split(/\s+/)[1] ?? "";
        if (token === "" || token === "(none)" || token === "0000") {
          return { uci: null, ms, settings };
        }
        if (!UCI_RE.test(token)) {
          throw new ChessEngineError(`the engine answered with a malformed move "${token}"`);
        }
        if (!legal.has(token)) {
          throw new ChessEngineError(
            `the engine answered "${token}", which is not legal in this position`
          );
        }
        return { uci: token, ms, settings };
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (pending) {
        const waiter = pending;
        pending = null;
        clearTimeout(waiter.timer);
        waiter.reject(new ChessEngineError("the engine was disposed"));
      }
      transport.terminate();
    },
  };
}
