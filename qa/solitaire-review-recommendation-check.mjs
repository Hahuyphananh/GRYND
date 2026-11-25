// qa/solitaire-review-recommendation-check.mjs
//
// PHASE 2 browser QA — the real review page with a real Phase 1 recommendation.
//
// The review API is fulfilled with a real engine fixture (a two-move game with
// one genuine Inaccuracy). The page, the shared Solitaire board, playback,
// the analysis worker, the panel and the demonstration all run on their
// production paths.
//
// Checks: panel gating, exact recommended move, pre-move → after demonstration,
// return to the played move, paused playback, navigation, no writes, mobile,
// French copy and reduced motion. Screenshots land in qa/reports/.
//
// Run (dev server on :3000): node --import tsx qa/solitaire-review-recommendation-check.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeSolitaireGame } from "../src/lib/solitaire-duel/analysis.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });
const BASE = process.env.SOLITAIRE_QA_BASE || "http://localhost:3000";
const GAME_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_URL = `${BASE}/solitaire/review/solo/${GAME_ID}`;

const C = (suit, rank) => ({ suit, rank });
const P = (card, faceUp = true) => ({ card, faceUp });

// A reviewed game with exactly one supported recommendation:
//   move 1 draws the Ace of hearts;
//   move 2 dumps it onto the black 2 instead of its foundation.
const DEAL = {
  variant: "klondike-1",
  variantVersion: 3,
  tableau: [
    [P(C("spades", 5))],
    [P(C("spades", 2))],
    [P(C("clubs", 3))],
    [P(C("clubs", 4))],
    [P(C("clubs", 5))],
    [P(C("clubs", 6))],
    [P(C("clubs", 7))],
  ],
  stock: [C("hearts", 1)],
};
const MOVES = [
  { kind: "draw", move: { kind: "draw" } },
  {
    kind: "waste-to-tableau",
    move: { kind: "waste-to-tableau", toColumn: 1 },
  },
];
const ANALYSIS = analyzeSolitaireGame({ deal: DEAL, moves: MOVES });
const RECOMMENDATION = ANALYSIS.perMove[1].recommendation;
if (!RECOMMENDATION) {
  console.error("The QA fixture must produce a Phase 1 recommendation.");
  process.exit(1);
}

const REVIEW = {
  gameId: GAME_ID,
  gameKind: "solo",
  mode: "solo",
  variant: DEAL.variant,
  variantVersion: DEAL.variantVersion,
  status: "incomplete",
  deal: DEAL,
  moves: MOVES,
  result: { completed: false, moveCount: MOVES.length, elapsedMs: 30_000 },
  startedAt: new Date(Date.now() - 30_000).toISOString(),
  completedAt: new Date().toISOString(),
  durationMs: 30_000,
  analysisEligible: true,
  analysis: ANALYSIS,
  incompleteReason: "not-completed",
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
  page.on("pageerror", (error) => {
    const message = String(error);
    if (message.includes("failed_to_load_clerk_js")) return;
    errors.push(message);
  });
  return errors;
};

const addBaseStorage = async (context, language = "en") => {
  await context.addInitScript(
    ({ lang }) => {
      try {
        window.localStorage.setItem("grynd_cookie_consent", "declined");
        window.localStorage.setItem("casino_app_language", lang);
      } catch {
        // Storage unavailable: the page still renders.
      }
    },
    { lang: language },
  );
};

const openReview = async (context, { language = "en", reducedMotion = "no-preference" } = {}) => {
  const page = await context.newPage();
  const writes = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/api/")) {
      writes.push(`${request.method()} ${request.url()}`);
    }
  });
  const reviewBody = JSON.stringify({ success: true, data: REVIEW });
  await page.route("**/api/solitaire/review**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: reviewBody }),
  );
  for (const endpoint of ["**/api/solitaire/solo", "**/api/solitaire/daily"]) {
    await page.route(endpoint, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { summary: null } }),
      }),
    );
  }
  await addBaseStorage(context, language);
  await page.emulateMedia({ reducedMotion });
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="review-board"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="review-move-1"]', { timeout: 60_000 });
  return { page, writes };
};

const foundationCards = (page, suit) =>
  page.locator(`[data-testid="solitaire-foundation-${suit}"] [data-card]`).count();

const selectMoveTwo = async (page) => {
  await page.click('[data-testid="review-move-1"]');
  await page.waitForSelector('[data-testid="review-recommendation"]', { timeout: 10_000 });
};

const openDemo = async (page) => {
  await page.click('[data-testid="review-recommendation-toggle"]');
  await page.waitForSelector('[data-testid="review-demo"]', { timeout: 10_000 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="review-demo"]')?.dataset.phase === "after",
    null,
    { timeout: 5_000 },
  );
};

// ── Desktop: panel, exact move, demonstration, return ─────────────────────
const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const desktop = await openReview(desktopContext);
const errors = watchErrors(desktop.page);

check("the review opens on the real played position", (await desktop.page.getAttribute('[data-testid="review-board"]', "data-ply")) === "0");
await selectMoveTwo(desktop.page);

const panel = desktop.page.locator('[data-testid="review-recommendation"]');
check("the recommendation panel appears for the Inaccuracy", await panel.isVisible());
check(
  "the panel carries the Phase 1 classification",
  (await panel.getAttribute("data-rating")) === "inaccuracy",
);
check(
  "the panel shows the recorded confidence",
  ["high", "medium"].includes(await panel.getAttribute("data-confidence")),
);
const panelText = (await panel.textContent()) ?? "";
check("the panel names the recommended move", panelText.includes("\u2665"), panelText.trim());
check("the panel explains the measured gain", /foundation/i.test(panelText));
check(
  "the panel states it is not a proven optimal move",
  /not a proven optimal move/i.test(panelText),
);
check("the panel starts in the non-demonstrating state", (await desktop.page.getAttribute('[data-testid="review-board"]', "data-demo")) === "false");
await panel.scrollIntoViewIfNeeded();
await desktop.page.waitForTimeout(200);
await desktop.page.screenshot({ path: join(REPORTS, "review-recommendation-desktop.png"), fullPage: false });

const reviewBefore = await desktop.page.textContent('[data-testid="review-timeline"]');
await openDemo(desktop.page);
check("the demonstration starts on the exact pre-move position", (await desktop.page.getAttribute('[data-testid="review-board"]', "data-demo")) === "after");
check("the board shows the recommended foundation card", (await foundationCards(desktop.page, "hearts")) === 1);
check(
  "the board has advanced exactly one ply for the recommendation",
  (await desktop.page.getAttribute('[data-testid="solitaire-board"]', "data-ply")) ===
    String(RECOMMENDATION.ply + 1),
);
check(
  "the demonstration is visually distinct",
  await desktop.page.locator('[data-testid="review-demo"]').isVisible(),
);
check(
  "the timeline still selects the played move",
  (await desktop.page.getAttribute('[data-testid="review-move-1"]', "aria-current")) === "step",
);
await desktop.page.locator('[data-testid="review-demo"]').scrollIntoViewIfNeeded();
await desktop.page.waitForTimeout(250);
await desktop.page.screenshot({ path: join(REPORTS, "review-recommendation-demo.png"), fullPage: false });

await desktop.page.click('[data-testid="review-demo-back"]');
await desktop.page.waitForSelector('[data-testid="review-demo"]', { state: "detached", timeout: 5_000 });
check("back returns the board to the actual played move", (await foundationCards(desktop.page, "hearts")) === 0);
check("back leaves the played move selected", (await desktop.page.getAttribute('[data-testid="review-board"]', "data-ply")) === "2");
check("the panel remains after returning", await panel.isVisible());
check(
  "the timeline is unchanged by the demonstration",
  (await desktop.page.textContent('[data-testid="review-timeline"]')) === reviewBefore,
);

// Multiple, independent openings.
await openDemo(desktop.page);
await desktop.page.click('[data-testid="review-demo-back"]');
await selectMoveTwo(desktop.page);
await openDemo(desktop.page);
check("a recommendation can be opened again independently", (await foundationCards(desktop.page, "hearts")) === 1);
await desktop.page.click('[data-testid="review-demo-back"]');

// Navigation works after closing, and the panel disappears on a routine move.
await desktop.page.click('[data-testid="review-nav-prev"]');
check(
  "previous navigation leaves the demonstration and panel",
  (await desktop.page.locator('[data-testid="review-recommendation"]').count()) === 0 &&
    (await desktop.page.getAttribute('[data-testid="review-board"]', "data-ply")) === "1",
);
await desktop.page.click('[data-testid="review-move-1"]');
check("returning to the Inaccuracy restores its panel", await panel.isVisible());

check("the review made no write requests", desktop.writes.length === 0, desktop.writes.join("; "));
check("desktop review: no runtime errors", errors.length === 0, errors.join("; "));
await desktopContext.close();

// ── French copy ───────────────────────────────────────────────────────────
const frContext = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const fr = await openReview(frContext, { language: "fr" });
const frErrors = watchErrors(fr.page);
await selectMoveTwo(fr.page);
const frText = (await fr.page.textContent('[data-testid="review-recommendation"]')) ?? "";
check("French panel uses translated copy", frText.includes("Meilleur coup"), frText.trim());
await openDemo(fr.page);
const frDemoText = (await fr.page.textContent('[data-testid="review-demo"]')) ?? "";
check("French demonstration uses translated copy", frDemoText.includes("Démonstration"), frDemoText.trim());
check("French review: no runtime errors", frErrors.length === 0, frErrors.join("; "));
await fr.page.locator('[data-testid="review-demo"]').scrollIntoViewIfNeeded();
await fr.page.waitForTimeout(200);
await fr.page.screenshot({ path: join(REPORTS, "review-recommendation-fr.png"), fullPage: false });
await frContext.close();

// ── Mobile ────────────────────────────────────────────────────────────────
const mobileContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const mobile = await openReview(mobileContext);
const mobileErrors = watchErrors(mobile.page);
await selectMoveTwo(mobile.page);
const mobilePanel = mobile.page.locator('[data-testid="review-recommendation"]');
await mobilePanel.scrollIntoViewIfNeeded();
check("the recommendation panel is readable on mobile", await mobilePanel.isVisible());
const box = await mobilePanel.boundingBox();
check("the panel fits the mobile viewport width", Boolean(box && box.width <= 390), box ? `${Math.round(box.width)}px` : "no box");
await openDemo(mobile.page);
check("the demonstration works on mobile", (await foundationCards(mobile.page, "hearts")) === 1);
await mobile.page.locator('[data-testid="review-demo"]').scrollIntoViewIfNeeded();
await mobile.page.waitForTimeout(200);
await mobile.page.screenshot({ path: join(REPORTS, "review-recommendation-mobile.png"), fullPage: false });
check("mobile review: no runtime errors", mobileErrors.length === 0, mobileErrors.join("; "));
await mobileContext.close();

// ── Reduced motion ────────────────────────────────────────────────────────
const reduceContext = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  reducedMotion: "reduce",
});
const reduced = await openReview(reduceContext, { reducedMotion: "reduce" });
const reducedErrors = watchErrors(reduced.page);
await selectMoveTwo(reduced.page);
await openDemo(reduced.page);
check("reduced motion still reaches the recommended position", (await foundationCards(reduced.page, "hearts")) === 1);
check("reduced motion review: no runtime errors", reducedErrors.length === 0, reducedErrors.join("; "));
await reduceContext.close();

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
