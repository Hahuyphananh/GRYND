// qa/solitaire-review-live-check.mjs
//
// PLAY REAL GAMES, THEN REVIEW THEM.
//
// `solitaire-review-summary-check.mjs` serves a real review payload through the
// real page. This script goes one step further: it plays an actual guest Solo
// deal and the actual server Daily deal through the board's own click model,
// completes them, opens Game Review from the results dialog and checks the
// closing summary against the game that was really just played.
//
// The moves are not random: the deal is read from the game itself (the guest
// Solo seed in localStorage, the server's Daily payload) and solved with the
// same solver the app uses to serve solvable deals. Every move is then clicked
// on the board — no state is injected, no API is mocked.
//
// Run (dev server on :3000):
//   node --import tsx qa/solitaire-review-live-check.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { applyMove, initialStateFromDeal } from "../src/lib/solitaire-duel/rules.ts";
import { solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });
const BASE = process.env.SOLITAIRE_QA_BASE || "http://localhost:3000";
const SESSION_KEY = "grynd.solitaire.session.v1";
const COMPLETED_KEY = "grynd.solitaire.completed.v1";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ channel: "chrome" });
}

const watchErrors = (page) => {
  const errors = [];
  page.on("pageerror", (error) => {
    const message = String(error);
    // This QA machine cannot reach Clerk's CDN; the solitaire review does not
    // depend on it.
    if (message.includes("failed_to_load_clerk_js")) return;
    errors.push(message);
  });
  return errors;
};

const boardPly = (page) =>
  page
    .$eval('[data-testid="solitaire-board"]', (el) => Number(el.dataset.ply))
    .catch(() => null);

const gameComplete = async (page) =>
  (await page.locator('div[role="dialog"][aria-label="Game complete"]').count()) > 0;

/**
 * A finished run clears the active session synchronously, including the
 * auto-finish that solves the last cards for the player. The results dialog
 * appears only after the cosmetic flight, so this is the honest completion
 * signal between moves.
 */
const sessionFinished = (page) =>
  page.evaluate((key) => {
    try {
      return window.localStorage.getItem(key) === null;
    } catch {
      return false;
    }
  }, SESSION_KEY);

const waitForPly = (page, before) =>
  page.waitForFunction(
    (prev) => {
      const board = document.querySelector('[data-testid="solitaire-board"]');
      if (!board) return true;
      return Number(board.dataset.ply) > prev;
    },
    before,
    { timeout: 8_000 },
  );

/**
 * Press one board element through the board's own handlers.
 *
 * The board resolves a press at pointerdown, so a real pointerdown is the
 * decision; the trailing click is dispatched too and consumed by the board's
 * one-decision-per-gesture guard. Addressing the element itself (rather than
 * guessed coordinates) means a fanned card can never be missed or hit through
 * the card overlapping it.
 */
async function tap(page, selector, { deepest = false } = {}) {
  const found = await page.evaluate(
    ({ sel, deep }) => {
      const root = document.querySelector(sel);
      if (!root) return false;
      const el =
        (deep ? root.querySelector("[data-drag-slot], button[data-drop-kind]") : null) ??
        root;
      const base = {
        bubbles: true,
        cancelable: true,
        pointerType: "mouse",
        button: 0,
        isPrimary: true,
      };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      return true;
    },
    { sel: selector, deep: deepest },
  );
  if (!found) throw new Error(`missing board element: ${selector}`);
  await page.waitForTimeout(30);
}

const clickCard = (page, column, index) =>
  tap(page, `[data-testid="solitaire-card-${column}-${index}"]`);

const clickPile = (page, selector, options) => tap(page, selector, options);

const cardIndex = (page, column, card) =>
  page.evaluate(
    ({ column: col, suit, rank }) => {
      let found = -1;
      for (const node of document.querySelectorAll(`[data-testid^="solitaire-card-${col}-"]`)) {
        if (node.dataset.card === `${suit}-${rank}`) {
          found = Number(node.dataset.testid.split("-").pop());
        }
      }
      return found;
    },
    { column, suit: card.suit, rank: card.rank },
  );

const topCardIndex = (page, column) =>
  page.evaluate((col) => {
    let top = -1;
    for (const node of document.querySelectorAll(`[data-testid^="solitaire-card-${col}-"]`)) {
      top = Math.max(top, Number(node.dataset.testid.split("-").pop()));
    }
    return top;
  }, column);

async function clickTableauTarget(page, column) {
  const top = await topCardIndex(page, column);
  if (top < 0) await clickPile(page, `[data-testid="solitaire-column-${column}-empty"]`);
  else await clickCard(page, column, top);
}

/** What the board believes right now, for a failed move's error message. */
const boardDiagnostics = (page) =>
  page.evaluate(() => {
    const board = document.querySelector('[data-testid="solitaire-board"]');
    return {
      ply: board?.dataset.ply ?? null,
      selected: board?.dataset.selected ?? null,
      alert: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
    };
  });

/** One solved move, clicked exactly the way a player clicks it. */
async function playMove(page, move, moveIndex = 0) {
  const before = await boardPly(page);
  switch (move.kind) {
    case "draw": {
      await clickPile(page, '[data-testid="solitaire-stock"]');
      await page.waitForTimeout(120);
      if ((await boardPly(page)) === before) {
        // The stock is the one action decided by the trailing click alone. When
        // the previous move re-rendered the pile under the pointer, its click
        // never arrives and the board swallows the next one; retry once after
        // that guard has expired.
        await page.waitForTimeout(500);
        await clickPile(page, '[data-testid="solitaire-stock"]');
      }
      break;
    }
    case "waste-to-foundation":
      await clickPile(page, '[data-testid="solitaire-waste-top"]');
      await clickPile(page, `[data-testid="solitaire-foundation-${move.suit}"]`, {
        deepest: true,
      });
      break;
    case "waste-to-tableau":
      await clickPile(page, '[data-testid="solitaire-waste-top"]');
      await clickTableauTarget(page, move.toColumn);
      break;
    case "tableau-to-foundation": {
      const index = await cardIndex(page, move.fromColumn, move.card);
      if (index < 0) throw new Error(`source card missing: ${JSON.stringify(move.card)}`);
      await clickCard(page, move.fromColumn, index);
      await clickPile(page, `[data-testid="solitaire-foundation-${move.suit}"]`, {
        deepest: true,
      });
      break;
    }
    case "tableau-to-tableau": {
      const index = await cardIndex(page, move.fromColumn, move.card);
      if (index < 0) throw new Error(`source card missing: ${JSON.stringify(move.card)}`);
      await clickCard(page, move.fromColumn, index);
      await clickTableauTarget(page, move.toColumn);
      break;
    }
    case "foundation-to-tableau":
      await clickPile(page, `[data-testid="solitaire-foundation-${move.suit}"]`, {
        deepest: true,
      });
      await clickTableauTarget(page, move.toColumn);
      break;
    default:
      throw new Error(`unknown move kind: ${move.kind}`);
  }
  try {
    await waitForPly(page, before);
  } catch {
    const diagnostics = await boardDiagnostics(page);
    throw new Error(
      `move ${moveIndex + 1} ${JSON.stringify(move)} did not advance the board: ${JSON.stringify(diagnostics)}`,
    );
  }
}

/** A compact, order-preserving picture of a board, for comparing runs. */
const stateSignature = (state) =>
  JSON.stringify({
    foundations: ["spades", "hearts", "diamonds", "clubs"].map(
      (suit) => state.foundations[suit].length,
    ),
    stock: state.stock.length,
    waste: state.waste.map((card) => `${card.suit[0]}${card.rank}`),
    tableau: state.tableau.map((column) =>
      column.map((pile) =>
        pile.faceUp && pile.card
          ? `${pile.card.suit[0]}${pile.card.rank}`
          : "??",
      ),
    ),
  });

const clientState = (page) =>
  page.evaluate((key) => {
    try {
      return JSON.parse(window.localStorage.getItem(key) || "null")?.state ?? null;
    } catch {
      return null;
    }
  }, SESSION_KEY);

async function playLine(page, moves, deal) {
  let expected = initialStateFromDeal(deal);
  for (let i = 0; i < moves.length; i += 1) {
    if ((await gameComplete(page)) || (await sessionFinished(page))) return i;
    if (i < 3) console.log(`  move ${i + 1}: ${JSON.stringify(moves[i])}`);
    await playMove(page, moves[i], i);

    // The board must be the board the solved line says it is. If a click is
    // ever answered with a DIFFERENT legal move, the run has quietly diverged
    // and every later move would be a guess; catch that at its first move.
    const applied = applyMove({ state: expected, move: moves[i] });
    if (!applied.ok) {
      throw new Error(`solver move ${i + 1} is not legal: ${applied.error}`);
    }
    expected = applied.state;
    const actual = await clientState(page);
    if (actual && stateSignature(actual) !== stateSignature(expected)) {
      throw new Error(
        `move ${i + 1} ${JSON.stringify(moves[i])} diverged from the solved line\n` +
          `  board:   ${stateSignature(actual)}\n` +
          `  expected:${stateSignature(expected)}`,
      );
    }

    if (i % 40 === 0) console.log(`  … ${i + 1}/${moves.length} moves clicked`);
    if ((await gameComplete(page)) || (await sessionFinished(page))) return i + 1;
  }
  return moves.length;
}

const lastCompleted = (page, key) =>
  page.evaluate((storageKey) => {
    try {
      const rows = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
      const last = rows[rows.length - 1] ?? null;
      return last ? { id: last.id, mode: last.mode, moves: last.log?.length ?? 0 } : null;
    } catch {
      return null;
    }
  }, key);

/** The value cell of one summary stat, without its label. */
const statValue = async (page, testId) =>
  (await page.textContent(`[data-testid="${testId}"] dd`))?.trim() ?? "";

const solidSummary = async (page) => ({
  mode: await statValue(page, "review-summary-mode"),
  status: await statValue(page, "review-summary-status"),
  moves: await statValue(page, "review-summary-moves"),
  duration: await statValue(page, "review-summary-duration"),
  foundations: await statValue(page, "review-summary-foundations"),
  insights: await statValue(page, "review-summary-insights"),
  personalBest:
    (await page.textContent('[data-testid="review-personal-best"]'))?.trim() ?? "",
});

const completedRing = (page) =>
  page.evaluate((storageKey) => window.localStorage.getItem(storageKey), COMPLETED_KEY);

/** Finish the review flow from the results dialog. */
async function openReviewFromResult(page, context) {
  const link = page.locator('[data-testid="solitaire-analysis"]');
  await link.waitFor({ state: "visible", timeout: 30_000 });
  const href = await link.getAttribute("href");
  const review = await context.newPage();
  const errors = watchErrors(review);
  await review.goto(BASE + href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await review.waitForSelector('[data-testid="review-completion-summary"]', { timeout: 60_000 });
  await review.waitForSelector('[data-testid="review-board"]', { timeout: 60_000 });
  return { review, href, errors };
}

// ── 1. Real guest Solo game ───────────────────────────────────────────────
const soloContext = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await soloContext.addInitScript(() => {
  try {
    window.localStorage.setItem("grynd_cookie_consent", "declined");
  } catch {
    // Storage unavailable: the game still deals.
  }
});
const solo = await soloContext.newPage();
const soloErrors = watchErrors(solo);
await solo.goto(`${BASE}/solitaire`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await solo.waitForSelector('[data-testid="solitaire-board"]', { timeout: 60_000 });
// Let the deal animation finish before the first card press.
await solo.waitForTimeout(900);

let soloLine = null;
let soloSeed = null;
for (let attempt = 1; attempt <= 6 && !soloLine; attempt += 1) {
  soloSeed = await solo.evaluate((key) => {
    try {
      return JSON.parse(window.localStorage.getItem(key) || "null")?.seed ?? null;
    } catch {
      return null;
    }
  }, SESSION_KEY);
  if (!Number.isInteger(soloSeed)) throw new Error("the guest Solo seed was not stored");
  soloLine = solveDealLine(dealFromSeed(soloSeed));
  if (!soloLine) {
    console.log(`  solo seed ${soloSeed} has no solving line; dealing another`);
    await solo.click('button:has-text("New game")');
    await solo.waitForTimeout(400);
  }
}
check("a real guest Solo deal was solved", Boolean(soloLine), `seed ${soloSeed}`);
if (!soloLine) throw new Error("could not find a solvable guest Solo deal");

const soloPlayed = await playLine(solo, soloLine, dealFromSeed(soloSeed));
// The last cards may have been auto-finished, and the results dialog only
// appears once their cosmetic flight lands.
const soloComplete = await solo
  .locator('div[role="dialog"][aria-label="Game complete"]')
  .waitFor({ state: "visible", timeout: 30_000 })
  .then(() => true)
  .catch(() => false);
check(
  "the real Solo game reaches the completed board",
  soloComplete,
  `${soloPlayed} of ${soloLine.length} solved moves clicked`,
);
await solo.waitForTimeout(600);
const soloRecordBeforeReview = await completedRing(solo);
const soloResult = await lastCompleted(solo, COMPLETED_KEY);
check("the completed Solo game is kept on this device for review", Boolean(soloResult?.id));

const soloReview = await openReviewFromResult(solo, soloContext);
const soloSummary = await solidSummary(soloReview.review);
check("the Solo review opens from the real results dialog", soloReview.href.startsWith("/solitaire/review/solo/"), soloReview.href);
check("the live Solo summary names the mode", soloSummary.mode === "Solo Solitaire", soloSummary.mode);
check("the live Solo summary reports the completed status", soloSummary.status === "Complete", soloSummary.status);
check(
  "the live Solo summary counts the moves actually played",
  soloSummary.moves === String(soloResult?.moves ?? -1),
  `${soloSummary.moves} shown / ${soloResult?.moves} stored`,
);
check("the live Solo summary shows 52 cards on the foundations", soloSummary.foundations === "52 / 52", soloSummary.foundations);
check("the live Solo summary shows a real completion time", /^\d+:\d{2}$/.test(soloSummary.duration) && soloSummary.duration !== "0:00", soloSummary.duration);
check("the live Solo summary scores meaningful insights", /^\d+$/.test(soloSummary.insights), soloSummary.insights);
check("the live Solo summary has a personal-best line", soloSummary.personalBest.length > 0, soloSummary.personalBest);
check(
  "opening the Solo review changes no stored game",
  (await completedRing(solo)) === soloRecordBeforeReview,
);
check("live Solo review: no runtime errors", soloReview.errors.length === 0, soloReview.errors.join("; "));
await soloReview.review.screenshot({ path: join(REPORTS, "review-live-solo.png"), fullPage: true });
check("live Solo game: no runtime errors", soloErrors.length === 0, soloErrors.join("; "));
await soloReview.review.close();
await soloContext.close();

// ── 2. Real Daily Challenge (the server's own deal) ───────────────────────
const dailyContext = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await dailyContext.addInitScript(() => {
  try {
    window.localStorage.setItem("grynd_cookie_consent", "declined");
  } catch {
    // Storage unavailable: the game still deals.
  }
});
const daily = await dailyContext.newPage();
const dailyErrors = watchErrors(daily);
let dailyPayload = null;
daily.on("response", async (response) => {
  if (
    response.request().method() === "GET" &&
    response.url().includes("/api/solitaire/daily")
  ) {
    try {
      const body = await response.json();
      if (body?.data?.deal) dailyPayload = body.data;
    } catch {
      // A non-JSON response cannot be the deal; the button timeout reports it.
    }
  }
});
await daily.goto(`${BASE}/daily`, { waitUntil: "domcontentloaded", timeout: 60_000 });
const dailyStart = daily.locator("button", { hasText: /Start challenge|Replay as practice/ }).first();
await dailyStart.waitFor({ state: "visible", timeout: 60_000 });
check("the live Daily page dealt the server's challenge", Boolean(dailyPayload?.deal), dailyPayload?.dateKey ?? "");

await dailyStart.click();
await daily.waitForSelector('[data-testid="solitaire-board"]', { timeout: 60_000 });
// Let the deal animation finish before the first card press.
await daily.waitForTimeout(900);
const dailyLine = dailyPayload?.deal ? solveDealLine(dailyPayload.deal) : null;
check("the live Daily deal was solved", Boolean(dailyLine), `${dailyLine?.length ?? 0} moves`);

const dailyPlayed = dailyLine
  ? await playLine(daily, dailyLine, dailyPayload.deal)
  : 0;
check(
  "the real Daily game reaches the completed board",
  await gameComplete(daily),
  `${dailyPlayed} of ${dailyLine?.length ?? 0} solved moves clicked`,
);
await daily.waitForTimeout(600);
const dailyRecordBeforeReview = await completedRing(daily);
const dailyResult = await lastCompleted(daily, COMPLETED_KEY);
check("the completed Daily game is kept on this device for review", dailyResult?.mode === "daily");

const dailyReview = await openReviewFromResult(daily, dailyContext);
const dailySummary = await solidSummary(dailyReview.review);
check("the Daily review opens from the real results dialog", dailyReview.href.startsWith("/solitaire/review/daily/"), dailyReview.href);
check("the live Daily summary names the mode", dailySummary.mode === "Daily Challenge", dailySummary.mode);
check("the live Daily summary reports the completed status", dailySummary.status === "Complete", dailySummary.status);
check(
  "the live Daily summary counts the moves actually played",
  dailySummary.moves === String(dailyResult?.moves ?? -1),
  `${dailySummary.moves} shown / ${dailyResult?.moves} stored`,
);
check("the live Daily summary shows 52 cards on the foundations", dailySummary.foundations === "52 / 52", dailySummary.foundations);
check("the live Daily summary shows a real completion time", /^\d+:\d{2}$/.test(dailySummary.duration) && dailySummary.duration !== "0:00", dailySummary.duration);
check("the live Daily summary scores meaningful insights", /^\d+$/.test(dailySummary.insights), dailySummary.insights);
check("the live Daily summary has a personal-best line", dailySummary.personalBest.length > 0, dailySummary.personalBest);
check(
  "opening the Daily review changes no stored game",
  (await completedRing(daily)) === dailyRecordBeforeReview,
);
check("live Daily review: no runtime errors", dailyReview.errors.length === 0, dailyReview.errors.join("; "));
await dailyReview.review.screenshot({ path: join(REPORTS, "review-live-daily.png"), fullPage: true });
check("live Daily game: no runtime errors", dailyErrors.length === 0, dailyErrors.join("; "));
await dailyReview.review.close();
await dailyContext.close();

// ── 3. The board legend itself is localized ───────────────────────────────
// The legend is the one place a player reads the rules of the board, so it is
// checked on the real gameplay route, not only in the review screenshot.
for (const [language, expected] of [
  ["fr", "Fais glisser une carte"],
  ["es", "Arrastra una carta"],
]) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.addInitScript(
    ({ lang }) => {
      try {
        window.localStorage.setItem("grynd_cookie_consent", "declined");
        window.localStorage.setItem("casino_app_language", lang);
      } catch {
        // Storage unavailable: the page still renders the default locale.
      }
    },
    { lang: language },
  );
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`${BASE}/solitaire`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 60_000 });
  await page
    .waitForFunction(
      (wanted) =>
        document
          .querySelector('[data-testid="solitaire-board"]')
          ?.textContent?.includes(wanted),
      expected,
      { timeout: 10_000 },
    )
    .catch(() => {});
  const boardText = (await page.textContent('[data-testid="solitaire-board"]')) ?? "";
  check(`${language} board legend is translated`, boardText.includes(expected));
  check(`${language} board legend has no runtime errors`, errors.length === 0, errors.join("; "));
  await page.screenshot({ path: join(REPORTS, `live-board-legend-${language}.png`) });
  await context.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
