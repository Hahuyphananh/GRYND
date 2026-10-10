// qa/barricade-practice-check.mjs
//
// Plays the REAL Barricade practice page in a real browser, end to end.
//
// The unit suites cover the engine and the bot; this one covers the thing a
// human actually touches — the board in a browser, at every difficulty and at
// phone widths. It checks, in order:
//
//   1. the board renders 9×9 squares, both pawns and two full barricade reserves;
//   2. an ILLEGAL tap changes nothing (no move, no state change, an explanation);
//   3. barricade mode previews a placement, places it and charges the reserve;
//   4. a groove the engine REFUSES (one that would seal a player's route, built
//      by covering a whole groove until only the sealing slot is left) previews
//      as invalid with the engine's own reason, and clicking it places nothing;
//   5. the in-game Restart clears the board;
//   6. a COMPLETE match finishes at Easy, Normal and Hard and the result overlay
//      reports a win or a defeat;
//   7. the result overlay's "New game" deals a fresh board;
//   8. the layout fits 1280×800 and phones (390×844, 320×568) with no sideways
//      overflow and no cut-off board, and a barricade can be placed by tap;
//   9. no JS errors anywhere.
//
// It never simulates the game itself: every action is a real click, and every
// verdict it asserts is read back out of the rendered board (which renders the
// rules engine's state).
//
// Screenshots and a JSON report land in qa/reports/barricade-practice/.
//
// The server must already be running (same convention as the other qa scripts):
//   CLERK_SECRET_KEY="" npx next dev -p 3210
//   node qa/barricade-practice-check.mjs
//
// Two page-level facts this harness has to work with:
//   * The first-load brand splash is a full-viewport overlay and the cookie
//     banner is fixed over the bottom of the page, so every context seeds the
//     app's own "splash already seen" flag and a cookie decision — exactly what
//     a returning visitor carries.
//   * The navigation bar is FIXED, and the board is taller than what is left
//     under it, so a control can sit underneath it after the page scrolls (a
//     locator click on a below-board button scrolls). Every board interaction
//     therefore re-centres the board and PROVES the point belongs to the control
//     it means to press (`elementFromPoint`), instead of clicking blind.
//     HTTP-level console noise (a signed-out visitor's 401 from
//     /api/user/daily-loss) is reported but never counted as a page error; any
//     real JS exception is.
//
// `--quick` plays only Hard and skips the phone passes.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports", "barricade-practice");
mkdirSync(REPORTS, { recursive: true });

const BASE = process.env.BASE || "http://localhost:3210";
const ROUTE = "/casino/barricade/play-ai";
const QUICK = process.argv.includes("--quick");
const TIERS = QUICK ? ["hard"] : ["easy", "normal", "hard"];
const MAX_ACTIONS = 220;
/** Groove used for the refusal test: the human never crosses it, so sealing it seals us. */
const SEAL_GROOVE_ROW = 4;

const SQUARE_SELECTOR = '[data-testid="barricade-square"]';
const SLOT_SELECTOR = '[data-testid="barricade-slot"]';

const results = [];
const problems = [];

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Make the browser look like a returning visitor: the first-load brand splash is
 * skipped, and the cookie banner has already been answered (declined — the
 * privacy-conservative choice; the banner only cares THAT an answer exists).
 * Both are overlays that would otherwise swallow the taps the harness means to
 * make, and a returning player is exactly who the board is built for.
 */
async function prepareVisitor(context) {
  await context.addInitScript(() => {
    try {
      window.sessionStorage.setItem("grynd:splash:seen:v1", "1");
      window.localStorage.setItem("grynd_cookie_consent", "declined");
    } catch {
      /* storage unavailable — the harness still waits the splash out */
    }
  });
}

function attachErrorWatch(page, label) {
  const errors = [];
  const httpNoise = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // A failed HTTP request logs a console error too. A signed-out visitor
    // legitimately gets 401s from platform endpoints, so those are reported
    // without failing the run — a thrown exception never is.
    if (/^Failed to load resource/.test(message.text())) httpNoise.push(message.text());
    else errors.push(`console: ${message.text()}`);
  });
  return {
    flush() {
      record(
        `${label}: no JS errors`,
        errors.length === 0,
        errors.slice(0, 4).join(" | ") || `${httpNoise.length} expected HTTP failure(s)`,
      );
    },
  };
}

/**
 * Wait until the board is mounted AND no first-load splash is on top of it.
 * (The storage flag above makes this a formality; this keeps the harness honest
 * if the flag ever stops being honoured.)
 */
async function waitForPlayableBoard(page, label) {
  await page.waitForSelector(`[data-testid="barricade-board"]`, { timeout: 30000 });
  try {
    await page.waitForFunction(() => !document.querySelector('[aria-label="Loading GRYND"]'), null, {
      timeout: 20000,
    });
    return true;
  } catch {
    record(`${label}: the loading splash clears`, false, 'the "Loading GRYND" overlay stayed up');
    return false;
  }
}

/** Read the board the way the page renders it. */
async function boardFacts(page) {
  return page.evaluate(
    ([squareSelector]) => {
      const squares = [...document.querySelectorAll(squareSelector)];
      const seatChip = (seat) => document.querySelector(`[data-testid="barricade-seat-${seat}"]`);
      const text = (testid) => document.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";
      return {
        squares: squares.length,
        legal: squares.filter((square) => square.dataset.legal === "true").length,
        pawns: squares
          .filter((square) => square.dataset.occupant !== "none")
          .map((square) => ({
            seat: square.dataset.occupant,
            row: Number(square.dataset.row),
            col: Number(square.dataset.col),
          })),
        walls: document.querySelectorAll('[data-testid="barricade-wall"]').length,
        myReserve: text("barricade-walls-player1"),
        aiReserve: text("barricade-walls-player2"),
        myTurn: seatChip("player1")?.dataset.active === "true",
        notice: text("barricade-notice").trim(),
        status: text("barricade-status").trim(),
        session: text("barricade-session").trim(),
        result: Boolean(document.querySelector('[data-testid="barricade-result"]')),
        resultLabel: document.querySelector('[role="dialog"]')?.getAttribute("aria-label") ?? "",
      };
    },
    [SQUARE_SELECTOR],
  );
}

const pawnOf = (facts, seat) => facts.pawns.find((pawn) => pawn.seat === seat) ?? null;

const homeBoard = (facts) => {
  const me = pawnOf(facts, "mine");
  const bot = pawnOf(facts, "theirs");
  return (
    !facts.result &&
    facts.walls === 0 &&
    facts.myReserve.trim() === "10" &&
    facts.aiReserve.trim() === "10" &&
    me?.row === 0 &&
    bot?.row === 8
  );
};

async function waitForMyTurn(page, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let facts = await boardFacts(page);
  while (Date.now() < deadline) {
    if (facts.result || facts.myTurn) return facts;
    await page.waitForTimeout(150);
    facts = await boardFacts(page);
  }
  return facts;
}

/** Centre the board so every square and groove is clear of the fixed nav bar. */
async function focusBoard(page) {
  await page.evaluate(() => {
    document.querySelector('[data-testid="barricade-board"]')?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(120);
}

/**
 * The viewport point of one board control, read after re-centring the board,
 * with `hitSelf` telling whether that point really belongs to the control.
 */
async function controlPoint(page, selector, match) {
  await focusBoard(page);
  return page.evaluate(
    ([sel, attrs]) => {
      const node = [...document.querySelectorAll(sel)].find((candidate) =>
        Object.entries(attrs).every(([key, value]) => candidate.dataset[key] === String(value)),
      );
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        hitSelf: hit === node || node.contains(hit),
        hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 48)}` : "none",
      };
    },
    [selector, match],
  );
}

const squarePoint = (page, col, row) => controlPoint(page, SQUARE_SELECTOR, { col, row });
const slotPoint = (page, slot) =>
  controlPoint(page, SLOT_SELECTOR, {
    col: slot.col,
    row: slot.row,
    orientation: slot.orientation,
  });

/** Every legal destination, with the board already re-centred. */
async function legalSquares(page) {
  await focusBoard(page);
  return page.$$eval('[data-testid="barricade-square"][data-legal="true"]', (squares) =>
    squares.map((square) => ({
      col: Number(square.dataset.col),
      row: Number(square.dataset.row),
    })),
  );
}

/** Every rendered groove with the engine's verdict, board re-centred. */
async function renderedSlots(page) {
  await focusBoard(page);
  return page.$$eval('[data-testid="barricade-slot"]', (nodes) =>
    nodes.map((node) => ({
      col: Number(node.dataset.col),
      row: Number(node.dataset.row),
      orientation: node.dataset.orientation,
      legal: node.dataset.legal,
    })),
  );
}

async function enterWallMode(page) {
  await page.click('[data-testid="barricade-mode-wall"]');
  await page.waitForSelector('[data-testid="barricade-slot"][data-legal="true"]', { timeout: 20000 });
}

const previewState = (page) =>
  page.evaluate(() => ({
    ok: document.querySelectorAll(".barricade-slot.is-preview-ok").length,
    invalid: document.querySelectorAll(".barricade-slot.is-preview-invalid").length,
    notice: (document.querySelector('[data-testid="barricade-notice"]')?.textContent ?? "").trim(),
  }));

/** Hover a groove (its preview) and click it, refusing to click a covered point. */
async function hoverAndClickSlot(page, slot) {
  const point = await slotPoint(page, slot);
  if (!point) return { ok: false, reason: "groove is no longer rendered" };
  if (!point.hitSelf) return { ok: false, reason: `point is covered by ${point.hit}` };
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(180);
  const preview = await previewState(page);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(300);
  return { ok: true, preview };
}

async function clickSlot(page, slot) {
  const point = await slotPoint(page, slot);
  if (!point) return { ok: false, reason: "groove is no longer rendered" };
  if (!point.hitSelf) return { ok: false, reason: `point is covered by ${point.hit}` };
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(280);
  return { ok: true };
}

async function clickSquare(page, square) {
  const point = await squarePoint(page, square.col, square.row);
  if (!point) return { ok: false, reason: "square is no longer rendered" };
  if (!point.hitSelf) return { ok: false, reason: `point is covered by ${point.hit}` };
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(200);
  return { ok: true };
}

/**
 * A greedy "advance and never bounce between two squares" pick: nearest to the
 * goal row first, never the square just left unless it is the only way out, and
 * least-visited as the tie-break so it can never oscillate forever.
 */
function chooseAdvance(candidates, targetRow, visits, previousKey) {
  const key = (square) => `${square.col},${square.row}`;
  const scored = candidates.map((square) => ({
    square,
    remaining: Math.abs(targetRow - square.row),
    visits: visits.get(key(square)) ?? 0,
    bounce: previousKey === key(square) ? 1 : 0,
  }));
  scored.sort(
    (a, b) =>
      a.remaining - b.remaining ||
      a.bounce - b.bounce ||
      a.visits - b.visits ||
      a.square.col - b.square.col ||
      a.square.row - b.square.row,
  );
  return scored[0]?.square ?? null;
}

/**
 * Cover a whole groove until the engine refuses the last slot — the reason a
 * board-sealing barricade exists in the UI at all. Returns the groove the engine
 * now refuses, or null if the position never produced one.
 */
async function buildBoardSealingGroove(page, grooveRow) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const facts = await waitForMyTurn(page);
    if (facts.result || !facts.myTurn) return null;
    await enterWallMode(page);

    const groove = (await renderedSlots(page)).filter(
      (slot) => slot.orientation === "horizontal" && slot.row === grooveRow,
    );
    const refused = groove.find((slot) => slot.legal === "false");
    if (refused) return refused;

    const legal = groove.filter((slot) => slot.legal === "true");
    if (legal.length === 0) return null;
    // Even columns tile the groove fastest (a barricade spans two squares), so
    // the sealing slot shows up after four placements instead of seven.
    const even = legal.filter((slot) => slot.col % 2 === 0);
    const pick = (even.length > 0 ? even : legal).sort((a, b) => a.col - b.col)[0];
    const placed = await clickSlot(page, pick);
    if (!placed.ok) return null;
  }
  return null;
}

async function barricadeChecks(page, tier) {
  await enterWallMode(page);

  // ── the groove grid is the engine's, on the CSS grid it draws ─────────
  // A ninth groove per axis would be a control the engine can only ever reject,
  // and it would widen the board with an implicit track.
  const geometry = await page.evaluate(
    ([squareSelector]) => {
      const board = document.querySelector('[data-testid="barricade-board"]');
      const style = getComputedStyle(board);
      return {
        columns: style.gridTemplateColumns.split(" ").length,
        rows: style.gridTemplateRows.split(" ").length,
        slots: document.querySelectorAll('[data-testid="barricade-slot"]').length,
        squares: document.querySelectorAll(squareSelector).length,
      };
    },
    [SQUARE_SELECTOR],
  );
  record(
    `${tier}: the groove controls are the engine's 8×8 slot grid on a 17-track board`,
    geometry.slots === 64 &&
      geometry.squares === 81 &&
      geometry.columns === 17 &&
      geometry.rows === 17,
    `slots=${geometry.slots} squares=${geometry.squares} tracks=${geometry.columns}×${geometry.rows}`,
  );

  // ── a legal placement: preview → place → charge the reserve ────────────
  const before = await boardFacts(page);
  const bot = pawnOf(before, "theirs");
  const targetRow = Math.max(0, (bot?.row ?? 4) - 1);
  const legal = (await renderedSlots(page))
    .filter((slot) => slot.orientation === "horizontal" && slot.legal === "true")
    .sort((a, b) => Math.abs(a.row - targetRow) - Math.abs(b.row - targetRow) || a.col - b.col);

  if (legal.length === 0) {
    record(`${tier}: a legal barricade groove was offered`, false, "none found");
  } else {
    const placed = await hoverAndClickSlot(page, legal[0]);
    const after = await boardFacts(page);
    record(
      `${tier}: a legal barricade previews as legal, is placed and charged to the reserve`,
      placed.ok &&
        placed.preview?.ok === 1 &&
        placed.preview?.invalid === 0 &&
        after.walls === before.walls + 1 &&
        Number(after.myReserve.trim()) === Number(before.myReserve.trim()) - 1,
      placed.ok
        ? `previewOk=${placed.preview?.ok} walls ${before.walls}→${after.walls}, reserve ${before.myReserve.trim()}→${after.myReserve.trim()}`
        : `could not press the groove: ${placed.reason}`,
    );
  }

  // ── a groove the engine refuses ────────────────────────────────────────
  const refused = await buildBoardSealingGroove(page, SEAL_GROOVE_ROW);
  if (!refused) {
    record(
      `${tier}: a board-sealing groove is refused by the engine`,
      false,
      `could not build a sealed groove at row ${SEAL_GROOVE_ROW}`,
    );
  } else {
    const beforeRefusal = await boardFacts(page);
    const attempted = await hoverAndClickSlot(page, refused);
    const afterRefusal = await boardFacts(page);
    record(
      `${tier}: a refused groove previews as invalid and states the engine's reason`,
      attempted.ok && attempted.preview?.invalid === 1 && attempted.preview?.notice.length > 0,
      attempted.ok
        ? `invalid=${attempted.preview?.invalid} notice="${attempted.preview?.notice}"`
        : `could not press the groove: ${attempted.reason}`,
    );
    record(
      `${tier}: clicking a refused groove places nothing and explains why`,
      afterRefusal.walls === beforeRefusal.walls &&
        afterRefusal.myReserve === beforeRefusal.myReserve &&
        afterRefusal.notice.length > 0,
      `walls ${beforeRefusal.walls}→${afterRefusal.walls}, reserve ${beforeRefusal.myReserve.trim()}→${afterRefusal.myReserve.trim()}, notice="${afterRefusal.notice}"`,
    );
  }

  // ── the in-game Restart button ─────────────────────────────────────────
  await page.click('[data-testid="barricade-restart"]');
  await page.waitForTimeout(400);
  const fresh = await boardFacts(page);
  record(
    `${tier}: the in-game Restart clears walls, reserves and both pawns`,
    homeBoard(fresh),
    `walls=${fresh.walls} reserves=${fresh.myReserve.trim()}/${fresh.aiReserve.trim()}`,
  );
}

async function playMatch(page, tier) {
  await page.click(`[data-testid="ai-difficulty-barricade-${tier}"]`);
  const started = await boardFacts(page);
  record(
    `${tier}: starts on a full board (81 squares, two pawns, 10 barricades each)`,
    started.squares === 81 &&
      started.pawns.length === 2 &&
      started.myReserve.trim() === "10" &&
      started.aiReserve.trim() === "10",
    `squares=${started.squares} pawns=${started.pawns.length} reserves=${started.myReserve.trim()}/${started.aiReserve.trim()}`,
  );

  // ── an illegal tap must change nothing ────────────────────────────────
  if (started.myTurn) {
    const illegalSquare = await page.$eval(
      '[data-testid="barricade-square"][data-legal="false"][data-occupant="none"]',
      (square) => Number(square.dataset.row) * 10 + Number(square.dataset.col),
    );
    const before = await boardFacts(page);
    const press = await clickSquare(page, {
      col: illegalSquare % 10,
      row: Math.floor(illegalSquare / 10),
    });
    const after = await boardFacts(page);
    const pawnsHeld = before.pawns.every((pawn) => {
      const now = pawnOf(after, pawn.seat);
      return now && now.row === pawn.row && now.col === pawn.col;
    });
    record(
      `${tier}: an illegal move is refused, explained and changes nothing`,
      press.ok &&
        pawnsHeld &&
        after.walls === before.walls &&
        after.myReserve === before.myReserve &&
        after.notice.length > 0,
      press.ok ? `notice="${after.notice}"` : `could not press the square: ${press.reason}`,
    );
  }

  await barricadeChecks(page, tier);

  // ── play the match out ────────────────────────────────────────────────
  const visits = new Map();
  let previousKey = null;
  let actions = 0;
  let outcome = null;
  let stall = null;
  // When the pawn last gained a row. The harness races first and only spends a
  // barricade once the bot's walls have actually stopped it — which is how a
  // human plays, and what lets an even race finish in a win at the easy tier.
  let lastProgressAction = 0;
  let lastWallAction = -3;
  let bestRow = -1;

  while (actions < MAX_ACTIONS) {
    const facts = await boardFacts(page);
    if (facts.result) {
      outcome = facts.resultLabel;
      break;
    }
    if (!facts.myTurn) {
      await page.waitForTimeout(200);
      continue;
    }

    const me = pawnOf(facts, "mine");
    const bot = pawnOf(facts, "theirs");
    const myProgress = me ? me.row : 0;
    const botProgress = bot ? 8 - bot.row : 0;
    const wallsLeft = Number(facts.myReserve.trim());

    if (myProgress > bestRow) {
      bestRow = myProgress;
      lastProgressAction = actions;
    }

    // Slow the bot down once it has actually stopped us — always through the
    // engine's own legal-groove list.
    if (
      bot &&
      botProgress >= myProgress &&
      wallsLeft > 0 &&
      actions - lastProgressAction >= 4 &&
      actions - lastWallAction >= 3 &&
      actions > 0
    ) {
      await enterWallMode(page);
      const botRow = Math.max(0, bot.row - 1);
      const candidates = (await renderedSlots(page))
        .filter((slot) => slot.orientation === "horizontal" && slot.legal === "true")
        .sort((a, b) => Math.abs(a.row - botRow) - Math.abs(b.row - botRow) || a.col - b.col);
      if (candidates.length > 0) {
        await clickSlot(page, candidates[0]);
        lastWallAction = actions;
        actions += 1;
        continue;
      }
    }

    await page.click('[data-testid="barricade-mode-move"]');
    const options = await legalSquares(page);
    if (options.length === 0) {
      stall = "no legal square was offered";
      break;
    }
    if (actions % 5 === 0) {
      console.log(
        `   … ${tier} action ${actions}: my row ${me?.row} col ${me?.col}, bot row ${bot?.row}, my barricades ${wallsLeft}`,
      );
    }
    const square = chooseAdvance(options, 8, visits, previousKey);
    visits.set(`${square.col},${square.row}`, (visits.get(`${square.col},${square.row}`) ?? 0) + 1);
    previousKey = me ? `${me.col},${me.row}` : null;
    const press = await clickSquare(page, square);
    if (!press.ok) {
      stall = `square ${square.col},${square.row} was not pressable: ${press.reason}`;
      break;
    }
    actions += 1;
  }

  record(
    `${tier}: a complete match was played (no stall, no infinite loop)`,
    !stall && Boolean(outcome) && actions < MAX_ACTIONS,
    `actions=${actions} outcome="${outcome}"${stall ? ` stall=${stall}` : ""}`,
  );
  record(
    `${tier}: the result overlay reports a win or a defeat`,
    Boolean(outcome) && /WIN|LOSS/i.test(outcome),
    `dialog="${outcome}"`,
  );

  if (outcome) {
    await page.locator('[role="dialog"]').getByRole("button", { name: /new game/i }).click();
    await page.waitForTimeout(500);
    const restarted = await boardFacts(page);
    record(
      `${tier}: New game deals a fresh board`,
      homeBoard(restarted),
      `walls=${restarted.walls} pawns=${JSON.stringify(restarted.pawns)}`,
    );
  }

  return { actions, outcome };
}

async function run() {
  const browser = await chromium.launch();

  // ── desktop: play every tier ──────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await prepareVisitor(desktop);
  const page = await desktop.newPage();
  const watch = attachErrorWatch(page, "desktop");

  const response = await page.goto(`${BASE}${ROUTE}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  record(
    "desktop: the practice route responds",
    Boolean(response) && response.status() < 400,
    `status=${response?.status()}`,
  );
  await waitForPlayableBoard(page, "desktop");
  const opened = await boardFacts(page);
  record(
    "desktop: the board mounts with both goal baselines labelled",
    opened.squares === 81 &&
      (await page.locator('[data-testid="barricade-goal-mine"]').count()) === 1 &&
      (await page.locator('[data-testid="barricade-goal-theirs"]').count()) === 1,
    `squares=${opened.squares} legal moves=${opened.legal}`,
  );
  await page.screenshot({ path: join(REPORTS, "desktop-start.png"), fullPage: true });

  for (const tier of TIERS) {
    const summary = await playMatch(page, tier);
    await page.screenshot({ path: join(REPORTS, `desktop-${tier}.png`), fullPage: true });
    console.log(`   ${tier}: ${summary.actions} actions, ${summary.outcome || "no result"}`);
  }
  watch.flush("desktop");
  await desktop.close();

  // ── phones: layout and touch ──────────────────────────────────────────
  if (!QUICK) {
    for (const size of [
      { name: "phone-390", width: 390, height: 844 },
      { name: "phone-320", width: 320, height: 568 },
    ]) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        isMobile: true,
        hasTouch: true,
      });
      await prepareVisitor(context);
      const phone = await context.newPage();
      const phoneWatch = attachErrorWatch(phone, size.name);
      await phone.goto(`${BASE}${ROUTE}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await waitForPlayableBoard(phone, size.name);
      await phone.waitForTimeout(400);

      const layout = await phone.evaluate(
        ([squareSelector]) => {
          const board = document.querySelector('[data-testid="barricade-board"]');
          const rect = board.getBoundingClientRect();
          const controls = document.querySelector('[data-testid="barricade-mode-wall"]');
          const counter = document.querySelector('[data-testid="barricade-walls-player1"]');
          return {
            viewport: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            boardLeft: Math.round(rect.left),
            boardRight: Math.round(rect.right),
            boardHeight: Math.round(rect.height),
            square: document.querySelector(squareSelector).getBoundingClientRect().height,
            controlsVisible: Boolean(controls && controls.getBoundingClientRect().height > 0),
            counterVisible: Boolean(counter && counter.getBoundingClientRect().height > 0),
          };
        },
        [SQUARE_SELECTOR],
      );

      record(
        `${size.name}: nothing overflows sideways`,
        layout.documentWidth <= layout.viewport + 1 &&
          layout.boardLeft >= -1 &&
          layout.boardRight <= layout.viewport + 1,
        `doc=${layout.documentWidth} viewport=${layout.viewport} board=${layout.boardLeft}…${layout.boardRight}`,
      );
      record(
        `${size.name}: the board is usable (tap targets and counters visible)`,
        layout.boardHeight > 200 && layout.square >= 20 && layout.controlsVisible && layout.counterVisible,
        `square=${layout.square.toFixed(1)}px board=${layout.boardHeight}px`,
      );

      // Barricade mode must work by touch too.
      await phone.click('[data-testid="barricade-orientation-vertical"]');
      await enterWallMode(phone);
      const slot = (await renderedSlots(phone)).find(
        (candidate) => candidate.orientation === "vertical" && candidate.legal === "true",
      );
      if (!slot) {
        record(`${size.name}: vertical grooves are offered`, false, "none found");
      } else {
        const beforeWall = await boardFacts(phone);
        const placed = await clickSlot(phone, slot);
        const afterWall = await boardFacts(phone);
        record(
          `${size.name}: a barricade can be placed by tap`,
          placed.ok && afterWall.walls === beforeWall.walls + 1,
          placed.ok
            ? `walls ${beforeWall.walls}→${afterWall.walls}`
            : `could not press the groove: ${placed.reason}`,
        );
      }
      await phone.screenshot({ path: join(REPORTS, `${size.name}-wall-mode.png`), fullPage: true });
      phoneWatch.flush(size.name);
      await context.close();
    }
  }

  await browser.close();

  const report = {
    base: BASE,
    route: ROUTE,
    ranAt: new Date().toISOString(),
    passed: results.filter((entry) => entry.passed).length,
    failed: problems.length,
    problems,
    results,
  };
  writeFileSync(join(REPORTS, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n${report.passed}/${results.length} checks passed`);
  if (problems.length > 0) {
    console.log(`\nFAILURES:\n- ${problems.join("\n- ")}`);
    process.exitCode = 1;
  }
}

await run();
