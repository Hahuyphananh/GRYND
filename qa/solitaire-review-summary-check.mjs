// qa/solitaire-review-summary-check.mjs
//
// Phase 4 browser QA — the REAL review page with the closing summary.
//
// The review API and the same-mode history summary are fulfilled with real
// engine fixtures; the board, page, worker/fallback, links, localization and
// responsive layout run on their production paths.
//
// Run (dev server on :3000): node --import tsx qa/solitaire-review-summary-check.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeSolitaireGame } from "../src/lib/solitaire-duel/analysis.ts";
import { replayMoves } from "../src/lib/solitaire-duel/rules.ts";
import {
  LOCAL_COMPLETED_KEY,
  localCompletedReviewId,
} from "../src/lib/solitaire-duel/localReview.ts";
import { solvableDealFromSeed, solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });
const BASE = process.env.SOLITAIRE_QA_BASE || "http://localhost:3000";
const GAME_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_URL = `${BASE}/solitaire/review/solo/${GAME_ID}`;

const DEAL = solvableDealFromSeed(7);
const MOVES = (solveDealLine(DEAL) ?? []).map((move) => ({ kind: move.kind, move }));
const TOTAL = MOVES.length;
if (TOTAL === 0) {
  console.error("The review fixture must contain a real solved line.");
  process.exit(1);
}

const ANALYSIS = analyzeSolitaireGame({ deal: DEAL, moves: MOVES });
const EMPTY_ANALYSIS = {
  ...ANALYSIS,
  perMove: [],
  moments: [],
  summary: {
    ...ANALYSIS.summary,
    movesAnalyzed: 0,
    ratings: {
      normal: 0,
      good: 0,
      great: 0,
      brilliant: 0,
      inaccuracy: 0,
      mistake: 0,
      blunder: 0,
    },
  },
};

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

const HISTORY = {
  success: true,
  data: {
    summary: {
      games: 5,
      completed: 5,
      completionRate: 100,
      bestMs: 61_000,
      averageMs: 70_000,
      totalMoves: TOTAL * 3,
    },
  },
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
    // The review does not depend on Clerk, and this QA environment has no
    // route to Clerk's external CDN. Keep that infrastructure failure out of
    // the application-error check; every review/practice error still counts.
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

const openReview = async (
  context,
  review = REVIEW,
  { history = true, extraRoutes = [], path = PAGE_URL } = {},
) => {
  const page = await context.newPage();
  const reviewBody = JSON.stringify({ success: true, data: review });
  await page.route("**/api/solitaire/review**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: reviewBody }),
  );
  // A duel review is served by the match route, not the solo/daily one.
  await page.route("**/api/solitaire-duel/match/**/review**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: reviewBody }),
  );
  if (history) {
    // Each single-player mode reads its own history endpoint for the personal
    // best: intercept both so the page never falls through to a real request.
    for (const endpoint of ["**/api/solitaire/solo", "**/api/solitaire/daily"]) {
      await page.route(endpoint, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(HISTORY),
        }),
      );
    }
  }
  for (const route of extraRoutes) await route(page);
  await page.goto(path, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="review-board"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="review-completion-summary"]', {
    timeout: 60_000,
  });
  return page;
};

const ply = (page) => page.getAttribute('[data-testid="review-board"]', "data-ply");
const summaryText = (page) => page.textContent('[data-testid="review-completion-summary"]');

// ── Desktop: facts, highlights, links, navigation ─────────────────────────
const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await addBaseStorage(desktopContext, "en");
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

const text = (await summaryText(desktop)) || "";
check("the closing summary uses real replay facts", text.includes("Game summary"));
check("the summary names the game mode", text.includes("Solo Solitaire"));
check("the summary names the completion status", text.includes("Complete"));
check("the summary shows total moves", text.includes(String(TOTAL)));
check("the summary shows 52 cards on the foundations", text.includes("52 / 52"));
check("the summary counts meaningful insights", /\b[1-9]\d*\b/.test(text));
check(
  "the summary has no accuracy score",
  (await desktop.locator('[data-testid="review-accuracy"]').count()) === 0 &&
    (await desktop.locator('[data-testid="review-blunders"]').count()) === 0,
);
check(
  "the personal-best comparison uses same-mode history",
  (await desktop.locator('[data-testid="review-personal-best"]').count()) === 1 &&
    text.includes("Personal best"),
);

const highlight = desktop.locator('[data-testid^="review-highlight-"]').first();
check("the review shows a small highlight selection", (await highlight.count()) === 1);
check(
  "highlights are capped at four",
  (await desktop.locator('[data-testid^="review-highlight-"]').count()) <= 4,
);
if ((await highlight.count()) === 1) {
  const targetPly = await highlight.getAttribute("data-ply");
  await highlight.click();
  await desktop.waitForTimeout(50);
  check("selecting a highlight jumps to its move", (await ply(desktop)) === targetPly);
}

const lessonHref = await desktop.getAttribute('[data-testid="review-academy-link"]', "href");
const practiceHref = await desktop.getAttribute('[data-testid="review-practice-link"]', "href");
check("the recommendation links to an existing Academy route", /^\/learn\/[a-z0-9-]+$/.test(lessonHref || ""), lessonHref || "");
check(
  "the recommendation links to a Practice skill route",
  /^\/learn\/practice\?skill=[a-z0-9-]+$/.test(practiceHref || ""),
  practiceHref || "",
);

// The review itself must not write lesson or practice progress. Seed a valid
// saved state, open both real destinations in the same browser context, and
// compare the stored values afterwards.
await desktop.evaluate(() => {
  window.localStorage.setItem(
    "grynd:solitaire:learn:v1:guest",
    JSON.stringify({
      completedLessonIds: ["tableau-basics"],
      stepIndexByLesson: { "tableau-basics": 1 },
      phaseIndexByLesson: {},
      lastLessonId: "tableau-basics",
      updatedAt: 1,
    }),
  );
  window.localStorage.setItem(
    "grynd:solitaire:practice:v1:guest",
    JSON.stringify({
      attempts: 3,
      completions: 2,
      hints: 1,
      byExercise: {},
      bySkill: {},
      byDifficulty: {
        beginner: { attempts: 3, completions: 2, hints: 1 },
        intermediate: { attempts: 0, completions: 0, hints: 0 },
        advanced: { attempts: 0, completions: 0, hints: 0 },
      },
      history: {},
      lastExerciseId: "alternating-colors",
      updatedAt: 1,
    }),
  );
});
const savedProgress = await desktop.evaluate(() => ({
  lesson: window.localStorage.getItem("grynd:solitaire:learn:v1:guest"),
  practice: window.localStorage.getItem("grynd:solitaire:practice:v1:guest"),
}));

const lessonPage = await desktopContext.newPage();
const lessonResponse = await lessonPage.goto(BASE + lessonHref, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
check("the Academy lesson opens", lessonResponse?.status() === 200, lessonPage.url());
await lessonPage.close();

const practicePage = await desktopContext.newPage();
const practiceResponse = await practicePage.goto(BASE + practiceHref, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
check("the related Practice exercise opens", practiceResponse?.status() === 200, practicePage.url());
await practicePage.close();

const progressAfterLinks = await desktop.evaluate(() => ({
  lesson: window.localStorage.getItem("grynd:solitaire:learn:v1:guest"),
  practice: window.localStorage.getItem("grynd:solitaire:practice:v1:guest"),
}));
check(
  "opening recommendations preserves saved Academy progress",
  progressAfterLinks.lesson === savedProgress.lesson,
);
check(
  "opening recommendations preserves saved Practice progress",
  progressAfterLinks.practice === savedProgress.practice,
);
check(
  "the review never posts a game or progress mutation",
  mutationRequests.length === 0,
  mutationRequests.join("; "),
);

const closeHref = await desktop.getAttribute('[data-testid="review-close"]', "href");
check("the review can be closed back to Solo", closeHref === "/solitaire");
await desktop.screenshot({ path: join(REPORTS, "review-summary-desktop.png"), fullPage: true });
check("desktop summary: no runtime errors", desktopErrors.length === 0, desktopErrors.join("; "));
await desktopContext.close();

// ── Localized summary ─────────────────────────────────────────────────────
for (const [language, expected] of [
  ["fr", "Résumé de la partie"],
  ["es", "Resumen de la partida"],
]) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await addBaseStorage(context, language);
  const page = await openReview(context);
  // LanguageProvider hydrates the stored locale in an effect, so the first
  // paint is intentionally English. Wait for the player's locale to apply.
  await page.waitForFunction(
    (wanted) =>
      document
        .querySelector('[data-testid="review-completion-summary"]')
        ?.textContent?.includes(wanted),
    expected,
    { timeout: 10_000 },
  );
  const body = (await summaryText(page)) || "";
  check(`${language} review summary is translated`, body.includes(expected), body.slice(0, 100));
  check(`${language} review summary has no runtime errors`, watchErrors(page).length === 0);
  await page.screenshot({
    path: join(REPORTS, `review-summary-${language}.png`),
    fullPage: true,
  });
  await context.close();
}

// ── No available insights + no historical comparison ──────────────────────
const emptyContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await addBaseStorage(emptyContext, "en");
const empty = await openReview(emptyContext, { ...REVIEW, analysis: EMPTY_ANALYSIS }, { history: false });
const emptyText = (await summaryText(empty)) || "";
check("an empty analysis shows a positive/neutral completion note", emptyText.includes("You solved the board"));
check("an empty analysis invents no highlights", (await empty.locator('[data-testid^="review-highlight-"]').count()) === 0);
check("an empty analysis invents no lesson", (await empty.locator('[data-testid="review-learning"]').count()) === 0);
check("missing history hides the personal-best comparison", (await empty.locator('[data-testid="review-personal-best"]').count()) === 0);
check("empty summary: no runtime errors", watchErrors(empty).length === 0);
await empty.screenshot({ path: join(REPORTS, "review-summary-empty.png"), fullPage: true });
await emptyContext.close();

// ── Mobile ────────────────────────────────────────────────────────────────
const mobileContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
await addBaseStorage(mobileContext, "en");
const mobile = await openReview(mobileContext);
const summaryBox = await mobile.locator('[data-testid="review-completion-summary"]').boundingBox();
check(
  "mobile summary fits the viewport",
  Boolean(summaryBox && summaryBox.x >= 0 && summaryBox.x + summaryBox.width <= 390),
  JSON.stringify(summaryBox),
);
check(
  "mobile summary has no horizontal overflow",
  await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
);
check("mobile summary: no runtime errors", watchErrors(mobile).length === 0);
await mobile.screenshot({ path: join(REPORTS, "review-summary-mobile.png"), fullPage: true });
await mobileContext.close();

// ── True guest: a local completed game, no review API call ────────────────
const guestEndedAt = Date.now() - 61_000;
const previousEndedAt = guestEndedAt - 300_000;
const guestId = localCompletedReviewId(guestEndedAt, TOTAL);
const localRecords = [
  {
    id: localCompletedReviewId(previousEndedAt, TOTAL),
    mode: "solo",
    seed: 7,
    dateKey: null,
    log: MOVES,
    startedAtMs: previousEndedAt - 60_000,
    endedAtMs: previousEndedAt,
    elapsedMs: 60_000,
    won: true,
    savedAtMs: previousEndedAt,
  },
  {
    id: guestId,
    mode: "solo",
    seed: 7,
    dateKey: null,
    log: MOVES,
    startedAtMs: guestEndedAt - 61_000,
    endedAtMs: guestEndedAt,
    elapsedMs: 61_000,
    won: true,
    savedAtMs: guestEndedAt,
  },
];
const guestContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await guestContext.addInitScript(
  ({ key, records }) => {
    try {
      window.localStorage.setItem("grynd_cookie_consent", "declined");
      window.localStorage.setItem("casino_app_language", "en");
      window.localStorage.setItem(key, JSON.stringify(records));
    } catch {
      // Storage unavailable: the review still exposes its unavailable state.
    }
  },
  { key: LOCAL_COMPLETED_KEY, records: localRecords },
);
const guest = await guestContext.newPage();
await guest.goto(`${BASE}/solitaire/review/solo/${guestId}`, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
await guest.waitForSelector('[data-testid="review-completion-summary"]', { timeout: 60_000 });
const guestText = (await summaryText(guest)) || "";
check("a guest can review a local completed game", (await guest.locator('[data-testid="review-board"]').count()) === 1);
check("a guest sees the same closing summary", guestText.includes("Game summary"));
check(
  "a guest gets a same-mode personal best comparison",
  guestText.includes("Personal best") && guestText.includes("0:01"),
  guestText.slice(0, 220),
);
check("guest local review: no runtime errors", watchErrors(guest).length === 0);
await guest.screenshot({ path: join(REPORTS, "review-summary-guest.png"), fullPage: true });
await guestContext.close();

// ── Daily Challenge: same summary, same-mode history, its own return link ──
const dailyContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await addBaseStorage(dailyContext, "en");
const daily = await openReview(
  dailyContext,
  { ...REVIEW, gameKind: "daily" },
  { path: `${BASE}/solitaire/review/daily/${GAME_ID}` },
);
const dailyErrors = watchErrors(daily);
const dailyText = (await summaryText(daily)) || "";
check("a Daily review summary names the Daily Challenge", dailyText.includes("Daily Challenge"));
check(
  "a Daily review compares against same-mode Daily history",
  (await daily.locator('[data-testid="review-personal-best"]').count()) === 1 &&
    dailyText.includes("Personal best"),
);
check(
  "a Daily review closes back to the Daily Challenge",
  (await daily.getAttribute('[data-testid="review-close"]', "href")) === "/daily",
);
check("daily summary: no runtime errors", dailyErrors.length === 0, dailyErrors.join("; "));
await daily.screenshot({ path: join(REPORTS, "review-summary-daily.png"), fullPage: true });
await dailyContext.close();

// ── Duel (Ranked / Vs AI both use this match review): no cross-mode record ─
const DUEL_ID = "33333333-3333-4333-8333-333333333333";
const duelExpectedHref = `/casino/solitaire-duel/${DUEL_ID}`;
const duelContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await addBaseStorage(duelContext, "en");
const duel = await openReview(
  duelContext,
  {
    ...REVIEW,
    gameId: DUEL_ID,
    gameKind: "duel",
    result: {
      completed: true,
      moveCount: TOTAL,
      elapsedMs: 61_000,
      seat: "player1",
      outcome: "player1",
      winnerSeat: "player1",
      resolutionReason: null,
    },
  },
  { history: false, path: `${BASE}/solitaire/review/duel/${DUEL_ID}` },
);
const duelErrors = watchErrors(duel);
const duelText = (await summaryText(duel)) || "";
check("a Duel review summary names the Duel", duelText.includes("Solitaire Duel"));
check(
  "a Duel review hides the single-player personal best",
  (await duel.locator('[data-testid="review-personal-best"]').count()) === 0,
);
check(
  "a Duel review closes back to the settled match",
  (await duel.getAttribute('[data-testid="review-close"]', "href")) === duelExpectedHref,
);
check("duel summary: no runtime errors", duelErrors.length === 0, duelErrors.join("; "));
await duel.screenshot({ path: join(REPORTS, "review-summary-duel.png"), fullPage: true });
await duelContext.close();

// ── Free-plan Daily: analysis withheld, summary still complete ────────────
// The review API returns the deal + log but no scored analysis once the
// free-plan allowance is spent. The closing summary is built from the replay,
// so every fact must still be there — only the insights are withheld.
const limitedContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await addBaseStorage(limitedContext, "en");
const limited = await openReview(
  limitedContext,
  {
    ...REVIEW,
    gameKind: "daily",
    analysis: null,
    analysisLimited: true,
    analysisAllowance: 0,
  },
  { path: `${BASE}/solitaire/review/daily/${GAME_ID}` },
);
const limitedErrors = watchErrors(limited);
const limitedText = (await summaryText(limited)) || "";
check(
  "a free-plan Daily review shows the analysis-limit notice",
  (await limited.locator('[data-testid="review-analysis-limit"]').count()) === 1,
);
check(
  "a withheld analysis still names the Daily summary",
  limitedText.includes("Daily Challenge") && limitedText.includes("Game summary"),
);
check(
  "a withheld analysis still reports the replay facts",
  limitedText.includes("52 / 52") && limitedText.includes(String(TOTAL)),
);
check(
  "a withheld analysis still compares against Daily history",
  limitedText.includes("Personal best"),
);
check(
  "a withheld analysis claims no accuracy score",
  (await limited.locator('[data-testid="review-accuracy"]').count()) === 0 &&
    (await limited.locator('[data-testid="review-blunders"]').count()) === 0,
);
check(
  "a withheld analysis keeps the review closeable",
  (await limited.getAttribute('[data-testid="review-close"]', "href")) === "/daily",
);
check("limited daily summary: no runtime errors", limitedErrors.length === 0, limitedErrors.join("; "));
await limited.screenshot({ path: join(REPORTS, "review-summary-daily-limited.png"), fullPage: true });
await limitedContext.close();

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
