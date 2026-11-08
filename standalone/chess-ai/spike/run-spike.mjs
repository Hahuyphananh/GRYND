#!/usr/bin/env node
// standalone/chess-ai/spike/run-spike.mjs
//
// Phase 1 gate runner. Builds the spike with Vite, serves the BUILT output from
// a plain static server, opens it in headless Chrome with every https/wss
// request blocked, and asserts the engine booted and played legal chess.
//
// Dependency-free apart from the repo's Vite: Chrome is driven over the DevTools
// protocol with Node's built-in WebSocket/fetch, and the page is the only thing
// that knows about Stockfish.
//
// Usage:
//   node standalone/chess-ai/spike/run-spike.mjs                # wasm served as application/wasm
//   node standalone/chess-ai/spike/run-spike.mjs --mime=octet   # prove the non-streaming fallback
//
// Exit 0 = the engine gate passed.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../../..");
const CONFIG = join(HERE, "vite.config.mts");
const OUT = join(ROOT, "dist/chess-ai-spike");

const argv = process.argv.slice(2);
const MIME_MODE =
  argv.find((entry) => entry.startsWith("--mime="))?.slice("--mime=".length) ?? "wasm";
assert.ok(["wasm", "octet"].includes(MIME_MODE), `unknown --mime=${MIME_MODE}`);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const WASM_MIME = MIME_MODE === "wasm" ? "application/wasm" : "application/octet-stream";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rateLabel = (rate) => `${rate}x`;

// ── 1. Build ─────────────────────────────────────────────────────────────

await build({ configFile: CONFIG, logLevel: "warn" });
assert.ok(existsSync(join(OUT, "index.html")), "the spike build produced no index.html");
assert.ok(
  existsSync(join(OUT, "engine/stockfish-nnue-16-single.wasm")),
  "the engine wasm did not reach the build (it must live in public/engine/)"
);

// ── 2. Serve the built output ────────────────────────────────────────────

const requests = [];
const server = createServer((req, res) => {
  const requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const safe = normalize(requested).replace(/^([/\\])+/, "");
  let file = join(OUT, safe || "index.html");
  requests.push({ url: requested, method: req.method });
  if (!file.startsWith(OUT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  const ext = extname(file);
  const type = ext === ".wasm" ? WASM_MIME : (MIME[ext] ?? "application/octet-stream");
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(readFileSync(file));
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

// ── 3. Chrome over CDP ───────────────────────────────────────────────────

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
assert.ok(chromePath, "Chrome not found — set CHROME_PATH to a Chrome/Chromium binary");

const profile = mkdtempSync(join(tmpdir(), "chess-ai-spike-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-client-side-phishing-detection",
    "--disable-domain-reliability",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--metrics-recording-only",
    "--no-pings",
    "--mute-audio",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

const browserWs = await new Promise((done, fail) => {
  let buffered = "";
  const timer = setTimeout(
    () => fail(new Error("Chrome did not report a DevTools endpoint")),
    25_000
  );
  chrome.stderr.on("data", (chunk) => {
    buffered += chunk.toString();
    const found = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
    if (found) {
      clearTimeout(timer);
      done(found[1]);
    }
  });
  chrome.on("exit", (code) => {
    clearTimeout(timer);
    fail(new Error(`Chrome exited before it was ready (code ${code})`));
  });
});

const devtoolsPort = new URL(browserWs).port;
let pageTarget = null;
for (let attempt = 0; attempt < 50 && !pageTarget; attempt += 1) {
  const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((response) =>
    response.json()
  );
  pageTarget = targets.find((target) => target.type === "page");
  if (!pageTarget) await sleep(100);
}
assert.ok(pageTarget, "no page target exposed by Chrome");

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((done, fail) => {
  socket.addEventListener("open", done, { once: true });
  socket.addEventListener("error", () => fail(new Error("CDP socket failed")), { once: true });
});

let messageId = 0;
const pending = new Map();
const consoleErrors = [];

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const settle = pending.get(message.id);
    pending.delete(message.id);
    settle?.(message);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(
      message.params?.exceptionDetails?.exception?.description ?? "uncaught exception"
    );
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
    consoleErrors.push(
      (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ")
    );
  }
});

function send(method, params = {}) {
  const id = (messageId += 1);
  return new Promise((done, fail) => {
    pending.set(id, (message) =>
      message.error
        ? fail(new Error(`${method}: ${JSON.stringify(message.error)}`))
        : done(message.result)
    );
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "page evaluation failed");
  }
  return result.result.value;
}

async function until(label, expression, timeoutMs = 20_000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await evaluate(expression);
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(150);
  }
}

// ── 4. Run the gate ──────────────────────────────────────────────────────

let result = null;
let failure = null;
let benchmarks = [];

try {
  await send("Network.enable");
  await send("Page.enable");
  await send("Runtime.enable");

  // Offline condition: every https/wss request is blocked by the browser. The
  // local origin stays reachable so the built page can be served — exactly the
  // "static files, no network" situation a portal package must survive.
  await send("Network.setBlockedURLs", { urls: ["https://*", "wss://*"] });
  await send("Page.navigate", { url: `${BASE}/index.html` });

  result = await until("the spike result", "window.__SPIKE_RESULT__ || null", 120_000);

  // CPU-throttled benchmarks. 1x is the same machine as the gate; 4x/6x stand in
  // for a mid-range laptop and a phone, so the "Thinking…" budget has evidence
  // behind it rather than a guess.
  for (const rate of [1, 4, 6]) {
    await send("Emulation.setCPUThrottlingRate", { rate });
    const bench = await evaluate(
      "typeof window.__spikeBenchmark === 'function' ? window.__spikeBenchmark() : null"
    );
    if (bench) benchmarks.push({ rate, ...bench });
  }
  await send("Emulation.setCPUThrottlingRate", { rate: 1 });
} catch (error) {
  failure = error;
}

// ── 5. Assert ────────────────────────────────────────────────────────────

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

try {
  assert.ok(result, failure ? String(failure.message) : "the page produced no result");
  assert.equal(result.ok, true, `the spike failed: ${result.error ?? "unknown"}`);

  check(
    result.crossOriginIsolated === false,
    "the page must NOT need COOP/COEP (crossOriginIsolated must be false)"
  );
  check(Boolean(result.engine?.workerForm), "no worker entry form booted the engine");
  check(Number.isFinite(result.bootMs) && result.bootMs > 0, "boot time was not measured");

  for (const testCase of result.cases ?? []) {
    check(
      testCase.correct ?? testCase.legal,
      `${testCase.name}: engine move ${testCase.uci} is not legal`
    );
    if (testCase.expectMate) {
      check(testCase.mate, `${testCase.name}: the engine did not find the mate`);
    }
    if (testCase.expectNoMove) {
      check(testCase.uci === null, `${testCase.name}: expected no move, got ${testCase.uci}`);
    }
  }
  check((result.cases ?? []).length >= 6, "not every position was searched");

  const expectedOrigin = new URL(BASE).origin;
  for (const origin of result.resourceOrigins ?? []) {
    check(origin === expectedOrigin, `the page fetched ${origin}, which is not the local origin`);
  }
  check(
    !(result.engine?.attempts ?? []).some(
      (attempt) => !attempt.ok && attempt.form === result.engine?.workerForm
    ),
    "the reported worker form did not boot"
  );

  const pageWasm = (result.engine?.wasmMime ?? "").toLowerCase();
  if (MIME_MODE === "wasm") {
    check(
      pageWasm.includes("application/wasm"),
      `expected application/wasm, page saw "${result.engine?.wasmMime}"`
    );
  } else {
    check(
      !pageWasm.includes("application/wasm"),
      "the octet-stream run should not see application/wasm"
    );
  }

  for (const bench of benchmarks) {
    for (const [tier, row] of Object.entries(bench.tiers ?? {})) {
      check(row.illegal === 0, `${rateLabel(bench.rate)} ${tier}: an engine move was illegal`);
    }
  }
  check(benchmarks.length === 3, "the CPU-throttled benchmarks did not all run");

  check(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);
} catch (error) {
  failures.push(String(error.message ?? error));
}

// ── 6. Report ────────────────────────────────────────────────────────────

const report = {
  mimeMode: MIME_MODE,
  wasmMimeServed: WASM_MIME,
  failures,
  consoleErrors,
  result,
  benchmarks,
  requests,
};
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));

const line = "-".repeat(78);
console.log(
  `\nChess AI — Phase 1 engine spike  (${MIME_MODE === "wasm" ? "application/wasm" : "octet-stream"})`
);
console.log(line);
if (result?.ok) {
  console.log(`engine            Stockfish 16 single-threaded WASM`);
  console.log(`worker entry      ${result.engine.workerForm}`);
  console.log(`wasm MIME seen by page   ${result.engine.wasmMime}`);
  console.log(`crossOriginIsolated      ${result.crossOriginIsolated}`);
  console.log(
    `boot              ${result.bootMs} ms   (first output line at ${result.firstLineMs} ms)`
  );
  console.log(line);
  console.log(
    `${"position".padEnd(32)} ${"tier".padEnd(7)} ${"move".padEnd(7)} ${"ms".padStart(5)}  san`
  );
  for (const testCase of result.cases) {
    const move = testCase.uci ?? "(none)";
    console.log(
      `${testCase.name.padEnd(32)} ${testCase.tier.padEnd(7)} ${move.padEnd(7)} ${String(testCase.ms).padStart(5)}  ${testCase.san ?? (testCase.expectNoMove ? "checkmate" : "")}`
    );
  }
  console.log(line);
  console.log(`origins fetched   ${result.resourceOrigins.join(", ")}`);
  if (benchmarks.length > 0) {
    console.log(line);
    console.log("CPU throttling — median ms per move (6 samples/tier)");
    console.log(
      `tier      ${benchmarks.map((bench) => rateLabel(bench.rate).padStart(8)).join("")}`
    );
    for (const tier of ["easy", "medium", "hard"]) {
      const cells = benchmarks
        .map((bench) => String(bench.tiers?.[tier]?.medianMs ?? "-").padStart(8))
        .join("");
      console.log(`${tier.padEnd(10)}${cells}`);
    }
    console.log("fixed-depth compute signal (clear hash + go depth 12, no movetime)");
    console.log(
      benchmarks.map((bench) => `${rateLabel(bench.rate)} ${bench.fixedDepthMs} ms`).join("    ")
    );
    console.log(
      "main-thread control   " +
        benchmarks.map((bench) => `${rateLabel(bench.rate)} ${bench.mainThreadMs} ms`).join("    ")
    );
    const base = benchmarks.find((bench) => bench.rate === 1);
    const slow = benchmarks.find((bench) => bench.rate === 6);
    if (base && slow && base.mainThreadMs > 0) {
      const mainRatio = slow.mainThreadMs / base.mainThreadMs;
      const engineRatio = slow.fixedDepthMs / base.fixedDepthMs;
      console.log(
        `slowdown at 6x       main thread ${mainRatio.toFixed(2)}x, engine ${engineRatio.toFixed(2)}x`
      );
    }
  }
} else if (result) {
  console.log("spike failed in the page:", result.error);
  console.log("worker attempts:", JSON.stringify(result.engine?.attempts, null, 2));
}

console.log(`requests served   ${requests.length} (all local)`);
if (failures.length > 0) {
  console.log(line);
  for (const item of failures) console.log(`FAIL  ${item}`);
}
console.log(line);
console.log(
  failures.length === 0 ? "PASS  the engine gate is open" : `FAILED  ${failures.length} problem(s)`
);
console.log(`report             ${join(OUT, "report.json")}\n`);

// ── 7. Clean up ──────────────────────────────────────────────────────────

socket.close();
chrome.kill();
server.close();
try {
  rmSync(profile, { recursive: true, force: true });
} catch {
  /* the profile is in tmp; leaving it behind is harmless */
}

process.exit(failures.length === 0 ? 0 : 1);
