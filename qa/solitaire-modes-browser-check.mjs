// qa/solitaire-modes-browser-check.mjs
//
// Real-browser check for the new single-player modes (desktop + mobile).
//
// Run against a built server:
//   npx next start -p 3100
//   node qa/solitaire-modes-browser-check.mjs
//
// It exercises the actual UX, not source contracts:
//   * the homepage advertises ranked, solo, practice and the daily challenge;
//   * /solitaire deals immediately, the stock draws, the move counter advances;
//   * a refresh surfaces the resume prompt and resuming restores the move log;
//   * Undo removes a move;
//   * /daily serves the shared deal, starts on demand and the timer advances;
//   * the mobile viewport has no horizontal overflow and keeps controls visible.

import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3100";
const SHOTS = "qa/screenshots";
const results = [];

function check(label, ok, detail = "") {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const stat = (page, name) =>
  page.evaluate((label) => {
    const dt = [...document.querySelectorAll("dt")].find(
      (node) => node.textContent.trim() === label,
    );
    return dt?.nextElementSibling?.textContent.trim() ?? null;
  }, name);

async function dismissOverlays(page) {
  // Consent + the first-visit rules modal are part of the real first load; the
  // visual check dismisses them so the screenshots show the page beneath.
  for (const name of ["GOT IT", "Accept", "Decline"]) {
    const button = page.getByRole("button", { name, exact: true });
    if ((await button.count()) > 0 && (await button.first().isVisible().catch(() => false))) {
      await button.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

async function openSolo(page) {
  await page.goto(`${BASE}/solitaire`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="solitaire-stock"]', { timeout: 45000 });
  await dismissOverlays(page);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await mkdir(SHOTS, { recursive: true });

  // ── Desktop ───────────────────────────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await dismissOverlays(page);
  await page.waitForTimeout(400);
  const homeText = await page.locator("body").innerText();
  check("home lists Ranked PvP", /Ranked PvP/i.test(homeText));
  check("home lists Solo Solitaire", /Solo Solitaire/i.test(homeText));
  check("home lists Practice vs AI", /Practice vs AI/i.test(homeText));
  check("home features Daily Challenge", /Daily Challenge/i.test(homeText));
  check("home links /solitaire", (await page.locator('a[href="/solitaire"]').count()) > 0);
  check("home links /daily", (await page.locator('a[href="/daily"]').count()) > 0);
  check("home links ranked lobby", (await page.locator('a[href="#lobby"]').count()) > 0);
  check("home links practice", (await page.locator('a[href="#practice"]').count()) > 0);
  await page.screenshot({ path: `${SHOTS}/home-desktop.png`, fullPage: true });

  await openSolo(page);
  check("solo deals a board immediately", true);
  const stockStart = await stat(page, "Moves");
  check("solo move counter starts at 0", stockStart === "0", `got ${stockStart}`);

  const stock = page.locator('[data-testid="solitaire-stock"]').first();
  await stock.click();
  await stock.click();
  await stock.click();
  await page.waitForTimeout(300);
  const afterDraws = await stat(page, "Moves");
  check("solo stock draws advance the move counter", afterDraws === "3", `got ${afterDraws}`);
  await page.screenshot({ path: `${SHOTS}/solo-desktop.png`, fullPage: true });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const refreshed = await page.locator("body").innerText();
  check("refresh offers to resume the unfinished game", /unfinished game/i.test(refreshed));
  const resume = page.getByRole("button", { name: "Resume" });
  if (await resume.count()) {
    await resume.first().click();
    await page.waitForTimeout(400);
    const resumed = await stat(page, "Moves");
    check("resume restores the persisted move log", resumed === "3", `got ${resumed}`);
  } else {
    check("resume restores the persisted move log", false, "no Resume button");
  }

  const undo = page.getByRole("button", { name: "Undo" });
  if (await undo.count()) {
    await undo.first().click();
    await page.waitForTimeout(300);
    const undone = await stat(page, "Moves");
    check("undo removes one move", undone === "2", `got ${undone}`);
  } else {
    check("undo removes one move", false, "no Undo button");
  }
  check("no uncaught page errors on /solitaire", errors.length === 0, errors.join(" | "));

  // ── Daily ─────────────────────────────────────────────────────────────────
  const dailyPage = await desktop.newPage();
  await dailyPage.goto(`${BASE}/daily`, { waitUntil: "domcontentloaded" });
  await dismissOverlays(dailyPage);
  await dailyPage
    .waitForFunction(
      () =>
        /Start challenge|Replay as practice|could not be loaded/i.test(document.body.innerText),
      null,
      { timeout: 60000 },
    )
    .catch(() => {});
  const dailyText = await dailyPage.locator("body").innerText();
  const dealLoaded = /Start challenge|Replay as practice/i.test(dailyText);
  check("daily serves the server-derived deal", dealLoaded, dealLoaded ? "" : dailyText.slice(0, 200));
  if (dealLoaded) {
    await dailyPage.screenshot({ path: `${SHOTS}/daily-desktop.png`, fullPage: true });
    const start = dailyPage.getByRole("button", { name: /Start challenge|Replay as practice/ }).first();
    await start.click();
    await dailyPage.waitForSelector('[data-testid="solitaire-stock"]', { timeout: 30000 });
    await dailyPage.locator('[data-testid="solitaire-stock"]').first().click();
    await dailyPage.waitForTimeout(1400);
    const timer = await stat(dailyPage, "Time");
    check("daily timer advances after the challenge starts", timer !== null && timer !== "0:00", `got ${timer}`);
    await dailyPage.screenshot({ path: `${SHOTS}/daily-playing-desktop.png`, fullPage: true });
  }

  // ── Mobile ────────────────────────────────────────────────────────────────
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  await openSolo(mobilePage);
  // Consent mounts a beat after hydration; dismiss it before the capture.
  await mobilePage.waitForTimeout(1600);
  await dismissOverlays(mobilePage);
  await mobilePage.waitForTimeout(400);
  const stockVisible = await mobilePage
    .locator('[data-testid="solitaire-stock"]')
    .first()
    .isVisible()
    .catch(() => false);
  check("mobile stock is on screen", stockVisible);
  const overflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check("mobile /solitaire has no horizontal overflow", overflow <= 1, `${overflow}px`);
  const newGameVisible = await mobilePage
    .getByRole("button", { name: "New game" })
    .first()
    .isVisible()
    .catch(() => false);
  check("mobile controls are visible", newGameVisible);
  await mobilePage.screenshot({ path: `${SHOTS}/solo-mobile.png`, fullPage: true });

  await mobilePage.goto(`${BASE}/daily`, { waitUntil: "domcontentloaded" });
  await mobilePage.waitForTimeout(2500);
  await dismissOverlays(mobilePage);
  await mobilePage.waitForTimeout(600);
  await dismissOverlays(mobilePage);
  await mobilePage.waitForTimeout(300);
  const mobileDailyOverflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check("mobile /daily has no horizontal overflow", mobileDailyOverflow <= 1, `${mobileDailyOverflow}px`);
  await mobilePage.screenshot({ path: `${SHOTS}/daily-mobile.png`, fullPage: true });

  await desktop.close();
  await mobile.close();
} finally {
  await browser.close();
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (failed.length > 0) {
  console.log("Failures:", failed.map((row) => row.label).join(", "));
  process.exitCode = 1;
}
