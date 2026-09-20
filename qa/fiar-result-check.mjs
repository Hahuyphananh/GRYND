// qa/fiar-result-check.mjs
//
// Browser check for Four-In-A-Row's final result presentation. Mounts the REAL
// multiplayer page (qa/fiar-winline-harness.jsx, bundled with the shared stubs
// in qa/fiar-multiplayer-page.mjs) against a mocked game-state API. The shared
// panel is stubbed to render the props the page PASSES, so this verifies the
// page's result wiring — not the panel's own styling, which is shared with
// every other game:
//
//   1. WIN  → outcome "win", the winning four drawn in YOUR real disc colour.
//   2. LOSS → outcome "loss", the same four drawn in the WINNER's colour (the
//             opponent's), never a celebrating treatment.
//   3. DRAW → outcome "draw" and NO strip at all, even on a board that happens
//             to contain a line, because the page only builds one from the
//             server's winner — a draw stays neutral.
//   4. The board is kept mounted behind the panel, so the winning four are
//             still there for the player to read.
//   5. Exactly ONE result panel, and polling the same finished state never
//             duplicates it or re-fires the strip.
//   6. reduced motion and mobile keep the strip readable (it is static).
//
// Run: node qa/fiar-result-check.mjs

import { chromium } from "playwright";
import { mountHarness } from "./fiar-multiplayer-page.mjs";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const { base, close: closeHarness } = await mountHarness({
  title: "Four-In-A-Row result check",
});

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ channel: "chrome" });
  }
}

const BLUE = "four-in-a-row-disc-blue";
const PURPLE = "four-in-a-row-disc-purple";

const emptyBoard = () => Array.from({ length: 6 }, () => Array(7).fill(0));
const boardWith = (cells) => {
  const board = emptyBoard();
  for (const [row, col, value] of cells) board[row][col] = value;
  return board;
};

// A finished match. `winner` is the seat that connected four (null = a draw).
const finishedState = ({ winner = "host", result = "win", overrides = {} } = {}) => ({
  status: "finished",
  result,
  role: "host",
  hostClerkId: "host1",
  guestClerkId: "guest1",
  winnerClerkId: winner === "host" ? "host1" : winner === "guest" ? "guest1" : null,
  hostName: "You",
  guestName: "Opponent",
  hostDiscsUsed: 4,
  guestDiscsUsed: 3,
  betAmount: 0,
  isAiGame: true,
  board: boardWith([
    [5, 0, winner === "guest" ? 2 : 1],
    [5, 1, winner === "guest" ? 2 : 1],
    [5, 2, winner === "guest" ? 2 : 1],
    [5, 3, winner === "guest" ? 2 : 1],
  ]),
  moveTimeLimit: 60,
  moveTimeRemaining: 0,
  replayTimeRemaining: 20,
  ...overrides,
});

// Wait for the reveal hold to clear and the panel to land.
async function mountResult(page, state) {
  await page.evaluate((s) => window.mountGame(s), state);
  await page.waitForSelector('[data-testid="fiar-result-overlay"]', {
    state: "attached",
    timeout: 6000,
  });
  await page.waitForTimeout(120);
}

async function readResult(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="fiar-result-overlay"]');
    const extra = document.querySelector('[data-testid="fiar-result-extra"]');
    const discs = extra ? [...extra.querySelectorAll(".four-in-a-row-disc")] : [];
    const strip = document.querySelector('[data-testid="fiar-result-win-line"]');
    return {
      panels: document.querySelectorAll('[data-testid="fiar-result-overlay"]').length,
      outcome: overlay ? overlay.dataset.outcome ?? null : null,
      opponent:
        document.querySelector('[data-testid="fiar-result-opponent"]')?.textContent ?? null,
      strips: document.querySelectorAll('[data-testid="fiar-result-win-line"]').length,
      discs: discs.length,
      colors: [
        ...new Set(
          discs
            .map((d) =>
              [...d.classList].find(
                (c) => c === "four-in-a-row-disc-blue" || c === "four-in-a-row-disc-purple",
              ),
            )
            .filter(Boolean),
        ),
      ],
      stripAnimated: strip
        ? strip.getAnimations().filter((a) => a.playState === "running").length
        : 0,
      boards: document.querySelectorAll(".four-in-a-row-board").length,
    };
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

  // ── 1. WIN ────────────────────────────────────────────────────────────
  await mountResult(page, finishedState({ winner: "host" }));
  const win = await readResult(page);
  check(
    "win: the panel is told the outcome and the opponent's real name",
    win.outcome === "win" && win.opponent === "Opponent",
    JSON.stringify({ outcome: win.outcome, opponent: win.opponent }),
  );
  check(
    "win: the winning four are drawn as exactly 4 discs in YOUR colour",
    win.strips === 1 && win.discs === 4 && win.colors.join(",") === BLUE,
    `strips=${win.strips} discs=${win.discs} colors=${win.colors}`,
  );
  check(
    "win: the board is kept mounted behind the panel (the four stay readable)",
    win.boards === 1 && win.panels === 1,
    `boards=${win.boards} panels=${win.panels}`,
  );

  // ── 5a. Polling the same finished state changes nothing ───────────────
  // A finished match polls every 5s.
  await page.waitForTimeout(6000);
  const steady = await readResult(page);
  check(
    "polling the same finished state never duplicates or re-fires the panel",
    steady.panels === 1 && steady.strips === 1 && steady.discs === 4,
    JSON.stringify({ panels: steady.panels, strips: steady.strips, discs: steady.discs }),
  );

  // ── 2. LOSS ───────────────────────────────────────────────────────────
  await mountResult(page, finishedState({ winner: "guest" }));
  const loss = await readResult(page);
  check(
    "loss: the panel is told it is a loss",
    loss.outcome === "loss",
    `outcome=${loss.outcome}`,
  );
  check(
    "loss: the four are drawn in the WINNER's colour, not a celebrating one",
    loss.strips === 1 && loss.discs === 4 && loss.colors.join(",") === PURPLE,
    `strips=${loss.strips} discs=${loss.discs} colors=${loss.colors}`,
  );

  // ── 3. DRAW — neutral, no strip even on a board that holds a line ─────
  await mountResult(
    page,
    finishedState({
      winner: null,
      result: "draw",
      // Deliberately a board that DOES contain four in a row for the host: the
      // page must still refuse to build a strip, because the server settled it
      // as a draw (no winner). This is the negative control for the draw path.
      overrides: { winnerClerkId: null },
    }),
  );
  const draw = await readResult(page);
  check(
    "draw: the panel is told it is a draw",
    draw.outcome === "draw",
    `outcome=${draw.outcome}`,
  );
  check(
    "draw: no winning strip is shown at all — the treatment stays neutral",
    draw.strips === 0 && draw.discs === 0,
    `strips=${draw.strips} discs=${draw.discs}`,
  );

  // ── 6a. Mobile board size ─────────────────────────────────────────────
  await page.setViewportSize({ width: 380, height: 720 });
  await mountResult(page, finishedState({ winner: "host" }));
  const mobile = await readResult(page);
  check(
    "mobile: the winning four are still drawn as 4 discs at a small viewport",
    mobile.strips === 1 && mobile.discs === 4 && mobile.colors.join(",") === BLUE,
    `strips=${mobile.strips} discs=${mobile.discs}`,
  );
  await page.close();

  // ── 6b. Reduced motion ────────────────────────────────────────────────
  const rmPage = await browser.newPage({
    viewport: { width: 900, height: 1000 },
    reducedMotion: "reduce",
  });
  await rmPage.goto(base, { waitUntil: "networkidle" });
  await rmPage.waitForFunction(() => window.mountGame);
  await mountResult(rmPage, finishedState({ winner: "host" }));
  const rm = await readResult(rmPage);
  check(
    "reduced motion: the winning four are still there, and static",
    rm.strips === 1 && rm.discs === 4 && rm.stripAnimated === 0,
    `strips=${rm.strips} discs=${rm.discs} running=${rm.stripAnimated}`,
  );
  await rmPage.close();

  await browser.close();
} finally {
  closeHarness();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
