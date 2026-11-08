#!/usr/bin/env node
// qa/memory-grid-standalone-check.mjs
//
// Drives the BUILT standalone Memory Grid in a real Chrome, with the outside
// world blocked, and proves the package is self-contained and playable.
//
// It is deliberately dependency-free: Chrome is launched with
// `--remote-debugging-port=0` and driven over the DevTools protocol with Node's
// built-in WebSocket and fetch. Nothing is installed and nothing is mocked — this
// exercises the actual `dist/portal/memory-grid/` bytes (or an extracted copy of
// the itch archive, via --dir).
//
// What it asserts:
//   * the document and every asset are served from the local test origin only
//   * https/wss are BLOCKED at the browser level for the whole run
//   * no request to /api/, and no request off-origin (attempted or blocked)
//   * the menu renders with all three difficulty tiers
//   * a match starts and the board renders with size² tiles
//   * the ready countdown runs, then the memorize window opens with lit tiles
//     and a live countdown
//   * reconstruction hides the pattern and makes every tile tappable
//   * tapping flips exactly the tapped tiles (aria-pressed agrees) and submitting
//     produces a round result with the answer key and both reconstructions
//   * a WHOLE match can be played to the final screen: the lit tiles are read
//     during memorize and submitted each round, so the match is decided in five
//     rounds without any test-only hooks
//   * the GRYND CTA does not appear on a round result — it belongs to the final
//     screen only
//   * with --expect-cta, the final screen's CTA is intact: sign-in destination,
//     new tab, noopener noreferrer, the question, and it never covers replay;
//     without the flag the CTA and its copy must be absent from the package
//   * replay starts a fresh match
//   * no console errors or uncaught exceptions
//
// Usage:
//   node qa/memory-grid-standalone-check.mjs
//   node qa/memory-grid-standalone-check.mjs --expect-cta        # a CTA-on build
//   node qa/memory-grid-standalone-check.mjs --dir=dist/packages/.verify-extract

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const argv = process.argv.slice(2);
const dirArg = argv.find((entry) => entry.startsWith("--dir="));
const OUT = resolve(
  process.cwd(),
  dirArg ? dirArg.slice("--dir=".length) : "dist/portal/memory-grid",
);

/**
 * The CTA a package may carry (`scripts/package-itch-memory-grid.mjs`). The
 * destination is the production sign-in route, not a landing page.
 */
const EXPECT_CTA = argv.includes("--expect-cta");
const CTA_URL = "https://www.grynd.dedyn.io/sign-in";
const CTA_LABEL = "Sign in to GRYND";
const CTA_QUESTION = "Want to track your stats and compete in ranked games?";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

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

assert.ok(existsSync(join(OUT, "index.html")), `no index.html in ${OUT} — run the build first`);

// ── 1. Static server for the package ─────────────────────────────────────

const server = createServer((req, res) => {
  const requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const safe = normalize(requested).replace(/^([/\\])+/, "");
  let file = join(OUT, safe || "index.html");
  if (!file.startsWith(OUT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

// ── 2. Chrome, headless, over CDP ────────────────────────────────────────

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
assert.ok(chromePath, "Chrome not found — set CHROME_PATH to a Chrome/Chromium binary");

const profile = mkdtempSync(join(tmpdir(), "grynd-memory-grid-check-"));

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
  { stdio: ["ignore", "ignore", "pipe"] },
);

const browserWs = await new Promise((done, fail) => {
  let buffered = "";
  const timer = setTimeout(
    () => fail(new Error("Chrome did not report a DevTools endpoint")),
    25_000,
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
  const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((r) => r.json());
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
const events = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const settle = pending.get(message.id);
    pending.delete(message.id);
    settle?.(message);
    return;
  }
  events.push(message);
});

function send(method, params = {}) {
  const id = (messageId += 1);
  return new Promise((done, fail) => {
    pending.set(id, (message) =>
      message.error
        ? fail(new Error(`${method}: ${JSON.stringify(message.error)}`))
        : done(message.result),
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
    await sleep(120);
  }
}

const clickSelector = (selector) =>
  evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false; el.click(); return true; })()`,
  );

const phaseIs = (label) =>
  `document.querySelector('[data-testid="phase-label"]')?.textContent.trim() === ${JSON.stringify(label)}`;

const countTiles = (state) =>
  evaluate(
    `document.querySelectorAll('[data-testid="memory-tile"]${
      state ? `[data-tile-state="${state}"]` : ""
    }').length`,
  );

const result = { requests: [], checks: [] };
const note = (message) => result.checks.push(message);

try {
  await send("Network.enable");
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");

  // THE OFFLINE CONDITION: every https/wss request the page attempts is blocked
  // by the browser itself. The local test origin stays reachable so the package
  // can be served — which is exactly the "opened from disk with no network"
  // situation a portal package has to survive.
  await send("Network.setBlockedURLs", { urls: ["https://*", "wss://*"] });

  await send("Page.navigate", { url: `${BASE}/index.html` });
  await until("the app to mount", "!!document.querySelector('#root > *')");
  note("document + bundle loaded from the local origin");

  // ── Menu ────────────────────────────────────────────────────────────
  assert.equal(
    await evaluate("document.body.textContent.includes('Start match')"),
    true,
    "the menu must render",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('[data-testid^=\"difficulty-\"]').length"),
    3,
    "the menu must offer all three tiers",
  );
  note("menu rendered with three difficulty tiers");

  assert.equal(await clickSelector('[data-testid="start-match"]'), true);
  await until("the board to render", "!!document.querySelector('[data-testid=\"memory-board\"]')");
  note("a new match started and the board rendered");

  // ── Ready → memorize ────────────────────────────────────────────────
  await until("the memorize phase", phaseIs("Memorize"), 20_000);

  const board = await evaluate(
    `(() => { const el = document.querySelector('[data-testid="memory-board"]');
      return { size: Number(el.dataset.gridSize),
        tiles: el.querySelectorAll('[data-testid="memory-tile"]').length }; })()`,
  );
  assert.ok(board.size >= 3 && board.size <= 5, `unexpected grid size ${board.size}`);
  assert.equal(board.tiles, board.size * board.size, "the board must be square");

  const lit = await countTiles("pattern");
  assert.ok(lit > 0 && lit < board.tiles, `a memorize round must light some tiles, not all (${lit})`);
  const countdown = await evaluate(
    "document.querySelector('[data-testid=\"countdown\"]')?.textContent.trim() ?? ''",
  );
  assert.match(countdown, /^\d\.\ds$/, `the memorize countdown should show tenths (got "${countdown}")`);
  note(`round 1 memorize: ${board.size}x${board.size}, ${lit} lit, countdown ${countdown}`);

  // ── Play the whole match ────────────────────────────────────────────
  // Each round: read the lit tiles during memorize, click exactly those during
  // reconstruction, submit. That is perfect recall, so the match is decided in
  // five rounds (a level total would deal the 6x6 tiebreak) and the final screen
  // is reached with no test-only hooks. Real time, roughly ninety seconds.
  let finished = false;
  let roundsPlayed = 0;

  for (let round = 1; round <= 6 && !finished; round += 1) {
    await until(`round ${round}: memorize`, phaseIs("Memorize"), 30_000);

    const lit = await evaluate(
      `(() => [...document.querySelectorAll('[data-testid="memory-tile"]')]
        .map((el, index) => ({ index, state: el.dataset.tileState }))
        .filter((tile) => tile.state === 'pattern')
        .map((tile) => tile.index))()`,
    );
    assert.ok(lit.length > 0, `round ${round} must light at least one tile`);

    await until(`round ${round}: reconstruct`, phaseIs("Recreate the pattern"), 30_000);
    assert.equal(await countTiles("pattern"), 0, "the pattern must be hidden");
    const tilesNow = await evaluate(
      `document.querySelectorAll('[data-testid="memory-tile"]').length`,
    );
    assert.equal(await countTiles("rest"), tilesNow, "every tile must be tappable");
    if (round === 1) note("pattern hidden; every tile tappable");

    await evaluate(
      `(() => { const tiles = [...document.querySelectorAll('[data-testid="memory-tile"]')];
        for (const index of ${JSON.stringify(lit)}) tiles[index].click();
        return true; })()`,
    );
    await until(
      `round ${round}: the lit tiles to be selected`,
      `document.querySelectorAll('[data-tile-state="selected"]').length === ${lit.length}`,
      10_000,
    );
    if (round === 1) {
      assert.equal(
        await evaluate(
          `document.querySelectorAll('[data-testid="memory-tile"][aria-pressed="true"]').length`,
        ),
        lit.length,
        "aria-pressed must agree with the selected tiles",
      );
      note(`${lit.length} tiles selected; aria-pressed agrees`);
    }

    await until("the submit control", "!!document.querySelector('[data-testid=\"submit-picks\"]')");
    assert.equal(await clickSelector('[data-testid="submit-picks"]'), true);
    await until("the submit control to lock", "!document.querySelector('[data-testid=\"submit-picks\"]')");

    await until(
      `round ${round}: the round result`,
      "!!document.querySelector('[data-testid=\"round-result\"]')",
      30_000,
    );
    roundsPlayed = round;

    if (round === 1) {
      const roundText = await evaluate(
        "document.querySelector('[data-testid=\"round-result\"]').textContent",
      );
      assert.match(roundText, /ROUND 1\/5/);
      assert.match(roundText, /Correct Pattern/);
      assert.match(roundText, /Your Reconstruction/);
      assert.match(roundText, /GRYND AI: Reconstruction/);
      assert.equal(
        await evaluate("document.querySelectorAll('[data-review=\"picks\"]').length"),
        2,
        "the result must show both reconstructions",
      );
      assert.equal(
        await evaluate("document.querySelectorAll('[data-testid=\"result-stat\"]').length"),
        6,
        "each reconstruction must show accuracy, time and score",
      );
      assert.equal(
        await evaluate("!!document.querySelector('[data-testid=\"grynd-cta\"]')"),
        false,
        "the CTA belongs to the final screen, never a round result",
      );
      note("round 1 result: answer key + both reconstructions with accuracy/time/score");
    }

    // The result window closes into either the next round's memorize phase or
    // the finished match. Wait for whichever it is.
    await until(
      `round ${round}: the result window to close`,
      `(() => !!document.querySelector('[data-testid="result-overlay"]') ||
        document.querySelector('[data-testid="phase-label"]')?.textContent.trim() === 'Memorize')()`,
      30_000,
    );
    finished = await evaluate("!!document.querySelector('[data-testid=\"result-overlay\"]')");
  }

  assert.equal(finished, true, "the match must reach its final screen");
  assert.ok(roundsPlayed >= 5, `a decided match needs five rounds, played ${roundsPlayed}`);
  note(`played ${roundsPlayed} round(s) with perfect recall; the match finished`);

  // ── The final screen ────────────────────────────────────────────────
  const outcome = await evaluate(
    "document.querySelector('[data-testid=\"result-outcome\"]')?.textContent.trim() ?? ''",
  );
  assert.ok(["VICTORY", "DEFEAT", "DRAW"].includes(outcome), `unexpected outcome "${outcome}"`);
  const duration = await evaluate(
    "document.querySelector('[data-testid=\"result-duration\"]')?.textContent.trim() ?? ''",
  );
  assert.match(duration, /Match time \d+:\d{2}/);
  const finalText = await evaluate(
    "document.querySelector('[data-testid=\"result-overlay\"]').textContent",
  );
  assert.match(finalText, /Round by round/);
  const rows = await evaluate("document.querySelectorAll('[data-testid=\"round-row\"]').length");
  assert.ok(rows >= 5 && rows <= 6, `unexpected round-row count ${rows}`);
  note(`final screen: ${outcome}, ${duration}, ${rows} round rows`);

  // ── The CTA ─────────────────────────────────────────────────────────
  const ctaPresent = await evaluate("!!document.querySelector('[data-testid=\"grynd-cta\"]')");
  if (EXPECT_CTA) {
    assert.equal(ctaPresent, true, "a CTA-enabled build must show the CTA when the match ends");
    const cta = await evaluate(
      `(() => { const link = document.querySelector('[data-testid="grynd-cta-link"]');
        return link ? { href: link.getAttribute('href'), rel: link.getAttribute('rel'),
          target: link.getAttribute('target'), text: link.textContent.trim() } : null; })()`,
    );
    assert.ok(cta, "the CTA link is missing");
    assert.equal(cta.href, CTA_URL, "the CTA must point at the GRYND sign-in route");
    assert.equal(cta.rel, "noopener noreferrer");
    assert.equal(cta.target, "_blank");
    assert.equal(cta.text, CTA_LABEL);

    const ctaText = await evaluate(
      "document.querySelector('[data-testid=\"grynd-cta\"]').textContent",
    );
    assert.ok(ctaText.includes(CTA_QUESTION), "the CTA question must be present");
    assert.doesNotMatch(ctaText, /saved|uploaded|recorded|transferred|synced/i);

    const layout = await evaluate(
      `(() => {
        const cta = document.querySelector('[data-testid="grynd-cta"]');
        const outcomeEl = document.querySelector('[data-testid="result-outcome"]');
        const durationEl = document.querySelector('[data-testid="result-duration"]');
        const replay = document.querySelector('[data-testid="result-replay"]');
        if (!cta || !outcomeEl || !durationEl || !replay) return null;
        const c = cta.getBoundingClientRect();
        const o = outcomeEl.getBoundingClientRect();
        const d = durationEl.getBoundingClientRect();
        const r = replay.getBoundingClientRect();
        const overlaps = (a, b) => a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;
        return { belowResult: c.top >= Math.max(o.bottom, d.bottom) - 1,
          overlapsReplay: overlaps(c, r), replayVisible: r.width > 0 && r.height > 0 };
      })()`,
    );
    assert.ok(layout, "the result layout could not be measured");
    assert.equal(layout.belowResult, true, "the CTA must sit below the match result information");
    assert.equal(layout.overlapsReplay, false, "the CTA must not cover the replay button");
    assert.equal(layout.replayVisible, true, "the replay button must stay visible");
    note("CTA on the final screen: sign-in route, new tab, below the result, replay visible");
  } else {
    assert.equal(ctaPresent, false, "the CTA must be absent in a default build");
    for (const copy of [CTA_LABEL, CTA_QUESTION]) {
      assert.equal(
        await evaluate(`document.body.innerHTML.includes(${JSON.stringify(copy)})`),
        false,
        `no GRYND CTA copy may ship in a default package (${copy})`,
      );
    }
    note("CTA absent (default: disabled)");
  }

  // ── Replay ──────────────────────────────────────────────────────────
  assert.equal(await clickSelector('[data-testid="result-replay"]'), true);
  await until(
    "the final screen to clear",
    "!document.querySelector('[data-testid=\"result-overlay\"]')",
  );
  await until("a fresh match", "!!document.querySelector('[data-testid=\"memory-board\"]')");
  note("replay started a fresh match");

  // ── Isolation ───────────────────────────────────────────────────────
  result.requests = events
    .filter((event) => event.method === "Network.requestWillBeSent")
    .map((event) => event.params.request.url);

  const offOrigin = result.requests.filter((url) => !url.startsWith(BASE));
  assert.deepEqual(offOrigin, [], `off-origin request(s): ${offOrigin.join(", ")}`);

  const apiCalls = result.requests.filter((url) => /\/api\//.test(url));
  assert.deepEqual(apiCalls, [], `API request(s): ${apiCalls.join(", ")}`);

  const requestUrls = new Map(
    events
      .filter((event) => event.method === "Network.requestWillBeSent")
      .map((event) => [event.params.requestId, event.params.request.url]),
  );
  const blocked = events
    .filter((event) => event.method === "Network.loadingFailed")
    .map((event) => ({ ...event.params, url: requestUrls.get(event.params.requestId) ?? "" }))
    .filter((failure) => failure.blockedReason || failure.corsErrorStatus);
  assert.deepEqual(blocked, [], "a request was blocked, so the package is not self-contained");
  note(
    `${result.requests.length} request(s), all same-origin: ${result.requests
      .map((url) => url.replace(BASE, ""))
      .join(", ")}`,
  );

  // ── Console health ──────────────────────────────────────────────────
  const consoleErrors = events
    .filter(
      (event) =>
        event.method === "Runtime.exceptionThrown" ||
        (event.method === "Runtime.consoleAPICalled" && event.params.type === "error"),
    )
    .map((event) => JSON.stringify(event.params).slice(0, 300));
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(" | ")}`);
  note("no console errors or uncaught exceptions");
} finally {
  socket.close();
  await fetch(`http://127.0.0.1:${devtoolsPort}/json/close/${pageTarget.id}`).catch(() => {});
  chrome.kill();
  server.close();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // a still-shutting-down Chrome can hold the profile on Windows; harmless
  }
}

console.log(`\nPASS  ${OUT}\n`);
for (const check of result.checks) console.log(`  · ${check}`);
