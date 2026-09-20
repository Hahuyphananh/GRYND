// qa/fiar-audio-check.mjs
//
// Browser check for Four-In-A-Row's sound feedback. Mounts the REAL
// multiplayer page (qa/fiar-winline-harness.jsx) and the REAL vs-AI page
// (qa/fiar-trail-harness.jsx) — both bundled with the recording audio stub in
// qa/fiar-audio.mjs — and asserts, on the live page:
//
//   1. A quiet mount: entering a match makes no sound until something happens.
//   2. SELECTING fires one cue, immediately, before the disc moves — and a
//      second click while the move is in flight cannot double it.
//   3. LANDING fires once, when the disc reaches the board, and a later poll of
//      the same board never replays it.
//   4. The OPPONENT's disc lands with its own distinct cue.
//   5. The matched turn starting fires one match-start cue.
//   6. WIN / LOSS / DRAW each fire exactly once, and polling the same finished
//      state repeatedly never replays the result cue.
//   7. The vs-AI page: one select + one landing per move for BOTH sides, no
//      accumulation across moves, and a New Game fires the match-start cue.
//   8. Reduced motion still gives one landing cue per drop.
//   9. The global mute gate is respected: nothing reaches the AudioContext.
//
// Run: node qa/fiar-audio-check.mjs

import { chromium } from "playwright";
import { mountHarness } from "./fiar-multiplayer-page.mjs";
import { mountAiHarness } from "./fiar-ai-page.mjs";
import { readCues, countCue, clearCues } from "./fiar-audio.mjs";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const { base, close: closeHarness } = await mountHarness({
  title: "Four-In-A-Row audio check",
});
const { base: aiBase, close: closeAiHarness } = await mountAiHarness({
  title: "Four-In-A-Row vs-AI audio check",
});

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ channel: "chrome" });
  }
}

const emptyBoard = () => Array.from({ length: 6 }, () => Array(7).fill(0));
const boardWith = (cells) => {
  const board = emptyBoard();
  for (const [row, col, value] of cells) board[row][col] = value;
  return board;
};

// A live game. `turn` is the seat on the clock; the harness page is the host.
const liveState = (turn, overrides = {}) => ({
  status: "in_progress",
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
  currentTurn: turn,
  moveTimeLimit: 60,
  moveTimeRemaining: 42,
  replayTimeRemaining: 20,
  ...overrides,
});

const finishedState = (overrides = {}) => {
  const board = boardWith([
    [5, 0, 1],
    [5, 1, 1],
    [5, 2, 1],
    [5, 3, 1],
  ]);
  return {
    ...liveState("host"),
    status: "finished",
    result: "win",
    winnerClerkId: "host1",
    hostDiscsUsed: 4,
    moveTimeRemaining: 0,
    board,
    ...overrides,
  };
};

async function mount(page, state) {
  await page.evaluate((s) => window.mountGame(s), state);
  await page.waitForSelector(".four-in-a-row-board");
  await page.waitForTimeout(200);
}

/** Wait until `cue` has fired at least `n` times. */
async function waitForCue(page, cue, n = 1, timeout = 9000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await countCue(page, cue)) >= n) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

/** Deliver a new game state through the page's own game-state poll. */
async function pushState(page, state) {
  await page.evaluate((s) => {
    window.__fiarGameState = s;
  }, state);
}

// ── A fake-but-real AudioContext probe ─────────────────────────────────
// Extends the browser's real AudioContext and counts constructions +
// oscillators, so a check can prove a cue actually reached the audio output —
// and that the global mute gate stopped it before any context existed.
const AUDIO_PROBE = `
(() => {
  const probe = (window.__audioProbe = { contexts: 0, oscillators: 0 });
  const Real = window.AudioContext || window.webkitAudioContext;
  if (!Real) return;
  class ProbeContext extends Real {
    constructor(...args) {
      super(...args);
      probe.contexts += 1;
    }
    createOscillator() {
      probe.oscillators += 1;
      return super.createOscillator();
    }
  }
  window.AudioContext = ProbeContext;
  window.webkitAudioContext = ProbeContext;
})();
`;

const readProbe = (page) =>
  page.evaluate(() => ({ ...(window.__audioProbe || { contexts: 0, oscillators: 0 }) }));

let browser;
try {
  browser = await launchBrowser();

  // ── 1. A quiet mount ──────────────────────────────────────────────────
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.mountGame);
  await mount(page, liveState("host"));
  const onMount = await readCues(page);
  check(
    "mounting a live match is silent (no cue until something actually happens)",
    onMount.length === 0,
    `cues=${JSON.stringify(onMount)}`,
  );

  // ── 2. Selecting a column ─────────────────────────────────────────────
  await clearCues(page);
  await page.click('button[title="Drop in column 4"]');
  const afterSelect = await readCues(page);
  check(
    "selecting a column fires exactly one select cue, immediately",
    afterSelect.join(",") === "select",
    `cues=${JSON.stringify(afterSelect)}`,
  );
  check(
    "no landing cue is fired before the disc has travelled",
    (await countCue(page, "land")) === 0,
    "",
  );
  // The harness holds the play-move response open, so the move is still in
  // flight: a second click must not add a cue.
  await page
    .locator('button[title="Drop in column 5"]')
    .dispatchEvent("click", { timeout: 2000 })
    .catch(() => {});
  check(
    "a second click while the move is in flight cannot double the cue",
    (await countCue(page, "select")) === 1,
    `selects=${await countCue(page, "select")}`,
  );
  await page.evaluate(() => window.__releaseMove && window.__releaseMove());

  // ── 3. Landing ────────────────────────────────────────────────────────
  // A disc appearing in the board (the opponent's or our own, delivered by the
  // poll) falls, and the cue belongs at touchdown. Mount with the board already
  // holding nothing, then add one disc so the page sees a real drop.
  await mount(page, liveState("guest"));
  await clearCues(page);
  await pushState(
    page,
    liveState("guest", { board: boardWith([[5, 3, 1]]), hostDiscsUsed: 3 }),
  );
  await page.waitForSelector('[data-testid="fiar-drop-disc"]', { timeout: 9000 });
  await waitForCue(page, "land");
  const landing = await readCues(page);
  check(
    "your own disc landing fires exactly one landing cue",
    landing.filter((c) => c === "land").length === 1 &&
      landing.filter((c) => c === "opponentLand").length === 0,
    `cues=${JSON.stringify(landing)}`,
  );
  // Polls keep delivering the same board — none of them may re-fire it.
  await page.waitForTimeout(6200);
  check(
    "a later poll of the same board never replays the landing cue",
    (await countCue(page, "land")) === 1,
    `lands=${await countCue(page, "land")}`,
  );

  // ── 4. The opponent's disc landing ────────────────────────────────────
  await mount(page, liveState("host"));
  await clearCues(page);
  await pushState(
    page,
    liveState("host", { board: boardWith([[5, 5, 2]]), guestDiscsUsed: 3 }),
  );
  await page.waitForSelector('[data-testid="fiar-drop-disc"]', { timeout: 9000 });
  await waitForCue(page, "opponentLand");
  const oppLanding = await readCues(page);
  check(
    "the opponent's disc lands with its own distinct cue, once",
    oppLanding.filter((c) => c === "opponentLand").length === 1 &&
      oppLanding.filter((c) => c === "land").length === 0,
    `cues=${JSON.stringify(oppLanding)}`,
  );

  // ── 5. The match starting ─────────────────────────────────────────────
  await mount(
    page,
    liveState("host", { status: "waiting", guestClerkId: null }),
  );
  await clearCues(page);
  await pushState(page, liveState("host"));
  const started = await waitForCue(page, "matchStart", 1, 6000);
  check(
    "the match actually starting fires one match-start cue",
    started && (await countCue(page, "matchStart")) === 1,
    `starts=${await countCue(page, "matchStart")}`,
  );

  // ── 6. Result cues: once per settled match, never per poll ────────────
  // (`__fiarCues` lives on `window`, so it survives a remount — clear it so
  // each result segment is measured on its own.)
  await clearCues(page);
  await mount(page, finishedState());
  await waitForCue(page, "win");
  check(
    "a win fires the win cue (and not the loss/draw ones)",
    (await countCue(page, "win")) === 1 &&
      (await countCue(page, "loss")) === 0 &&
      (await countCue(page, "draw")) === 0,
    `cues=${JSON.stringify(await readCues(page))}`,
  );
  // Two more 5s polls of the SAME finished state.
  await page.waitForTimeout(11000);
  check(
    "polling the same finished state repeatedly never replays the result cue",
    (await countCue(page, "win")) === 1,
    `wins=${await countCue(page, "win")}`,
  );

  await clearCues(page);
  await mount(page, finishedState({ winnerClerkId: "guest1", result: "loss" }));
  await waitForCue(page, "loss");
  check(
    "losing to the opponent fires the loss cue once",
    (await countCue(page, "loss")) === 1 && (await countCue(page, "win")) === 0,
    `cues=${JSON.stringify(await readCues(page))}`,
  );

  await clearCues(page);
  await mount(
    page,
    finishedState({
      result: "draw",
      winnerClerkId: null,
      hostDiscsUsed: 21,
      guestDiscsUsed: 21,
      board: boardWith([[5, 0, 1], [5, 1, 2], [5, 2, 1], [5, 3, 2]]),
    }),
  );
  await waitForCue(page, "draw");
  check(
    "a draw fires the neutral draw cue, not a win or loss",
    (await countCue(page, "draw")) === 1 &&
      (await countCue(page, "win")) === 0 &&
      (await countCue(page, "loss")) === 0,
    `cues=${JSON.stringify(await readCues(page))}`,
  );
  await page.close();

  // ── 7. The vs-AI page ─────────────────────────────────────────────────
  const aiPage = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  aiPage.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await aiPage.goto(aiBase, { waitUntil: "networkidle" });
  await aiPage.waitForFunction(() => window.mountPage);
  await aiPage.evaluate(() => window.mountPage());
  await aiPage.waitForSelector('button[title="Drop in column 4"]');
  check(
    "vs-AI: entering the board is silent until you play",
    (await readCues(aiPage)).length === 0,
    `cues=${JSON.stringify(await readCues(aiPage))}`,
  );

  await aiPage.click('button[title="Drop in column 4"]');
  check(
    "vs-AI: your drop fires one select cue, immediately",
    (await countCue(aiPage, "select")) === 1,
    `cues=${JSON.stringify(await readCues(aiPage))}`,
  );
  await waitForCue(aiPage, "land");
  check(
    "vs-AI: your disc landing fires one landing cue",
    (await countCue(aiPage, "land")) === 1,
    `lands=${await countCue(aiPage, "land")}`,
  );
  // The AI replies on its own.
  const aiLanded = await waitForCue(aiPage, "opponentLand", 1, 8000);
  check(
    "vs-AI: the AI's own drop lands with the distinct opponent cue",
    aiLanded && (await countCue(aiPage, "opponentLand")) === 1,
    `cues=${JSON.stringify(await readCues(aiPage))}`,
  );

  // A second exchange must not accumulate duplicates.
  await aiPage.waitForSelector('button[title="Drop in column 3"]:not([disabled])');
  await aiPage.click('button[title="Drop in column 3"]');
  await waitForCue(aiPage, "opponentLand", 2, 9000);
  const afterTwo = await readCues(aiPage);
  check(
    "vs-AI: a second exchange gives exactly one cue per event (no accumulation)",
    afterTwo.filter((c) => c === "select").length === 2 &&
      afterTwo.filter((c) => c === "land").length === 2 &&
      afterTwo.filter((c) => c === "opponentLand").length === 2,
    `cues=${JSON.stringify(afterTwo)}`,
  );

  await clearCues(aiPage);
  await aiPage.click('button:has-text("New Game")');
  await aiPage.waitForTimeout(400);
  check(
    "vs-AI: New Game fires one match-start cue",
    (await countCue(aiPage, "matchStart")) === 1,
    `cues=${JSON.stringify(await readCues(aiPage))}`,
  );
  await aiPage.close();

  // ── 8. Reduced motion still lands ─────────────────────────────────────
  const rmPage = await browser.newPage({
    viewport: { width: 900, height: 1000 },
    reducedMotion: "reduce",
  });
  rmPage.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await rmPage.goto(aiBase, { waitUntil: "networkidle" });
  await rmPage.waitForFunction(() => window.mountPage);
  await rmPage.evaluate(() => window.mountPage());
  await rmPage.waitForSelector('button[title="Drop in column 4"]');
  await rmPage.click('button[title="Drop in column 4"]');
  const rmLanded = await waitForCue(rmPage, "land", 1, 4000);
  check(
    "reduced motion: the drop still fires exactly one select and one landing cue",
    rmLanded &&
      (await countCue(rmPage, "select")) === 1 &&
      (await countCue(rmPage, "land")) === 1,
    `cues=${JSON.stringify(await readCues(rmPage))}`,
  );
  await rmPage.close();

  // ── 9. The global mute gate ───────────────────────────────────────────
  // Unmuted: the cue reaches a real AudioContext.
  const loudCtx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  await loudCtx.addInitScript(AUDIO_PROBE);
  const loud = await loudCtx.newPage();
  await loud.goto(aiBase, { waitUntil: "networkidle" });
  await loud.waitForFunction(() => window.mountPage);
  await loud.evaluate(() => window.mountPage());
  await loud.waitForSelector('button[title="Drop in column 4"]');
  await loud.click('button[title="Drop in column 4"]');
  await waitForCue(loud, "land", 1, 5000);
  const loudProbe = await readProbe(loud);
  check(
    "unmuted: a sound cue actually reaches the AudioContext",
    loudProbe.contexts >= 1 && loudProbe.oscillators > 0,
    JSON.stringify(loudProbe),
  );
  await loudCtx.close();

  // Muted: the app's existing global mute gate silences it before any context
  // is even created — no separate audio system, no per-game mute handling.
  const muteCtx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  await muteCtx.addInitScript(AUDIO_PROBE);
  await muteCtx.addInitScript(() => {
    try {
      window.localStorage.setItem("grynd_audio_muted", "1");
    } catch {}
  });
  const muted = await muteCtx.newPage();
  await muted.goto(aiBase, { waitUntil: "networkidle" });
  await muted.waitForFunction(() => window.mountPage);
  await muted.evaluate(() => window.mountPage());
  await muted.waitForSelector('button[title="Drop in column 4"]');
  await muted.click('button[title="Drop in column 4"]');
  await waitForCue(muted, "land", 1, 5000);
  await muted.waitForTimeout(600);
  const mutedProbe = await readProbe(muted);
  check(
    "the global mute setting is respected: no AudioContext is ever created",
    mutedProbe.contexts === 0 && mutedProbe.oscillators === 0,
    JSON.stringify(mutedProbe),
  );
  check(
    "the muted page still played the game (the cues were simply silenced)",
    (await countCue(muted, "select")) === 1 && (await countCue(muted, "land")) === 1,
    `cues=${JSON.stringify(await readCues(muted))}`,
  );
  await muteCtx.close();

  await browser.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  closeHarness();
  closeAiHarness();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
