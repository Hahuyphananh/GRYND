// qa/solitaire-review-check.mjs
//
// Phase 2 — the REAL review page, driven at desktop and mobile sizes.
//
// The route is served by the dev server; only the review API is fulfilled with
// a real completed deal + validated solved line. That keeps the board, cards,
// controls, worker and responsive layout on their production code paths.
//
// Run (dev server on :3000): node --import tsx qa/solitaire-review-check.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeSolitaireGame } from "../src/lib/solitaire-duel/analysis.ts";
import { detectCardAnimations } from "../src/lib/solitaire-duel/cardAnimations.ts";
import { replayMoves, viewForState } from "../src/lib/solitaire-duel/rules.ts";
import { solvableDealFromSeed, solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });
const BASE = process.env.SOLITAIRE_QA_BASE || "http://localhost:3000";
const GAME_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_URL = `${BASE}/solitaire/review/solo/${GAME_ID}`;

const DEAL = solvableDealFromSeed(7);
const MOVES = (solveDealLine(DEAL) ?? []).map((move) => ({ kind: move.kind, move }));
const TOTAL = MOVES.length;
if (TOTAL === 0) {
  console.error("The review fixture must contain a real solved line.");
  process.exit(1);
}

const viewAt = (ply) =>
  viewForState(replayMoves({ deal: DEAL, moves: MOVES.slice(0, ply) }).state);
const ANIMATED_PLY = (() => {
  for (let ply = 1; ply <= TOTAL; ply += 1) {
    const plan = detectCardAnimations(viewAt(ply - 1), viewAt(ply));
    if (plan.reveals.length > 0 || plan.draw || plan.redeal) return ply;
  }
  return null;
})();

// Precompute the real engine output for the mock API payload. This keeps the
// Phase 3 insight assertions deterministic and lets the page exercise the
// cached-analysis path; the worker path is covered by the runner tests.
const ANALYSIS = analyzeSolitaireGame({ deal: DEAL, moves: MOVES });

const REVIEW = {
  gameId: GAME_ID,
  gameKind: "solo",
  mode: "solo",
  variant: DEAL.variant,
  variantVersion: DEAL.variantVersion,
  status: "complete",
  deal: DEAL,
  moves: MOVES,
  seed: 7,
  result: { completed: true, moveCount: TOTAL, elapsedMs: 61_000, seed: 7 },
  startedAt: new Date(Date.now() - 61_000).toISOString(),
  completedAt: new Date().toISOString(),
  durationMs: 61_000,
  analysisEligible: true,
  analysis: ANALYSIS,
  incompleteReason: null,
};

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
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
};

const openReview = async (context) => {
  // The consent banner is site chrome, not part of the review. Suppress it so
  // the screenshots show the board and controls instead of an overlay.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("grynd_cookie_consent", "declined");
    } catch {
      // Storage unavailable: the banner may show, but the review still renders.
    }
  });
  const page = await context.newPage();
  await page.route("**/api/solitaire/review**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: REVIEW }),
    }),
  );
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="review-board"]', { timeout: 60_000 });
  return page;
};

const ply = (page) => page.getAttribute('[data-testid="review-board"]', "data-ply");
const animateAttr = (page) =>
  page.getAttribute('[data-testid="review-board"]', "data-review-animate");
async function anyCardAnimation(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="solitaire-card-"], [data-testid="solitaire-waste-top"]')].some(
      (el) => {
        const inner = el.querySelector(":scope > span");
        return (
          getComputedStyle(el).animationName !== "none" ||
          (inner && getComputedStyle(inner).animationName !== "none")
        );
      },
    ),
  );
}

// ── Desktop ───────────────────────────────────────────────────────────────
const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const desktop = await openReview(desktopContext);
const desktopErrors = watchErrors(desktop);
const mutationRequests = [];
desktop.on("request", (request) => {
  const url = new URL(request.url());
  if (
    url.pathname.startsWith("/api/solitaire") &&
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
  ) {
    mutationRequests.push(`${request.method()} ${url.pathname}`);
  }
});

check("initial position is the deal", (await ply(desktop)) === "0");
check(
  "initial board is the read-only review board",
  (await desktop.textContent('[data-testid="review-board"]')).includes("Review mode"),
);
check("the timeline is present", (await desktop.locator('[data-testid="review-timeline"]').count()) === 1);
check("the timeline lists every move", (await desktop.locator('[data-testid^="review-move-"]').count()) === TOTAL);
check(
  "the summary uses conservative insight labels, not accuracy",
  (await desktop.textContent('[data-testid="review-summary"]')).includes("Move insights") &&
    (await desktop.locator('[data-testid="review-accuracy"]').count()) === 0 &&
    (await desktop.locator('[data-testid="review-blunders"]').count()) === 0,
);
check(
  "routine timeline entries are unannotated",
  (await desktop.locator('[data-testid^="review-move-"][data-rating="unannotated"]').count()) > 0,
);
await desktop.screenshot({ path: join(REPORTS, "review-desktop-initial.png"), fullPage: true });

// One move forward, then back; the board is the authoritative replay each time.
await desktop.click('[data-testid="review-nav-next"]');
await desktop.waitForTimeout(50);
check("next moves exactly one ply", (await ply(desktop)) === "1");
check("the next step opts into animation", (await animateAttr(desktop)) === "true");
await desktop.click('[data-testid="review-nav-prev"]');
await desktop.waitForTimeout(50);
check("previous moves exactly one ply back", (await ply(desktop)) === "0");
check("a rewind does not animate", (await animateAttr(desktop)) === "false");

// Direct timeline selection is an immediate jump, not a replay of the prefix.
await desktop.click('[data-testid="review-move-4"]');
await desktop.waitForTimeout(50);
check("timeline selection lands on the chosen move", (await ply(desktop)) === "5");
check("a timeline jump does not animate", (await animateAttr(desktop)) === "false");

// A refresh re-fetches the same payload and opens the initial deal again; it
// never resumes from a position that is not in the URL.
await desktop.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
await desktop.waitForSelector('[data-testid="review-board"]', { timeout: 60_000 });
check("a refresh rebuilds the review from its stored log", (await ply(desktop)) === "0");

// First / last.
await desktop.click('[data-testid="review-nav-last"]');
await desktop.waitForTimeout(50);
check("jump to the final position", (await ply(desktop)) === String(TOTAL));
await desktop.click('[data-testid="review-nav-first"]');
await desktop.waitForTimeout(50);
check("jump to the beginning", (await ply(desktop)) === "0");

// Rapid interaction uses the functional stepper, so five quick clicks are five plies.
await desktop.evaluate(() => {
  const next = document.querySelector('[data-testid="review-nav-next"]');
  for (let index = 0; index < 5; index += 1) next.click();
});
await desktop.waitForTimeout(60);
check("five rapid next clicks land five moves forward", (await ply(desktop)) === "5");

// Speed changes never reset the position.
await desktop.selectOption('[data-testid="review-playback-speed"]', "2");
check("changing speed keeps the current position", (await ply(desktop)) === "5");
check("2x is selected", (await desktop.inputValue('[data-testid="review-playback-speed"]')) === "2");

// Playback from a known position; 2x steps every 350ms.
await desktop.click('[data-testid="review-autoplay"]');
await desktop.waitForTimeout(500);
await desktop.click('[data-testid="review-autoplay"]');
const afterPlay = Number(await ply(desktop));
check("playback advances the replay", afterPlay > 5, `ply ${afterPlay}`);
const pausedAt = await ply(desktop);
await desktop.waitForTimeout(500);
check("pause stops the replay", (await ply(desktop)) === pausedAt);

// 0.5x is the slowest option and remains selectable.
await desktop.selectOption('[data-testid="review-playback-speed"]', "0.5");
check("0.5x is selected", (await desktop.inputValue('[data-testid="review-playback-speed"]')) === "0.5");
check("0.5x does not move the selected position", (await ply(desktop)) === pausedAt);

// Keyboard navigation.
await desktop.click("body");
await desktop.keyboard.press("Home");
check("Home jumps to the initial deal", (await ply(desktop)) === "0");
await desktop.keyboard.press("ArrowRight");
check("ArrowRight advances one move", (await ply(desktop)) === "1");
await desktop.keyboard.press("End");
check("End jumps to the final position", (await ply(desktop)) === String(TOTAL));

// Restart clears playback and returns to the deal.
await desktop.click('[data-testid="review-restart"]');
await desktop.waitForTimeout(40);
check("restart returns to the deal", (await ply(desktop)) === "0");
check("restart stops playback", (await desktop.getAttribute('[data-testid="review-autoplay"]', "aria-pressed")) === "false");

// A real animated step: navigate to the position before a draw/reveal, then step.
if (ANIMATED_PLY != null) {
  if (ANIMATED_PLY > 1) {
    await desktop.click(`[data-testid="review-move-${ANIMATED_PLY - 2}"]`);
  }
  await desktop.waitForTimeout(30);
  await desktop.click('[data-testid="review-nav-next"]');
  await desktop.waitForTimeout(40);
  check(
    `single step ${ANIMATED_PLY} animates a card change`,
    await anyCardAnimation(desktop),
  );
}

// A direct jump never replays intermediate animations.
if ((await ply(desktop)) !== String(TOTAL)) {
  await desktop.click('[data-testid="review-nav-last"]');
}
await desktop.waitForTimeout(30);
check("final jump shows the final board immediately", (await ply(desktop)) === String(TOTAL));
check("final jump does not animate", (await animateAttr(desktop)) === "false");

// Read-only enforcement at the DOM level.
const enabledBoardButtons = await desktop
  .locator('[data-testid="review-board"] button:not([disabled])')
  .evaluateAll((buttons) =>
    buttons
      .map((button) => ({
        testid: button.getAttribute("data-testid"),
        label: button.getAttribute("aria-label"),
        text: button.textContent?.slice(0, 40),
      }))
      // Appearance is board chrome, not a move control. It is the one thing
      // that deliberately opts back into pointer events inside the inert board.
      .filter((button) => button.testid !== "board-appearance-trigger"),
  );
check(
  "review board exposes no enabled move control",
  enabledBoardButtons.length === 0,
  JSON.stringify(enabledBoardButtons),
);
check("review replay never sends a game mutation", mutationRequests.length === 0, mutationRequests.join("; "));

// Read-only does not mean chrome is dead: the appearance drawer still opens.
await desktop.click('[data-testid="board-appearance-trigger"]');
check(
  "the appearance drawer stays usable in review",
  await desktop.locator('[data-testid="board-appearance-drawer"]').isVisible(),
);
await desktop.getByRole("button", { name: "Close" }).click();
const pointerEvents = await desktop.$eval('[data-testid="review-board"]', (el) => getComputedStyle(el).pointerEvents);
check("review board is pointer-events-none", pointerEvents === "none");

// Phase 3: a labelled move gets a compact explanation, a routine move does not.
const labelledMove = desktop
  .locator('[data-testid^="review-move-"][data-rating="great"], [data-testid^="review-move-"][data-rating="good"], [data-testid^="review-move-"][data-rating="inaccuracy"], [data-testid^="review-move-"][data-rating="mistake"]')
  .first();
check("the analysis labels at least one meaningful move", (await labelledMove.count()) === 1);
if ((await labelledMove.count()) === 1) {
  await labelledMove.click();
  await desktop.waitForTimeout(40);
  const insightText = (await desktop.textContent('[data-testid="review-insight"]')) || "";
  check("a selected labelled move shows an insight panel", insightText.includes("Move insight"));
  check("the insight explains the move and names an alternative", insightText.includes("Played:") && insightText.includes("Alternative:"));
  const selectedMoveText = (await desktop.textContent('[data-testid="review-current-move"]'))?.trim() || "";
  check("the insight belongs to the selected move", insightText.includes(selectedMoveText));
  check(
    "the insight is explicitly a visible-board heuristic",
    insightText.includes("Visible-board heuristic") && insightText.includes("not a solver proof"),
  );
}
await desktop.locator('[data-testid^="review-move-"][data-rating="unannotated"]').first().click();
await desktop.waitForTimeout(40);
check("an unannotated move shows no insight panel", (await desktop.locator('[data-testid="review-insight"]').count()) === 0);
// Put the board back at the end for the final screenshot and state checks.
if ((await ply(desktop)) !== String(TOTAL)) {
  await desktop.click('[data-testid="review-nav-last"]');
  await desktop.waitForTimeout(30);
}

// Desktop layout: board and timeline are side by side, timeline first in the aside.
const boardBox = await desktop.locator('[data-testid="review-board"]').boundingBox();
const timelineBox = await desktop.locator('[data-testid="review-timeline"]').boundingBox();
check(
  "desktop places the timeline beside the board",
  Boolean(boardBox && timelineBox && timelineBox.x > boardBox.x + boardBox.width),
  JSON.stringify({ boardBox, timelineBox }),
);
check("desktop: no runtime errors", desktopErrors.length === 0, desktopErrors.join("; "));
await desktop.evaluate(() => window.scrollTo(0, 0));
await desktop.screenshot({ path: join(REPORTS, "review-desktop-final.png"), fullPage: true });
await desktopContext.close();

// ── Reduced motion ────────────────────────────────────────────────────────
const reducedContext = await browser.newContext({
  viewport: { width: 1100, height: 900 },
  reducedMotion: "reduce",
});
const reduced = await openReview(reducedContext);
const reducedErrors = watchErrors(reduced);
await reduced.click('[data-testid="review-nav-next"]');
await reduced.waitForTimeout(40);
check("reduced motion still advances the position", (await ply(reduced)) === "1");
check("reduced motion shows the new board without a card animation", !(await anyCardAnimation(reduced)));
check("reduced motion: no runtime errors", reducedErrors.length === 0, reducedErrors.join("; "));
await reducedContext.close();

// ── Mobile ────────────────────────────────────────────────────────────────
const mobileContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const mobile = await openReview(mobileContext);
const mobileErrors = watchErrors(mobile);
const mobileBoard = await mobile.locator('[data-testid="review-board"]').boundingBox();
check(
  "mobile board fits the viewport",
  Boolean(mobileBoard && mobileBoard.width <= 390 && mobileBoard.width > 300),
  JSON.stringify(mobileBoard),
);
const mobileTimeline = await mobile.locator('[data-testid="review-timeline"]').boundingBox();
const mobileSummary = await mobile.locator('[data-testid="review-summary"]').boundingBox();
check(
  "mobile timeline comes before the summary",
  Boolean(mobileTimeline && mobileSummary && mobileTimeline.y < mobileSummary.y),
  JSON.stringify({ mobileTimeline, mobileSummary }),
);
check(
  "mobile keeps restart and speed controls on screen",
  (await mobile.locator('[data-testid="review-restart"]').isVisible()) &&
    (await mobile.locator('[data-testid="review-playback-speed"]').isVisible()),
);
await mobile.screenshot({ path: join(REPORTS, "review-mobile-initial.png"), fullPage: true });
const mobileLabelled = mobile
  .locator('[data-testid^="review-move-"][data-rating="great"], [data-testid^="review-move-"][data-rating="good"], [data-testid^="review-move-"][data-rating="inaccuracy"], [data-testid^="review-move-"][data-rating="mistake"]')
  .first();
if ((await mobileLabelled.count()) === 1) {
  await mobileLabelled.click();
  await mobile.waitForTimeout(40);
  const mobileInsight = await mobile.locator('[data-testid="review-insight"]').boundingBox();
  check(
    "mobile insight panel fits the viewport",
    Boolean(mobileInsight && mobileInsight.x >= 0 && mobileInsight.x + mobileInsight.width <= 390),
    JSON.stringify(mobileInsight),
  );
  check(
    "mobile insight keeps the heuristic disclaimer visible",
    (await mobile.textContent('[data-testid="review-insight"]')).includes("not a solver proof"),
  );
  await mobile.screenshot({ path: join(REPORTS, "review-mobile-insight.png"), fullPage: true });
}
await mobile.click('[data-testid="review-move-8"]');
await mobile.waitForTimeout(60);
check("mobile timeline selection works", (await ply(mobile)) === "9");
check(
  "mobile has no horizontal overflow",
  await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
);
await mobile.screenshot({ path: join(REPORTS, "review-mobile-selected.png"), fullPage: true });
check("mobile: no runtime errors", mobileErrors.length === 0, mobileErrors.join("; "));
await mobileContext.close();

// ── Missing history ───────────────────────────────────────────────────────
// An older game can come back without a replayable log. It must explain that,
// not render a half-built board.
const missingContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await missingContext.addInitScript(() => {
  try {
    window.localStorage.setItem("grynd_cookie_consent", "declined");
  } catch {
    // No storage: the banner may appear, but the unavailable state still does.
  }
});
const missing = await missingContext.newPage();
await missing.route("**/api/solitaire/review**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, data: { ...REVIEW, moves: null } }),
  }),
);
await missing.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
await missing.waitForSelector('[data-testid="review-error"]', { timeout: 60_000 });
const missingText = (await missing.textContent('[data-testid="review-error"]')) || "";
check(
  "missing move history shows an understandable unavailable state",
  missingText.includes("Review unavailable") && missingText.includes("incomplete"),
  missingText,
);
check(
  "missing history never renders a board",
  (await missing.locator('[data-testid="review-board"]').count()) === 0,
);
await missingContext.close();

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
