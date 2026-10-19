// qa/joiner-first-fiar-check.mjs
//
// Live browser check for the joiner-first rule in Four in a Row.
//
// The server writes currentTurn: "guest" when an opponent joins (see
// tests/joiner-starts.test.mjs), but that is only half the contract: the
// guest's real match page must treat that opening turn as THEIRS. This mounts
// the real page (qa/fiar-winline-harness.jsx) with a mocked game-state:
//
//   1. guest + currentTurn "guest" → the drop columns are enabled and a click
//      sends the move (column 4) instead of being swallowed.
//   2. host + currentTurn "guest" → the host's columns are disabled, so the
//      check is testing seat gating and not "columns are always live".
//
// Run: node qa/joiner-first-fiar-check.mjs

import { chromium } from "playwright";
import { mountHarness } from "./fiar-multiplayer-page.mjs";

const emptyBoard = () => Array.from({ length: 6 }, () => Array(7).fill(0));

const liveState = (overrides = {}) => ({
  status: "in_progress",
  result: null,
  hostClerkId: "host1",
  guestClerkId: "guest1",
  hostName: "Host",
  guestName: "Guest",
  hostDiscsUsed: 0,
  guestDiscsUsed: 0,
  betAmount: 0,
  isAiGame: false,
  board: emptyBoard(),
  moveTimeLimit: 60,
  moveTimeRemaining: 42,
  replayTimeRemaining: 0,
  ...overrides,
});

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const { base, close } = await mountHarness({ title: "Four in a Row joiner-first" });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

try {
  await page.goto(base, { waitUntil: "load" });

  // ── 1. The guest opens the match ────────────────────────────────────────
  await page.evaluate((state) => window.mountGame(state), {
    ...liveState(),
    role: "guest",
    currentTurn: "guest",
  });
  await page.waitForSelector(".four-in-a-row-board");
  await page.waitForSelector('button[title="Drop in column 4"]');

  const guestButton = await page.$('button[title="Drop in column 4"]');
  const guestDisabled = await guestButton.evaluate((el) => el.disabled);
  const guestLocked = await page.evaluate(() =>
    Boolean(document.querySelector(".four-in-a-row-drop-controls--locked")),
  );

  check(
    "guest opening turn: drop columns are enabled",
    guestDisabled === false && guestLocked === false,
    `disabled=${guestDisabled} locked=${guestLocked}`,
  );

  await guestButton.click();
  await page.waitForFunction(() => window.__heldMoves === 1);
  const body = await page.evaluate(() => window.__lastMoveBody);
  // The button title is 1-based ("column 4"); the wire value is 0-based.
  check(
    "guest opening turn: clicking a column sends the move",
    body?.column === 3,
    JSON.stringify(body),
  );

  await page.evaluate(() => window.__releaseMove?.());
  await page.waitForFunction(() => window.__heldMoves === 1);

  // ── 2. The same state seen from the host seat is not playable ───────────
  await page.evaluate((state) => window.mountGame(state), {
    ...liveState(),
    role: "host",
    currentTurn: "guest",
  });
  await page.waitForSelector('button[title="Drop in column 4"]');
  const hostButton = await page.$('button[title="Drop in column 4"]');
  const hostDisabled = await hostButton.evaluate((el) => el.disabled);
  check(
    "host waiting for the joiner: drop columns are disabled",
    hostDisabled === true,
    `disabled=${hostDisabled}`,
  );

  check("no runtime errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
