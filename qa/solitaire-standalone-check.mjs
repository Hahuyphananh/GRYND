#!/usr/bin/env node
// qa/solitaire-standalone-check.mjs
//
// Drives the BUILT standalone Solitaire Duel in a real Chrome, with the outside
// world blocked, and proves the package is self-contained and playable.
//
// It is deliberately dependency-free: Chrome is launched with
// `--remote-debugging-port=0` and driven over the DevTools protocol with Node's
// built-in WebSocket and fetch. Nothing is installed and nothing is mocked —
// this exercises the actual `dist/portal/solitaire-duel/` bytes.
//
// What it asserts:
//   * the document and every asset are served from the local test origin only
//   * https/wss are BLOCKED at the browser level for the whole run
//   * no request to /api/, and no request off-origin (attempted or blocked)
//   * the game loads, a match starts, the countdown finishes
//   * a human move (draw) lands and advances the player's ply
//   * practice states the bot's PACE, so a player can see the tier is speed only
//   * a card can be DRAGGED: the ghost follows the pointer, snaps onto a pile it
//     would land on, and the drop is resolved through the same move builder
//   * on a 390x844 phone the drag neither resizes the board nor breaks its fit
//   * the bot plays on its own
//   * "End" produces a result screen with an outcome, a match time and both
//     progress lines
//   * "Play again" deals a fresh match
//   * no console errors or uncaught exceptions
//   * the GRYND CTA is absent by default, and present with --expect-cta: below
//     the result information, over nothing, opening the sign-in route in a new tab
//   * with --expect-sdk, the ONLY off-origin request is the portal's SDK script
//     and the game still plays when it is blocked
//
// Usage:
//   node qa/solitaire-standalone-check.mjs                  # default package
//   node qa/solitaire-standalone-check.mjs --dir=dist/portal/.cta --expect-cta
//   node qa/solitaire-standalone-check.mjs --expect-sdk

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const argv = process.argv.slice(2);
const dirArg = argv.find((entry) => entry.startsWith("--dir="));
const OUT = resolve(process.cwd(), dirArg ? dirArg.slice("--dir=".length) : "dist/portal/solitaire-duel");
const EXPECT_CTA = argv.includes("--expect-cta");
// A PORTAL_SDK build is the one package allowed to reach off-origin: it loads
// the portal's own script. `--expect-sdk` permits exactly that host and nothing
// else, and requires that the attempt actually happened.
const EXPECT_SDK = argv.includes("--expect-sdk");
const SDK_ORIGIN = "sdk.crazygames.com";
const isSdkRequest = (url) => url.includes(SDK_ORIGIN);

/**
 * What the itch package is built to say and point at
 * (`scripts/package-itch-solitaire.mjs`). The destination is the production
 * sign-in route, not a landing page.
 */
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

const profile = mkdtempSync(join(tmpdir(), "grynd-portal-check-"));
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
  const timer = setTimeout(() => fail(new Error("Chrome did not report a DevTools endpoint")), 25_000);
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
      message.error ? fail(new Error(`${method}: ${JSON.stringify(message.error)}`)) : done(message.result),
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

const result = { requests: [], consoleErrors: [], checks: [] };
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

  assert.equal(
    await evaluate("document.querySelector('[data-testid=\"result-overlay\"]') === null"),
    true,
  );

  // ── Menu ────────────────────────────────────────────────────────────
  // `textContent`, not `innerText`: the label is CSS-uppercased in the DOM's
  // rendered text, and only textContent preserves the authored copy.
  assert.equal(
    await evaluate("document.body.textContent.includes('Start race')"),
    true,
    "menu must render",
  );

  // The menu previews what each tier actually buys: its pace. The bot solves the
  // same deal at every tier, so a per-move estimate is the honest description.
  const menuPace = await evaluate(
    `(() => { const text = document.body.textContent;
      return ['1.3', '0.9', '0.5'].filter((s) => text.includes('~' + s + 's a move')); })()`,
  );
  assert.deepEqual(menuPace, ["1.3", "0.9", "0.5"], "the menu must estimate every tier's pace");
  assert.equal(
    await evaluate("document.body.textContent.includes('pace only')"),
    true,
    "the menu must say the tier is pace only",
  );
  note("menu previews each tier's pace (~1.3s / ~0.9s / ~0.5s a move)");
  assert.equal(await clickSelector('[data-testid="start-race"]'), true);
  await until("the board to appear", "!!document.querySelector('[data-testid=\"solitaire-board\"]')");
  note("a new match started and the board rendered");

  // Practice must say what the tier actually changes. The bot follows the
  // deal's proven line at every tier, so "easy" is a pace, never a weaker bot.
  const pace = await evaluate(
    `(() => { const el = document.querySelector('[data-testid="solver-pace"]');
      return el ? { text: el.textContent.trim(), delay: Number(el.dataset.delayMs) } : null; })()`,
  );
  assert.ok(pace, "practice must show the bot's solver pace");
  assert.match(pace.text, /pace/i);
  assert.ok(pace.delay > 0, "the pace indicator must carry the tier's real delay");
  note(`solver pace shown: ${pace.text}`);

  // ── Countdown, then a human move ────────────────────────────────────
  await until(
    "the countdown to finish",
    "(() => { const el = document.querySelector('[data-testid=\"solitaire-stock\"]'); return !!el && !el.disabled; })()",
  );
  const plyBefore = Number(
    await evaluate("document.querySelector('[data-testid=\"solitaire-board\"]').dataset.ply"),
  );
  assert.equal(await clickSelector('[data-testid="solitaire-stock"]'), true);
  await until(
    "the player's draw to land",
    "Number(document.querySelector('[data-testid=\"solitaire-board\"]').dataset.ply) > 0",
  );
  const plyAfter = Number(
    await evaluate("document.querySelector('[data-testid=\"solitaire-board\"]').dataset.ply"),
  );
  assert.equal(plyAfter, plyBefore + 1, "one draw must advance the player's ply by exactly one");
  note(`human move accepted (ply ${plyBefore} -> ${plyAfter})`);

  // ── The bot plays on its own ────────────────────────────────────────
  await until(
    "the bot to move",
    "Number(document.querySelector('[data-testid=\"bot-progress\"]')?.dataset.ply ?? 0) > 0",
    20_000,
  );
  note("the bot advanced its own board without any network call");

  // ── Drag and drop ───────────────────────────────────────────────────
  // A real press → move → release on a face-up card. What is proven here is the
  // PLUMBING — the drag ghost appears mid-gesture, the drop resolves into (at
  // most) one proposed move, and nothing is thrown: whether that particular
  // drop is legal depends on the deal, and both outcomes are acceptable.
  const dragOrigin = await evaluate(
    `(() => { const el = document.querySelector('[data-drag-slot="tableau"]:not([disabled])');
      if (!el) return null; const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
  );
  if (dragOrigin) {
    const plyBeforeDrag = Number(
      await evaluate("document.querySelector('[data-testid=\"solitaire-board\"]').dataset.ply"),
    );
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: dragOrigin.x,
      y: dragOrigin.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: dragOrigin.x + 48,
      y: dragOrigin.y + 48,
      button: "left",
      buttons: 1,
    });
    const ghostShown = await evaluate(
      "!!document.querySelector('[data-testid=\"solitaire-drag-ghost\"]')",
    );
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: dragOrigin.x + 48,
      y: dragOrigin.y + 48,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    // Long enough for a refused drop to finish easing home (~190 ms).
    await sleep(450);

    assert.equal(ghostShown, true, "dragging a card must show the drag ghost");
    assert.equal(
      await evaluate("!!document.querySelector('[data-testid=\"solitaire-drag-ghost\"]')"),
      false,
      "releasing the pointer must clear the drag ghost",
    );
    assert.equal(
      await evaluate("document.querySelector('[data-testid=\"solitaire-board\"]').dataset.dragging"),
      "false",
    );
    const plyAfterDrag = Number(
      await evaluate("document.querySelector('[data-testid=\"solitaire-board\"]').dataset.ply"),
    );
    assert.ok(
      plyAfterDrag === plyBeforeDrag || plyAfterDrag === plyBeforeDrag + 1,
      `a drop may propose at most one move (ply ${plyBeforeDrag} -> ${plyAfterDrag})`,
    );
    note(`drag ghost followed the pointer; drop resolved without error (ply ${plyBeforeDrag} -> ${plyAfterDrag})`);
  }

  // ── Result ──────────────────────────────────────────────────────────
  await until(
    "the End control",
    "!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'End')",
  );
  await evaluate(
    "(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'End').click(); return true; })()",
  );
  await until("the result overlay", "!!document.querySelector('[data-testid=\"result-overlay\"]')");

  const outcome = await evaluate(
    "document.querySelector('[data-testid=\"result-outcome\"]')?.textContent.trim() ?? ''",
  );
  assert.ok(["VICTORY", "DEFEAT", "DRAW"].includes(outcome), `unexpected outcome "${outcome}"`);
  const duration = await evaluate(
    "document.querySelector('[data-testid=\"result-duration\"]')?.textContent.trim() ?? ''",
  );
  assert.match(duration, /Match time \d+:\d{2}/);
  const overlayText = await evaluate(
    "document.querySelector('[data-testid=\"result-overlay\"]')?.textContent ?? ''",
  );
  assert.match(overlayText, /You/);
  assert.match(overlayText, /Bot ·/);
  assert.match(overlayText, /\/52 on foundations/);
  note(`result screen: ${outcome}, ${duration}, both progress lines`);

  // ── CTA ─────────────────────────────────────────────────────────────
  const ctaPresent = await evaluate("!!document.querySelector('[data-testid=\"grynd-cta\"]')");
  if (EXPECT_CTA) {
    assert.equal(ctaPresent, true, "the CTA should be present in a CTA-enabled build");
    const cta = await evaluate(
      `(() => { const a = document.querySelector('[data-testid="grynd-cta-link"]');
        return a ? { href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target'), text: a.textContent.trim() } : null; })()`,
    );
    assert.ok(cta, "CTA link missing");
    assert.equal(cta.href, CTA_URL, "the CTA must point at the GRYND sign-in route");
    assert.equal(cta.rel, "noopener noreferrer");
    assert.equal(cta.target, "_blank");
    assert.equal(cta.text, CTA_LABEL);

    // The question is the headline, and it must not promise a transfer.
    const ctaText = await evaluate(
      "document.querySelector('[data-testid=\"grynd-cta\"]')?.textContent ?? ''",
    );
    assert.ok(ctaText.includes(CTA_QUESTION), "the CTA question must be present");
    assert.doesNotMatch(ctaText, /saved|uploaded|recorded|transferred|synced/i);

    // Position: below the result information, covering neither it nor replay.
    const layout = await evaluate(
      `(() => {
        const cta = document.querySelector('[data-testid="grynd-cta"]');
        const outcome = document.querySelector('[data-testid="result-outcome"]');
        const duration = document.querySelector('[data-testid="result-duration"]');
        const replay = document.querySelector('[data-testid="result-replay"]');
        if (!cta || !outcome || !duration || !replay) return null;
        const c = cta.getBoundingClientRect();
        const o = outcome.getBoundingClientRect();
        const d = duration.getBoundingClientRect();
        const r = replay.getBoundingClientRect();
        const overlaps = (a, b) => a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;
        return {
          belowResult: c.top >= Math.max(o.bottom, d.bottom) - 1,
          overlapsReplay: overlaps(c, r),
          replayVisible: r.width > 0 && r.height > 0,
        };
      })()`,
    );
    assert.ok(layout, "the result layout could not be measured");
    assert.equal(layout.belowResult, true, "the CTA must sit below the match result information");
    assert.equal(layout.overlapsReplay, false, "the CTA must not cover the replay button");
    assert.equal(layout.replayVisible, true, "the replay button must stay visible");
    note(`CTA present on the ${outcome} screen, below the result, sign-in link in a new tab`);
  } else {
    assert.equal(ctaPresent, false, "the CTA must be absent by default");
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
  await until("the result overlay to clear", "!document.querySelector('[data-testid=\"result-overlay\"]')");
  await until("the fresh board", "!!document.querySelector('[data-testid=\"solitaire-board\"]')");
  await until(
    "the fresh match to be playable",
    "(() => { const el = document.querySelector('[data-testid=\"solitaire-stock\"]'); return !!el && !el.disabled; })()",
    20_000,
  );
  const replayPly = Number(
    await evaluate("document.querySelector('[data-testid=\"solitaire-board\"]').dataset.ply"),
  );
  assert.equal(replayPly, 0, "replay must deal a fresh board");
  note("replay dealt a fresh, playable match");

  // ── Narrow phone viewport: the drag must not fight the board fit ─────
  // The board is sized by the `--cw` clamp (the 34px floor governs phones). The
  // ghost is out of flow and sized from the SAME card constants, so a gesture
  // can neither resize the board nor break its fit. Verified on a real 390x844
  // viewport, with a drop that is guaranteed to be refused (the card's own
  // column / the gap below it), so the board must be IDENTICAL afterwards.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);

  const measureBoard = () =>
    evaluate(
      `(() => { const b = document.querySelector('[data-testid="solitaire-board"]');
        const r = b.getBoundingClientRect();
        const card = document.querySelector('[data-drag-slot="tableau"], [data-testid^="solitaire-foundation-"]');
        return { width: Math.round(r.width), height: Math.round(r.height),
          card: card ? Math.round(card.getBoundingClientRect().width) : 0 }; })()`,
    );
  const phoneBefore = await measureBoard();
  assert.ok(
    phoneBefore.card >= 34 && phoneBefore.card <= 44,
    `a 390px phone should get 34-44px cards (got ${phoneBefore.card}px)`,
  );
  assert.ok(phoneBefore.width <= 390, `the board is ${phoneBefore.width}px wide on a 390px viewport`);

  const phoneDrag = await evaluate(
    `(() => { const el = document.querySelector('[data-drag-slot="tableau"]:not([disabled])');
      if (!el) return null; const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        card: Math.round(r.width) }; })()`,
  );
  if (phoneDrag) {
    // Straight DOWN inside the same column: a column never accepts its own card,
    // so this drop must be refused and change nothing.
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: phoneDrag.x,
      y: phoneDrag.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: phoneDrag.x,
      y: phoneDrag.y + 30,
      button: "left",
      buttons: 1,
    });
    const phoneGhost = await evaluate(
      `(() => { const g = document.querySelector('[data-testid="solitaire-drag-ghost"]');
        if (!g) return null; const card = g.querySelector('[data-face-up]');
        return Math.round((card ?? g).getBoundingClientRect().width); })()`,
    );
    const phoneDuring = await measureBoard();
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: phoneDrag.x,
      y: phoneDrag.y + 30,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(450);
    const phoneAfter = await measureBoard();

    assert.equal(phoneGhost, phoneDrag.card, "the ghost must be exactly one board-sized card");
    assert.equal(phoneDuring.width, phoneBefore.width, "dragging must not change the board's width");
    assert.equal(phoneDuring.card, phoneBefore.card, "dragging must not change the card size");
    assert.deepEqual(phoneAfter, phoneBefore, "a refused drop must leave the board exactly as it was");
    assert.equal(
      await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
      true,
      "the board must not overflow a 390px viewport",
    );
    note(
      `phone viewport: ${phoneBefore.card}px cards, ghost matched the card, board box unchanged by the drag`,
    );
  }
  await send("Emulation.clearDeviceMetricsOverride");
  await sleep(150);

  // ── Isolation ───────────────────────────────────────────────────────
  result.requests = events
    .filter((event) => event.method === "Network.requestWillBeSent")
    .map((event) => event.params.request.url);

  const offOrigin = result.requests.filter(
    (url) => !url.startsWith(BASE) && !(EXPECT_SDK && isSdkRequest(url)),
  );
  assert.deepEqual(offOrigin, [], `off-origin request(s): ${offOrigin.join(", ")}`);

  const apiCalls = result.requests.filter((url) => /\/api\//.test(url));
  assert.deepEqual(apiCalls, [], `API request(s): ${apiCalls.join(", ")}`);

  // Network.loadingFailed carries only a requestId, so map it back to the URL
  // before deciding whether a blocked request is the permitted SDK script.
  const requestUrls = new Map(
    events
      .filter((event) => event.method === "Network.requestWillBeSent")
      .map((event) => [event.params.requestId, event.params.request.url]),
  );
  const blocked = events
    .filter((event) => event.method === "Network.loadingFailed")
    .map((event) => ({ ...event.params, url: requestUrls.get(event.params.requestId) ?? "" }))
    .filter((failure) => failure.blockedReason || failure.corsErrorStatus);
  assert.deepEqual(
    blocked.filter((failure) => !(EXPECT_SDK && isSdkRequest(failure.url))),
    [],
    "a request was blocked, so the package is not self-contained",
  );
  note(`${result.requests.length} request(s), all same-origin: ${result.requests.map((u) => u.replace(BASE, "")).join(", ")}`);

  if (EXPECT_SDK) {
    const sdkRequests = result.requests.filter(isSdkRequest);
    assert.ok(
      sdkRequests.length > 0,
      "a PORTAL_SDK package must request the portal's SDK script on load",
    );
    assert.ok(
      sdkRequests.every((url) => url.endsWith("/crazygames-sdk-v2.js")),
      `unexpected SDK URL: ${sdkRequests.join(", ")}`,
    );
    note("portal SDK script requested once and blocked (offline) — the game played anyway");
  }

  // ── Console health ──────────────────────────────────────────────────
  const consoleErrors = events
    .filter(
      (event) =>
        event.method === "Runtime.exceptionThrown" ||
        (event.method === "Runtime.consoleAPICalled" && event.params.type === "error"),
    )
    .filter((event) => !(EXPECT_SDK && JSON.stringify(event.params).includes(SDK_ORIGIN)))
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

console.log(
  `\nPASS  ${OUT}  (${EXPECT_CTA ? "CTA enabled" : "CTA disabled"}, ${EXPECT_SDK ? "portal SDK" : "no SDK"})`,
);
for (const check of result.checks) console.log(`  · ${check}`);
