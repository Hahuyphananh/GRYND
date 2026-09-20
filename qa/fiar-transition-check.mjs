// qa/fiar-transition-check.mjs
//
// Browser check for Four-In-A-Row's match-state TRANSITIONS. Mounts the REAL
// multiplayer page (qa/fiar-winline-harness.jsx, bundled with the shared stubs
// in qa/fiar-multiplayer-page.mjs) against a mocked game-state API and asserts,
// on the live DOM:
//
//   1. MATCH START is a cross-fade, not a hard cut: when the status leaves
//      matchmaking the takeover is held for its own exit fade (opacity between
//      1 and 0) and the board is already there underneath — it never disappears.
//   2. Polling the SAME status can never replay that transition.
//   3. The result panel is handed off through its own exit fade when the match
//      leaves the result state (a rematch was accepted) instead of vanishing.
//   4. Exactly ONE result panel exists at any time (no duplicate result UI).
//   5. Nothing is left behind afterwards (no stale takeover / result nodes).
//   6. `prefers-reduced-motion` removes both immediately — no held nodes.
//
// Run: node qa/fiar-transition-check.mjs

import { chromium } from "playwright";
import { mountHarness } from "./fiar-multiplayer-page.mjs";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const { base, close: closeHarness } = await mountHarness({
  title: "Four-In-A-Row transition check",
});

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ channel: "chrome" });
  }
}

const emptyBoard = () => Array.from({ length: 6 }, () => Array(7).fill(0));

// A live match. `role: "host"` — the harness page plays the host seat.
const liveState = (status, overrides = {}) => ({
  status,
  result: null,
  role: "host",
  hostClerkId: "host1",
  guestClerkId: "guest1",
  hostName: "You",
  guestName: "Opponent",
  hostDiscsUsed: 2,
  guestDiscsUsed: 2,
  betAmount: 0,
  isAiGame: false,
  board: emptyBoard(),
  currentTurn: "host",
  moveTimeLimit: 60,
  moveTimeRemaining: 42,
  replayTimeRemaining: 20,
  ...overrides,
});

// A finished, won match (host = disc 1, four on the bottom row).
const finishedState = (overrides = {}) => {
  const board = emptyBoard();
  for (const [row, col] of [[5, 0], [5, 1], [5, 2], [5, 3]]) board[row][col] = 1;
  return liveState("finished", {
    result: "win",
    winnerClerkId: "host1",
    hostDiscsUsed: 4,
    moveTimeRemaining: 0,
    board,
    ...overrides,
  });
};

// Mount the real page on `state` and let the first paint settle.
async function mount(page, state) {
  await page.evaluate((s) => window.mountGame(s), state);
  await page.waitForSelector(".four-in-a-row-board");
  await page.waitForTimeout(200);
}

// Poll for the element's opacity to be strictly between 1 and 0 — i.e. a fade
// genuinely in progress rather than an instant removal. Resolves to the opacity
// it caught, or null if it never faded.
async function caughtFading(page, testId, timeout = 2500) {
  try {
    const handle = await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return false;
        const opacity = Number(getComputedStyle(el).opacity);
        return opacity > 0.01 && opacity < 0.99 ? opacity : false;
      },
      testId,
      { timeout, polling: 16 },
    );
    return await handle.jsonValue();
  } catch {
    return null;
  }
}

const countOf = (page, selector) => page.evaluate((s) => document.querySelectorAll(s).length, selector);

// Frame-sample `testId`'s presence + opacity around `action`, so a short exit
// fade can never be missed by luck of timing.
async function sampleDuring(page, testId, ms, action) {
  await page.evaluate((id) => {
    window.__samples = [];
    window.__sampling = true;
    const tick = () => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      window.__samples.push({
        present: Boolean(el),
        opacity: el ? Number(getComputedStyle(el).opacity) : null,
      });
      if (window.__sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, testId);
  await action();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    window.__sampling = false;
    return window.__samples;
  });
}

try {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.mountGame);

  // ── 1. Matchmaking → match start is a cross-fade ──────────────────────
  await mount(page, liveState("waiting"));
  const waiting = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="fiar-match-waiting"]');
    return { present: Boolean(el), state: el?.dataset.state ?? null };
  });
  check(
    "matchmaking: the takeover is up, in the waiting state",
    waiting.present === true && waiting.state === "waiting",
    JSON.stringify(waiting),
  );

  // The match starts (picked up by the 1.5s matchmaking poll).
  await page.evaluate((s) => {
    window.__fiarGameState = s;
  }, liveState("in_progress"));
  const fading = await caughtFading(page, "fiar-match-waiting");
  check(
    "match start: the takeover is HELD through its own exit fade, not cut",
    fading !== null,
    `caughtOpacity=${fading}`,
  );
  const underneath = await countOf(page, ".four-in-a-row-board");
  check(
    "match start: the board is already there underneath the fading takeover",
    underneath === 1,
    `boards=${underneath}`,
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="fiar-match-waiting"]') === null,
    null,
    { timeout: 2000 },
  );
  check("match start: the takeover then removes itself", true, "");

  // ── 2. The same status polled again cannot replay it ──────────────────
  // Back to matchmaking, then hold the SAME status across several 1.5s polls.
  await mount(page, liveState("waiting"));
  await page.waitForTimeout(3400);
  const steady = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="fiar-match-waiting"]');
    if (!el) return null;
    const running = el.getAnimations().filter((a) => a.playState === "running").length;
    return { opacity: Number(getComputedStyle(el).opacity), running };
  });
  check(
    "polling the same status never replays the takeover transition",
    steady !== null &&
      steady.opacity === 1 &&
      steady.running === 0,
    JSON.stringify(steady),
  );

  const steadyBoards = await countOf(page, ".four-in-a-row-board");
  check(
    "matchmaking: the board is kept mounted the whole time (never disappears)",
    steadyBoards === 1,
    `boards=${steadyBoards}`,
  );

  // ── 3/4/5. Result panel hand-off ──────────────────────────────────────
  // The stubbed panel is an empty div (zero size), so wait for it to ATTACH.
  await mount(page, finishedState());
  await page.waitForSelector('[data-testid="fiar-result-overlay"]', { state: "attached" });
  const open = await countOf(page, '[data-testid="fiar-result-overlay"]');
  check(
    "result: exactly ONE result panel is up once the reveal has settled",
    open === 1,
    `panels=${open}`,
  );

  // The opponent accepts a rematch → the page leaves the result state. A
  // finished/in-progress match polls every 5s, so the window has to cover it.
  const panelSamples = await sampleDuring(page, "fiar-result-transition", 8000, () =>
    page.evaluate((s) => {
      window.__fiarGameState = s;
    }, finishedState({ nextGameId: "2" })),
  );
  const midFade = panelSamples.filter(
    (s) => s.present && s.opacity > 0.01 && s.opacity < 0.99,
  ).length;
  const heldFrames = panelSamples.filter((s) => s.present).length;
  check(
    "result hand-off: the panel fades out instead of vanishing",
    midFade >= 2 && heldFrames >= 3,
    `framesHeld=${heldFrames} midFadeFrames=${midFade} firstOpacity=${panelSamples.find((s) => s.present)?.opacity}`,
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="fiar-result-transition"]') === null,
    null,
    { timeout: 8000 },
  );
  const leftovers = await page.evaluate(
    () => ({
      result: document.querySelectorAll('[data-testid="fiar-result-transition"]').length,
      panels: document.querySelectorAll('[data-testid="fiar-result-overlay"]').length,
      takeover: document.querySelectorAll('[data-testid="fiar-match-waiting"]').length,
    }),
  );
  check(
    "result hand-off: no stale result or takeover nodes are left behind",
    leftovers.result === 0 && leftovers.panels === 0 && leftovers.takeover === 0,
    JSON.stringify(leftovers),
  );

  // ── 6. Reduced motion removes both immediately ────────────────────────
  const rmPage = await browser.newPage({
    viewport: { width: 900, height: 1000 },
    reducedMotion: "reduce",
  });
  await rmPage.goto(base, { waitUntil: "networkidle" });
  await rmPage.waitForFunction(() => window.mountGame);

  await rmPage.evaluate((s) => window.mountGame(s), liveState("waiting"));
  await rmPage.waitForSelector('[data-testid="fiar-match-waiting"]');
  await rmPage.evaluate((s) => {
    window.__fiarGameState = s;
  }, liveState("in_progress"));
  await rmPage.waitForFunction(
    () => document.querySelector('[data-testid="fiar-match-waiting"]') === null,
    null,
    { timeout: 3000 },
  );
  check(
    "reduced motion: the matchmaking takeover is removed immediately",
    true,
    "",
  );

  await rmPage.evaluate((s) => window.mountGame(s), finishedState());
  await rmPage.waitForSelector('[data-testid="fiar-result-overlay"]', { state: "attached" });
  await rmPage.evaluate((s) => {
    window.__fiarGameState = s;
  }, finishedState({ nextGameId: "2" }));
  await rmPage.waitForFunction(
    () => document.querySelector('[data-testid="fiar-result-transition"]') === null,
    null,
    { timeout: 9000 },
  );
  const rmLeft = await countOf(rmPage, '[data-testid="fiar-result-transition"]');
  check(
    "reduced motion: the result panel leaves immediately, with nothing left over",
    rmLeft === 0,
    `nodes=${rmLeft}`,
  );
  await rmPage.close();

  await page.close();
  await browser.close();
} finally {
  closeHarness();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
