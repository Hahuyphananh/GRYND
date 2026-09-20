// qa/fiar-winline-check.mjs
//
// Browser check for Four-In-A-Row's winning-line emphasis. Mounts the REAL
// multiplayer page (qa/fiar-winline-harness.jsx, bundled with the shared
// stubs in qa/fiar-multiplayer-page.mjs) against a mocked game-state API and
// asserts, frame-accurately:
//
//   1. A finished win marks EXACTLY the four connected discs (horizontal,
//      vertical and diagonal), in the winner's colour.
//   2. Every other disc steps back (dimmed) — 38 of them.
//   3. The winning discs carry the highlight ring.
//   4. The result overlay is held back during the reveal (so the connection is
//      readable), then takes over on its own.
//   5. `prefers-reduced-motion` keeps the highlight but drops the pop.
//   6. The whole thing holds at a small (mobile) board size.
//
// Run: node qa/fiar-winline-check.mjs

import { chromium } from "playwright";
import { mountHarness } from "./fiar-multiplayer-page.mjs";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const { base, close: closeHarness } = await mountHarness({
  title: "Four-In-A-Row win-line check",
});

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ channel: "chrome" });
  }
}

// A finished, won game whose winning four sit on `cells` (host = disc 1).
const stateFor = (cells) => {
  const board = Array.from({ length: 6 }, () => Array(7).fill(0));
  for (const [row, col] of cells) board[row][col] = 1;
  return {
    status: "finished",
    result: "win",
    role: "host",
    hostClerkId: "host1",
    guestClerkId: "guest1",
    winnerClerkId: "host1",
    hostName: "You",
    guestName: "Opponent",
    hostDiscsUsed: 4,
    guestDiscsUsed: 3,
    betAmount: 0,
    isAiGame: true,
    board,
    moveTimeLimit: 60,
    moveTimeRemaining: 0,
    replayTimeRemaining: 20,
  };
};

const boardKey = (cells) =>
  cells.map(([row, col]) => `${row}-${col}`).sort().join(",");

async function readWin(page) {
  return page.evaluate(() => {
    const wins = [...document.querySelectorAll(".four-in-a-row-win")];
    const first = wins[0];
    return {
      wins: wins.length,
      dims: document.querySelectorAll(".four-in-a-row-dim").length,
      cells: wins.map((el) => el.dataset.cell).sort(),
      blue: wins.every((el) => el.className.includes("disc-blue")),
      outline: first ? getComputedStyle(first).outlineWidth : null,
      outlineStyle: first ? getComputedStyle(first).outlineStyle : null,
      transform: first ? getComputedStyle(first).transform : null,
      dimOpacity: document.querySelector(".four-in-a-row-dim")
        ? Number(getComputedStyle(document.querySelector(".four-in-a-row-dim")).opacity)
        : null,
      overlay: document.querySelectorAll('[data-testid="fiar-result-overlay"]').length,
    };
  });
}

const SCENARIOS = [
  ["horizontal", [[5, 0], [5, 1], [5, 2], [5, 3]]],
  ["vertical", [[2, 4], [3, 4], [4, 4], [5, 4]]],
  ["diagonal", [[5, 0], [4, 1], [3, 2], [2, 3]]],
];

try {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.mountGame);

  for (const [label, cells] of SCENARIOS) {
    await page.evaluate((state) => window.mountGame(state), stateFor(cells));
    await page.waitForSelector(".four-in-a-row-win");
    const read = await readWin(page);

    check(
      `${label} four: exactly the winning discs are emphasised`,
      read.wins === 4 && read.cells.join(",") === boardKey(cells),
      `wins=${read.wins} cells=${read.cells.join(",")}`,
    );
    check(
      `${label} four: the rest of the board steps back`,
      read.dims === 38 && read.dimOpacity !== null && read.dimOpacity < 1,
      `dims=${read.dims} dimOpacity=${read.dimOpacity}`,
    );
    check(
      `${label} four: winning discs are the winner's colour with the highlight ring`,
      read.blue === true && read.outline === "3px" && read.outlineStyle === "solid",
      `blue=${read.blue} outline=${read.outline} ${read.outlineStyle}`,
    );
    check(
      `${label} four: the result overlay is held back during the reveal`,
      read.overlay === 0,
      `overlay=${read.overlay}`,
    );
    await page.waitForSelector('[data-testid="fiar-result-overlay"]', {
      state: "attached",
      timeout: 4000,
    });
    check(`${label} four: the result overlay then takes over`, true, "");
  }

  // ── Reduced motion: highlight kept, pop dropped ────────────────────────
  const rmPage = await browser.newPage({
    viewport: { width: 900, height: 1000 },
    reducedMotion: "reduce",
  });
  await rmPage.goto(base, { waitUntil: "networkidle" });
  await rmPage.waitForFunction(() => window.mountGame);
  await rmPage.evaluate((state) => window.mountGame(state), stateFor(SCENARIOS[0][1]));
  await rmPage.waitForSelector(".four-in-a-row-win");
  const rm = await readWin(rmPage);
  check(
    "reduced motion: the winning four are still highlighted, with no pop transform",
    rm.wins === 4 && rm.outline === "3px" && rm.transform === "none",
    `wins=${rm.wins} outline=${rm.outline} transform=${rm.transform}`,
  );
  await rmPage.waitForSelector('[data-testid="fiar-result-overlay"]', {
    state: "attached",
    timeout: 4000,
  });
  check("reduced motion: the result overlay still takes over", true, "");
  await rmPage.close();

  // ── Mobile board size ─────────────────────────────────────────────────
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--board-width", "320px");
    window.mountGame(window.__fiarGameState);
  });
  await page.waitForSelector(".four-in-a-row-win");
  const small = await readWin(page);
  const smallCell = await page.evaluate(() => {
    const cell = document.querySelector('[data-cell="0-0"]');
    return cell ? cell.offsetHeight : 0;
  });
  check(
    "mobile board: the same four are emphasised and the board shrinks",
    small.wins === 4 && small.dims === 38 && small.outline === "3px" && smallCell > 0 && smallCell < 70,
    `wins=${small.wins} dims=${small.dims} cell=${smallCell}px`,
  );

  await page.close();
  await browser.close();
} finally {
  closeHarness();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
