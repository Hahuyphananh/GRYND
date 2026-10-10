/**
 * Guards the Stockfish / Cloudflare Workers boundary.
 *
 * The chess evaluator (src/lib/evaluation/games/chessEvaluator.ts) drives a
 * Stockfish 16 WASM engine to score positions. That engine is Node-only:
 *
 *   - its Emscripten loader reads the .wasm with
 *     `fs.readFileSync(path.join(__dirname, ...))`
 *   - it is listed in next.config.js `serverExternalPackages: ["stockfish"]`,
 *     so it is never bundled
 *   - it is booted through a dynamic `require("stockfish/src/...")`
 *
 * A Cloudflare Worker has none of that. Left unguarded the load fails with an
 * opaque "require is not defined"; worse, a future bundler change could make us
 * TRY to boot WASM on the edge (slow, and with no fs to read the binary).
 *
 * The contract this pins down:
 *
 *   1. `bootEngine()` refuses on Cloudflare BEFORE touching require/path/fs, so
 *      the engine is never loaded there.
 *   2. The refusal is a ChessEngineError, which the evaluator's existing catch
 *      turns into `engine_unavailable` — the same graceful result Vercel
 *      returns when the engine cannot boot. No route ever 500s because of this.
 *   3. Off-Workers nothing changes: `isCloudflareWorkers()` is false, so the
 *      real engine path (and all Vercel behaviour) is untouched.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const ENGINE_PATH = "src/lib/evaluation/engine/stockfishEngine.ts";
const EVALUATOR_PATH = "src/lib/evaluation/games/chessEvaluator.ts";

const CLOUDFLARE_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");

// Source is read as text for the literal assertions below, some of which span
// newlines. Normalising CRLF -> LF keeps those assertions valid on a Windows
// checkout (core.autocrlf=true) as well as the LF checkout CI uses — it changes
// no assertion's meaning, only the line endings it is compared against.
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const engineSrc = read(ENGINE_PATH);

test("bootEngine() checks for Cloudflare before it loads the engine", () => {
  const boot = engineSrc.slice(engineSrc.indexOf("async function bootEngine"));
  const guardAt = boot.indexOf("isCloudflareWorkers()");
  const loaderAt = boot.indexOf("loadStockfishFactory()");
  const requireAt = boot.indexOf("require(");
  assert.ok(guardAt !== -1, "bootEngine() must consult isCloudflareWorkers()");
  assert.ok(loaderAt !== -1, "bootEngine() must still load the engine");
  assert.ok(
    guardAt < loaderAt,
    "the Cloudflare guard must run BEFORE loadStockfishFactory(), or the engine is loaded on the edge",
  );
  assert.ok(
    requireAt === -1 || guardAt < requireAt,
    "the Cloudflare guard must run before any dynamic require()",
  );
});

test("the refusal message names the runtime and the fallback", () => {
  const throwAt = engineSrc.indexOf(
    'throw new ChessEngineError(\n      "Stockfish is unavailable on Cloudflare Workers',
  );
  assert.ok(
    throwAt !== -1,
    "bootEngine() must throw a ChessEngineError that explains the Cloudflare limitation",
  );
  // The message is a concatenation of two string literals, so read a window
  // rather than trying to delimit the expression.
  const window = engineSrc.slice(throwAt, throwAt + 400);
  assert.match(
    window,
    /engine_unavailable/,
    "the message should name the engine_unavailable result the evaluator returns",
  );
});

test("the evaluator turns an engine failure into engine_unavailable (not a 500)", () => {
  // The guarantee that keeps the route safe: analyzePosition is called inside a
  // try/catch that maps the failure to the insufficient/"engine_unavailable"
  // result, which the service answers as a 422 with a friendly message.
  const evaluator = read(EVALUATOR_PATH);
  const callAt = evaluator.indexOf("await analyzePosition(");
  assert.ok(callAt !== -1, "the evaluator must call analyzePosition()");
  const catchAt = evaluator.indexOf('"engine_unavailable"', callAt);
  assert.ok(
    catchAt !== -1 && catchAt - callAt < 600,
    "the analyzePosition() call must be immediately wrapped so a failure maps to engine_unavailable",
  );
});

test("isCloudflareWorkers() is false off-Workers and true inside a Worker", async () => {
  const { isCloudflareWorkers } = await import(
    "../src/lib/evaluation/engine/stockfishEngine.ts"
  );

  assert.equal(
    isCloudflareWorkers(),
    false,
    "with no Cloudflare context on globalThis (Vercel, Node, tests) the guard must be off",
  );

  try {
    globalThis[CLOUDFLARE_CONTEXT_SYMBOL] = { env: {} };
    assert.equal(
      isCloudflareWorkers(),
      true,
      "the OpenNext Cloudflare context on globalThis must switch the guard on",
    );
  } finally {
    delete globalThis[CLOUDFLARE_CONTEXT_SYMBOL];
  }

  assert.equal(isCloudflareWorkers(), false, "removing the context must switch it back off");
});

test("analyzePosition fails fast on Cloudflare instead of trying to boot WASM", async () => {
  const { analyzePosition, ChessEngineError, isCloudflareWorkers } = await import(
    "../src/lib/evaluation/engine/stockfishEngine.ts"
  );

  globalThis[CLOUDFLARE_CONTEXT_SYMBOL] = { env: {} };
  try {
    assert.equal(isCloudflareWorkers(), true);
    const startedAt = Date.now();
    await assert.rejects(
      () => analyzePosition("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"),
      (err) => {
        assert.ok(
          err instanceof ChessEngineError,
          `expected a ChessEngineError, got ${err && err.name}`,
        );
        assert.match(
          String(err.message),
          /Cloudflare Workers/,
          "the error must explain that the engine is unavailable on this runtime",
        );
        return true;
      },
    );
    // The guard means no boot attempt, so this must return immediately — the
    // engine's BOOT_TIMEOUT is 10s and a real boot is ~50ms plus a search.
    assert.ok(
      Date.now() - startedAt < 2_000,
      "the Cloudflare refusal must be immediate (no boot timeout, no WASM load)",
    );
  } finally {
    delete globalThis[CLOUDFLARE_CONTEXT_SYMBOL];
  }
});
