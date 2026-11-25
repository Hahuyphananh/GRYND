// qa/solitaire-review-practice-check.mjs
//
// PHASE 3 browser QA — Game Review → targeted Practice → back to the move.
//
// The review API is fulfilled with a real engine fixture (a genuine
// foundation-timing Inaccuracy). Everything after that runs on production
// paths: the review panel, the Practice deep link, the auto-started validated
// drill, the real rules engine, hints, completion, local progress and the
// return to `?ply=2`.
//
// Checks: CTA gating and mapping, auto-start, review-origin progress,
// completion, exact return context, no competitive writes, mobile and French.
// Screenshots land in qa/reports/.
//
// Run (dev server on :3000): node --import tsx qa/solitaire-review-practice-check.mjs

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
  { kind: "waste-to-tableau", move: { kind: "waste-to-tableau", toColumn: 1 } },
];
const ANALYSIS = analyzeSolitaireGame({ deal: DEAL, moves: MOVES });
if (!ANALYSIS.perMove[1].recommendation) {
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

const openReview = async (
  context,
  { language = "en", viewport = { width: 1440, height: 1000 } } = {},
) => {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
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
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="review-board"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="review-move-1"]', { timeout: 60_000 });
  return { page, writes };
};

const selectMoveTwo = async (page) => {
  await page.click('[data-testid="review-move-1"]');
  await page.waitForSelector('[data-testid="review-recommendation"]', { timeout: 10_000 });
  await page.waitForSelector('[data-testid="review-practice-situation"]', { timeout: 10_000 });
};

// ── Desktop: mapping, auto-start, completion, progress, exact return ──────
const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const desktop = await openReview(desktopContext);
const page = desktop.page;
const errors = watchErrors(page);

await selectMoveTwo(page);

const cta = await page.$('[data-testid="review-practice-situation"]');
check("recommendation exposes the practice CTA", Boolean(cta));
check(
  "foundation timing maps to the foundation drill",
  (await cta?.getAttribute("data-skill")) === "foundation-timing" &&
    (await cta?.getAttribute("data-exercise")) === "foundation-timing",
);
check(
  "the connected lesson is a real catalog id",
  (await cta?.getAttribute("data-lesson")) === "foundation-timing",
);
const href = await cta?.getAttribute("href");
const link = new URL(href, BASE);
check(
  "the link carries skill, difficulty, auto-start and the exact review origin",
  link.searchParams.get("skill") === "foundation-timing" &&
    link.searchParams.get("auto") === "1" &&
    link.searchParams.get("from") === `/solitaire/review/solo/${GAME_ID}?ply=2`,
);

await page.locator('[data-testid="review-practice-situation"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: join(REPORTS, "review-practice-cta-desktop.png") });
await page.click('[data-testid="review-practice-situation"]');
await page.waitForURL(/\/learn\/practice\?/, { timeout: 30_000 });
await page.waitForSelector('[data-testid="practice-review-context"]', { timeout: 30_000 });
await page.waitForSelector('[data-testid="practice-hint"]', { timeout: 30_000 });

check("Practice opens the validated drill automatically", true);
check(
  "the setup chooser is skipped for the deep link",
  (await page.locator('[data-testid="practice-setup"]').count()) === 0,
);
const banner = await page.textContent('[data-testid="practice-review-context"]');
check("the review origin is explained", /From your Game Review/i.test(banner ?? ""));
const why = await page.textContent('[data-testid="practice-review-why"]');
check("the drill explains the strategic idea before any hint", (why ?? "").trim().length > 0);
const backHref = await page.getAttribute('[data-testid="practice-back-to-review"]', "href");
check(
  "the back link keeps the reviewed ply",
  backHref === `/solitaire/review/solo/${GAME_ID}?ply=2`,
);
await page.screenshot({ path: join(REPORTS, "review-practice-active-desktop.png") });

// Two checked moves complete the foundation-timing drill: hint → proven move.
await page.click('[data-testid="practice-hint"]');
await page.waitForSelector('[data-testid="practice-checked-move"]', { timeout: 10_000 });
await page.click('[data-testid="practice-checked-move"]');
await page.click('[data-testid="practice-hint"]');
await page.waitForSelector('[data-testid="practice-checked-move"]', { timeout: 10_000 });
await page.click('[data-testid="practice-checked-move"]');
await page.waitForSelector('[data-testid="practice-complete"]', { timeout: 15_000 });
await page.screenshot({ path: join(REPORTS, "review-practice-complete-desktop.png") });

const stored = await page.evaluate(() => {
  const raw = window.localStorage.getItem("grynd:solitaire:practice:v1:guest");
  return raw ? JSON.parse(raw) : null;
});
check(
  "the attempt is recorded as review-origin practice",
  stored?.bySource?.review?.attempts === 1 &&
    stored?.bySource?.review?.completions === 1,
  JSON.stringify(stored?.bySource ?? null),
);
check(
  "the same attempt remains in the ordinary practice totals",
  stored?.attempts === 1 && stored?.completions === 1,
);
const competitiveKeys = await page.evaluate(() =>
  Object.keys(window.localStorage).filter(
    (key) => /solitaire/i.test(key) && /(trophy|elo|ranked|leaderboard)/i.test(key),
  ),
);
check("no competitive record is created", competitiveKeys.length === 0, competitiveKeys.join(","));

await page.click('[data-testid="practice-back-to-review-complete"]');
await page.waitForURL(new RegExp(`/solitaire/review/solo/${GAME_ID}\\?ply=2`), {
  timeout: 30_000,
});
await page.waitForSelector('[data-testid="review-board"]', { timeout: 30_000 });
await page.waitForSelector('[data-testid="review-recommendation"]', { timeout: 30_000 });
check(
  "returning selects the reviewed move again",
  (await page.getAttribute('[data-testid="review-move-1"]', "aria-current")) === "step",
);
check("the return request was a read, not a write", desktop.writes.length === 0, desktop.writes.join(","));
check("no page errors", errors.length === 0, errors.join(" | "));
await page.screenshot({ path: join(REPORTS, "review-practice-return-desktop.png") });

// ── Mobile: same path at 390 px ───────────────────────────────────────────
const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mobile = await openReview(mobileContext, { viewport: { width: 390, height: 844 } });
await selectMoveTwo(mobile.page);
await mobile.page.screenshot({ path: join(REPORTS, "review-practice-cta-mobile.png") });
await mobile.page.click('[data-testid="review-practice-situation"]');
await mobile.page.waitForSelector('[data-testid="practice-review-context"]', { timeout: 30_000 });
await mobile.page.waitForSelector('[data-testid="practice-hint"]', { timeout: 30_000 });
check("mobile auto-starts the same drill", true);
await mobile.page.screenshot({ path: join(REPORTS, "review-practice-active-mobile.png") });

// ── French: CTA and origin banner ─────────────────────────────────────────
const frenchContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const french = await openReview(frenchContext, { language: "fr" });
await selectMoveTwo(french.page);
const frenchCta = await french.page.textContent('[data-testid="review-practice-situation"]');
check("the French CTA is translated", /entraîner sur cette situation/i.test(frenchCta ?? ""));
await french.page.click('[data-testid="review-practice-situation"]');
await french.page.waitForSelector('[data-testid="practice-review-context"]', { timeout: 30_000 });
const frenchBanner = await french.page.textContent('[data-testid="practice-review-context"]');
check("the French origin banner is translated", /Depuis ta revue/i.test(frenchBanner ?? ""));
await french.page.screenshot({ path: join(REPORTS, "review-practice-fr.png") });

await browser.close();
console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail === 0 ? 0 : 1);
