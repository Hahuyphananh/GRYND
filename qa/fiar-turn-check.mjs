// qa/fiar-turn-check.mjs
//
// Browser check for Four-In-A-Row's turn / state hierarchy. Mounts the REAL
// multiplayer page (qa/fiar-winline-harness.jsx, bundled with the shared stubs
// in qa/fiar-multiplayer-page.mjs) against a mocked game-state API and asserts,
// on the live DOM:
//
//   1. YOUR TURN is the strongest cue: the turn line reads "Your move" in the
//      loud colour, your own player card carries the active ring, the waiting
//      player's card is visibly secondary, and the columns are interactive.
//   2. OPPONENT TURN is visibly secondary: the line is muted, their card is the
//      active one, and the columns are not interactive.
//   3. A MOVE IN FLIGHT locks the board clearly but briefly: the columns read
//      locked while the request is open, then unlock on their own.
//   4. A real TURN SWITCH shows exactly one brief pill, which clears itself —
//      including across a rapid switch back.
//   5. A FINISHED game drops the turn cue entirely (the winning/result state
//      leads) and marks neither player active.
//   6. Everything still resolves at a small (mobile) board size.
//
// Run: node qa/fiar-turn-check.mjs

import { chromium } from "playwright";
import { mountHarness } from "./fiar-multiplayer-page.mjs";
import { mountAiHarness } from "./fiar-ai-page.mjs";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const { base, close: closeHarness } = await mountHarness({
  title: "Four-In-A-Row turn/state check",
});
const { base: aiBase, close: closeAiHarness } = await mountAiHarness({
  title: "Four-In-A-Row vs-AI turn check",
});

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ channel: "chrome" });
  }
}

const emptyBoard = () => Array.from({ length: 6 }, () => Array(7).fill(0));

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
  const board = emptyBoard();
  for (const [row, col] of [[5, 0], [5, 1], [5, 2], [5, 3]]) board[row][col] = 1;
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

async function readTurn(page) {
  return page.evaluate(() => {
    const line = document.querySelector('[data-testid="fiar-turn-line"]');
    const host = document.querySelector('[data-testid="fiar-player-host"]');
    const guest = document.querySelector('[data-testid="fiar-player-guest"]');
    const controls = document.querySelector(".four-in-a-row-drop-controls");
    const firstButton = controls ? controls.querySelector("button") : null;
    const cs = (el) => (el ? getComputedStyle(el) : null);
    return {
      label: line ? line.textContent.trim() : null,
      state: line ? line.dataset.turnState : null,
      lineColor: line ? cs(line).color : null,
      hostActive: host ? host.classList.contains("four-in-a-row-player--active") : null,
      hostIdle: host ? host.classList.contains("four-in-a-row-player--idle") : null,
      hostOpacity: host ? Number(cs(host).opacity) : null,
      hostShadow: host ? cs(host).boxShadow : null,
      guestActive: guest ? guest.classList.contains("four-in-a-row-player--active") : null,
      guestIdle: guest ? guest.classList.contains("four-in-a-row-player--idle") : null,
      guestOpacity: guest ? Number(cs(guest).opacity) : null,
      controlsLocked: controls
        ? controls.classList.contains("four-in-a-row-drop-controls--locked")
        : null,
      controlsOpacity: controls ? Number(cs(controls).opacity) : null,
      controlsPointerEvents: controls ? cs(controls).pointerEvents : null,
      firstButtonDisabled: firstButton ? firstButton.disabled : null,
    };
  });
}

// Mount the real page on `state` and let the 0.2s opacity/box-shadow
// transitions settle before measuring (the board always renders, with or
// without a turn line).
// The opponent/AI activity cue: whether ONE is present, which card owns it,
// its colour, and whether its one-shot animation is genuinely running once.
async function readCue(page, cardTestId) {
  return page.evaluate((testId) => {
    const cue = document.querySelector('[data-testid="fiar-opponent-cue"]');
    const card = document.querySelector(`[data-testid="${testId}"]`);
    const anims = cue ? cue.getAnimations() : [];
    const timing = anims[0] ? anims[0].effect.getTiming() : null;
    return {
      cues: document.querySelectorAll('[data-testid="fiar-opponent-cue"]').length,
      inCard: cue && card ? card.contains(cue) : null,
      color: cue ? getComputedStyle(cue).getPropertyValue("--cue-color").trim() : null,
      duration: timing ? timing.duration : null,
      iterations: timing ? timing.iterations : null,
      playState: anims[0] ? anims[0].playState : null,
    };
  }, cardTestId);
}

// A board with discs placed on it (row, col, value).
const boardWith = (cells) => {
  const board = emptyBoard();
  for (const [row, col, value] of cells) board[row][col] = value;
  return board;
};

// The vs-AI page has its own turn cue: you / AI thinking / your drop in
// flight. Read the same shape from the AI page's nodes.
async function readAiTurn(page) {
  return page.evaluate(() => {
    const line = document.querySelector('[data-testid="fiar-turn-line"]');
    const you = document.querySelector('[data-testid="fiar-player-you"]');
    const ai = document.querySelector('[data-testid="fiar-player-ai"]');
    const controls = document.querySelector(".four-in-a-row-drop-controls");
    const firstButton = controls ? controls.querySelector("button") : null;
    const cs = (el) => (el ? getComputedStyle(el) : null);
    return {
      label: line ? line.textContent.trim() : null,
      state: line ? line.dataset.turnState : null,
      youActive: you ? you.dataset.active === "1" : null,
      youIdle: you ? you.classList.contains("four-in-a-row-player--idle") : null,
      aiActive: ai ? ai.dataset.active === "1" : null,
      aiIdle: ai ? ai.classList.contains("four-in-a-row-player--idle") : null,
      youOpacity: you ? Number(cs(you).opacity) : null,
      controlsLocked: controls
        ? controls.classList.contains("four-in-a-row-drop-controls--locked")
        : null,
      firstButtonDisabled: firstButton ? firstButton.disabled : null,
    };
  });
}

async function mount(page, state) {
  await page.evaluate((s) => window.mountGame(s), state);
  await page.waitForSelector(".four-in-a-row-board");
  await page.waitForTimeout(340);
}

// The active card's ring, mirrored from .four-in-a-row-player--active in
// globals.css (cyan HUD ring, no white/gold glow).
const ACTIVE_RING = "rgba(0, 229, 255, 0.5)";
const MUTED = "rgba(255, 255, 255, 0.45)";

try {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.mountGame);

  // ── 1. Your turn — the strongest cue ──────────────────────────────────
  await mount(page, liveState("host"));
  const mine = await readTurn(page);
  check(
    "your turn: the turn line says Your move, loudly",
    mine.label === "Your move" && mine.state === "mine" && mine.lineColor === "rgb(245, 255, 59)",
    `label=${JSON.stringify(mine.label)} state=${mine.state} color=${mine.lineColor}`,
  );
  check(
    "your turn: YOUR card carries the active ring and the opponent steps back",
    mine.hostActive === true &&
      mine.guestActive === false &&
      mine.guestIdle === true &&
      mine.hostOpacity === 1 &&
      mine.guestOpacity !== null &&
      mine.guestOpacity < 1 &&
      mine.hostShadow.includes(ACTIVE_RING),
    `hostActive=${mine.hostActive} hostOpacity=${mine.hostOpacity} guestIdle=${mine.guestIdle} guestOpacity=${mine.guestOpacity}`,
  );
  check(
    "your turn: the columns are interactive and unlocked",
    mine.controlsLocked === false && mine.firstButtonDisabled === false,
    `locked=${mine.controlsLocked} disabled=${mine.firstButtonDisabled}`,
  );
  check(
    "your turn: no turn pill is shown on first paint",
    (await page.locator('[data-testid="fiar-turn-pill"]').count()) === 0,
    "",
  );
  const quiet = await readCue(page, "fiar-player-guest");
  check(
    "your turn: the opponent cue stays quiet while it is your move",
    quiet.cues === 0,
    `cues=${quiet.cues}`,
  );

  // ── 2. Opponent's turn — visibly secondary ────────────────────────────
  await mount(page, liveState("guest"));
  const theirs = await readTurn(page);
  check(
    "opponent turn: the line is muted and names who we are waiting for",
    theirs.label === "Waiting for Opponent" &&
      theirs.state === "theirs" &&
      theirs.lineColor === MUTED,
    `label=${JSON.stringify(theirs.label)} state=${theirs.state} color=${theirs.lineColor}`,
  );
  check(
    "opponent turn: THEIR card is active now and yours steps back",
    theirs.guestActive === true &&
      theirs.hostIdle === true &&
      theirs.hostActive === false &&
      theirs.guestOpacity === 1 &&
      theirs.hostOpacity < 1,
    `guestActive=${theirs.guestActive} hostIdle=${theirs.hostIdle} hostOpacity=${theirs.hostOpacity}`,
  );
  check(
    "opponent turn: the columns are not interactive (but not locked either)",
    theirs.firstButtonDisabled === true && theirs.controlsLocked === false,
    `disabled=${theirs.firstButtonDisabled} locked=${theirs.controlsLocked}`,
  );

  // ── 2b. Opponent activity cue (it is their turn) ──────────────────────
  const oppCue = await readCue(page, "fiar-player-guest");
  check(
    "opponent turn: exactly one cue marks the OPPONENT's card, in their own colour",
    oppCue.cues === 1 && oppCue.inCard === true && oppCue.color === "rgba(248, 113, 113, .7)",
    JSON.stringify(oppCue),
  );
  check(
    "opponent turn: the cue is a single finite run, never a loop",
    oppCue.duration === 500 &&
      oppCue.iterations === 1 &&
      oppCue.playState === "running",
    `duration=${oppCue.duration} iterations=${oppCue.iterations} state=${oppCue.playState}`,
  );
  const mineCue = await readCue(page, "fiar-player-host");
  check(
    "opponent turn: your own card carries no cue",
    mineCue.inCard === false,
    `inMyCard=${mineCue.inCard}`,
  );

  // ── 2c. The opponent's piece begins falling ──────────────────────────
  await page.evaluate((s) => {
    window.__fiarGameState = s;
  }, {
    ...liveState("guest"),
    board: boardWith([[5, 3, 2]]),
    guestDiscsUsed: 3,
  });
  await page.waitForSelector('[data-testid="fiar-drop-disc"]', { timeout: 9000 });
  const dropCue = await readCue(page, "fiar-player-guest");
  check(
    "the opponent's disc falling re-fires the cue on their card (one run)",
    dropCue.cues === 1 &&
      dropCue.inCard === true &&
      dropCue.playState === "running" &&
      dropCue.duration === 500,
    JSON.stringify(dropCue),
  );

  // ── 3. A move in flight — clear, brief lock ───────────────────────────
  await mount(page, liveState("host"));
  await page.click('button[title="Drop in column 4"]');
  await page.waitForFunction(
    () => document.querySelector(".four-in-a-row-drop-controls--locked") !== null,
  );
  await page.waitForTimeout(340); // let the lock's opacity transition settle
  const locked = await readTurn(page);
  check(
    "move in flight: the board reads locked while the move is being sent",
    locked.state === "locked" &&
      locked.label === "Sending your move…" &&
      locked.controlsLocked === true &&
      locked.controlsOpacity !== null &&
      locked.controlsOpacity < 1 &&
      locked.controlsPointerEvents === "none",
    `state=${locked.state} label=${JSON.stringify(locked.label)} opacity=${locked.controlsOpacity} pe=${locked.controlsPointerEvents}`,
  );
  await page.evaluate(() => window.__releaseMove && window.__releaseMove());
  await page.waitForFunction(
    () => document.querySelector(".four-in-a-row-drop-controls--locked") === null,
  );
  const unlocked = await readTurn(page);
  check(
    "move in flight: the lock clears itself once the move is accepted",
    unlocked.controlsLocked === false && unlocked.controlsPointerEvents !== "none",
    `locked=${unlocked.controlsLocked} pe=${unlocked.controlsPointerEvents}`,
  );

  // ── 4. A real turn switch — exactly one brief pill, and it clears ─────
  await mount(page, liveState("host"));
  await page.evaluate((s) => {
    window.__fiarGameState = s;
  }, liveState("guest"));
  await page.waitForFunction(
    () => document.querySelector('[data-testid="fiar-turn-pill"]') !== null,
    null,
    { timeout: 9000 },
  );
  const banner = await page.evaluate(() => ({
    pills: document.querySelectorAll('[data-testid="fiar-turn-pill"]').length,
    text: document.querySelector('[data-testid="fiar-turn-pill"]').textContent.trim(),
    line: document.querySelector('[data-testid="fiar-turn-line"]').dataset.turnState,
  }));
  check(
    "a turn switch shows exactly one brief pill naming the new turn",
    banner.pills === 1 && banner.text === "Opponent's Turn" && banner.line === "theirs",
    JSON.stringify(banner),
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="fiar-turn-pill"]') === null,
    null,
    { timeout: 4000 },
  );
  check("the turn pill clears itself (no permanent banner)", true, "");

  // Rapid switch back: the previous timer is cancelled, so one pill at most.
  await page.evaluate((s) => {
    window.__fiarGameState = s;
  }, liveState("host"));
  await page.waitForFunction(
    () => document.querySelector('[data-testid="fiar-turn-line"]')?.dataset.turnState === "mine",
    null,
    { timeout: 9000 },
  );
  const rapid = await page.evaluate(() => ({
    pills: document.querySelectorAll('[data-testid="fiar-turn-pill"]').length,
    mine: document.querySelector('[data-testid="fiar-player-host"]').classList.contains("four-in-a-row-player--active"),
    theirs: document.querySelector('[data-testid="fiar-player-guest"]').classList.contains("four-in-a-row-player--active"),
  }));
  check(
    "a rapid switch back leaves at most one pill and one active player",
    rapid.pills <= 1 && rapid.mine === true && rapid.theirs === false,
    JSON.stringify(rapid),
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="fiar-turn-pill"]') === null,
    null,
    { timeout: 4000 },
  );

  // ── 5. Finished — the turn cue yields to the result/winning state ─────
  await mount(page, finishedState());
  const over = await readTurn(page);
  check(
    "game finished: the turn cue is dropped entirely",
    over.label === null && over.state === null,
    `label=${JSON.stringify(over.label)} state=${over.state}`,
  );
  check(
    "game finished: neither player is marked active, no board lock",
    over.hostActive === false &&
      over.guestActive === false &&
      over.controlsLocked === false,
    `hostActive=${over.hostActive} guestActive=${over.guestActive} locked=${over.controlsLocked}`,
  );

  // ── 6. Mobile board size ──────────────────────────────────────────────
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--board-width", "320px");
  });
  await mount(page, liveState("host"));
  const mobile = await readTurn(page);
  const mobileCell = await page.evaluate(() => {
    const cell = document.querySelector('[data-cell="0-0"]');
    return cell ? cell.offsetHeight : 0;
  });
  check(
    "mobile board: the turn hierarchy resolves exactly the same",
    mobile.label === "Your move" &&
      mobile.hostActive === true &&
      mobile.guestOpacity < 1 &&
      mobileCell > 0 &&
      mobileCell < 70,
    `label=${JSON.stringify(mobile.label)} hostActive=${mobile.hostActive} cell=${mobileCell}px`,
  );

  await page.close();

  // ── Reduced motion: the hierarchy still resolves ──────────────────────
  const rmPage = await browser.newPage({
    viewport: { width: 900, height: 1000 },
    reducedMotion: "reduce",
  });
  await rmPage.goto(base, { waitUntil: "networkidle" });
  await rmPage.waitForFunction(() => window.mountGame);
  await mount(rmPage, liveState("guest"));
  const rm = await readTurn(rmPage);
  check(
    "reduced motion: the turn hierarchy still resolves the same",
    rm.state === "theirs" && rm.guestActive === true && rm.hostOpacity < 1,
    `state=${rm.state} guestActive=${rm.guestActive} hostOpacity=${rm.hostOpacity}`,
  );
  const rmCue = await readCue(rmPage, "fiar-player-guest");
  check(
    "reduced motion: no opponent cue is rendered at all",
    rmCue.cues === 0,
    `cues=${rmCue.cues}`,
  );
  await rmPage.close();

  // ── 7. The vs-AI page's own turn cycle ────────────────────────────────
  const aiPage = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  aiPage.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await aiPage.goto(aiBase, { waitUntil: "networkidle" });
  await aiPage.waitForFunction(() => window.mountPage);
  await aiPage.evaluate(() => window.mountPage());
  await aiPage.waitForSelector('button[title="Drop in column 4"]');
  await aiPage.waitForTimeout(340);

  const aiIdle = await readAiTurn(aiPage);
  check(
    "vs-AI: on your turn the line reads Your move and your card is the active one",
    aiIdle.label === "Your move" &&
      aiIdle.state === "mine" &&
      aiIdle.youActive === true &&
      aiIdle.aiActive === false &&
      aiIdle.aiIdle === true,
    `label=${JSON.stringify(aiIdle.label)} state=${aiIdle.state} youActive=${aiIdle.youActive} aiIdle=${aiIdle.aiIdle}`,
  );
  check(
    "vs-AI: your columns are interactive before you drop",
    aiIdle.controlsLocked === false && aiIdle.firstButtonDisabled === false,
    `locked=${aiIdle.controlsLocked} disabled=${aiIdle.firstButtonDisabled}`,
  );

  await aiPage.click('button[title="Drop in column 4"]');
  await aiPage.waitForFunction(
    () => document.querySelector('[data-testid="fiar-turn-line"]')?.dataset.turnState === "locked",
    null,
    { timeout: 2000 },
  );
  const aiLocked = await readAiTurn(aiPage);
  // During your OWN drop the columns are locked by the overlay, not by
  // `disabled` (the AI page's canPlay only follows status + aiThinking).
  check(
    "vs-AI: your drop briefly locks the board",
    aiLocked.label === "Dropping…" && aiLocked.controlsLocked === true,
    `label=${JSON.stringify(aiLocked.label)} locked=${aiLocked.controlsLocked}`,
  );

  await aiPage.waitForFunction(
    () => document.querySelector('[data-testid="fiar-turn-line"]')?.dataset.turnState === "thinking",
    null,
    { timeout: 4000 },
  );
  await aiPage.waitForTimeout(340);
  const aiThinking = await readAiTurn(aiPage);
  check(
    "vs-AI: the AI's turn hands the emphasis to the AI's card",
    aiThinking.label === "AI is thinking…" &&
      aiThinking.aiActive === true &&
      aiThinking.youActive === false &&
      aiThinking.youIdle === true &&
      aiThinking.firstButtonDisabled === true,
    `label=${JSON.stringify(aiThinking.label)} aiActive=${aiThinking.aiActive} youIdle=${aiThinking.youIdle}`,
  );
  const aiCue = await readCue(aiPage, "fiar-player-ai");
  check(
    "vs-AI: one one-shot cue marks the AI's chip, in the AI's own colour",
    aiCue.cues === 1 &&
      aiCue.inCard === true &&
      aiCue.color === "rgba(192, 132, 252, .7)" &&
      aiCue.duration === 500 &&
      aiCue.iterations === 1,
    JSON.stringify(aiCue),
  );
  const youCue = await readCue(aiPage, "fiar-player-you");
  check(
    "vs-AI: your own chip never carries the AI's cue",
    youCue.inCard === false,
    `inMyChip=${youCue.inCard}`,
  );

  await aiPage.waitForFunction(
    () => document.querySelector('[data-testid="fiar-turn-line"]')?.dataset.turnState === "mine",
    null,
    { timeout: 6000 },
  );
  await aiPage.waitForTimeout(340);
  const aiBack = await readAiTurn(aiPage);
  check(
    "vs-AI: the turn comes back to you after the AI replies",
    aiBack.label === "Your move" &&
      aiBack.youActive === true &&
      aiBack.aiIdle === true &&
      aiBack.controlsLocked === false &&
      aiBack.firstButtonDisabled === false,
    `label=${JSON.stringify(aiBack.label)} youActive=${aiBack.youActive} locked=${aiBack.controlsLocked}`,
  );
  await aiPage.close();

  await browser.close();
} finally {
  closeHarness();
  closeAiHarness();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
