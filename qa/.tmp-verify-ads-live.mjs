// Temporary live-browser verification for ad surfaces (deleted after the run).
// node --import tsx qa/.tmp-verify-ads-live.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";

const BASE = process.env.BASE_URL || "https://www.grynd.dedyn.io";
const SESSION_KEY = "grynd.solitaire.session.v1";
const REPORTS = "qa/reports";
mkdirSync(REPORTS, { recursive: true });

const rows = [];
const check = (label, ok, detail = "") => {
  rows.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const AD_HOST = /(acscdn\.com|adcash\.com|aclib|youradexchange\.com|rude-movie\.com|magsrv\.com|juvenilechoice\.com)/i;
const VAST_HOST = /(rude-movie\.com|youradexchange\.com)/i;

const deal = dealFromSeed(1);
const line = solveDealLine(deal);
if (!line?.length) throw new Error("seed 1 must be solvable");
const session = {
  mode: "solo",
  seed: 1,
  dateKey: null,
  log: line.map((move) => ({ kind: move.kind, move })),
  startedAtMs: Date.now() - 90_000,
  endedAtMs: null,
  won: false,
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  // ── 1. Banner on a browsing page, anonymous, consent accepted ────────────
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      window.localStorage.setItem("grynd_cookie_consent", "accepted");
    });
    const page = await context.newPage();
    const adRequests = [];
    const consoleLines = [];
    page.on("request", (r) => {
      if (AD_HOST.test(r.url())) adRequests.push(r.url());
    });
    page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 200)));
    page.on("response", (r) => {
      if (AD_HOST.test(r.url())) adRequests.push(`RESP ${r.status()} ${r.url()}`);
    });

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(12_000);

    const bannerState = await page.evaluate(() => {
      const iframes = [...document.querySelectorAll("iframe")].map((f) => ({
        src: f.getAttribute("src") || "",
        id: f.id,
      }));
      const adContainers = [...document.querySelectorAll("[id],[class],[data-ad-slot],ins")]
        .filter((el) => /adcash|aclib|ad-slot|adsbygoogle/i.test(
          `${el.id} ${el.className} ${el.getAttribute("data-ad-slot") || ""}`,
        ))
        .slice(0, 12)
        .map((el) => `${el.tagName}#${el.id}.${String(el.className).slice(0, 60)}`);
      return {
        aclib: typeof window.aclib,
        iframes,
        adContainers,
        consent: window.localStorage.getItem("grynd_cookie_consent"),
        bannerVisible: Boolean(document.querySelector('[role="region"][aria-label*="cookie" i]')),
      };
    });
    await page.screenshot({ path: `${REPORTS}/verify-ads-banner.png`, fullPage: false });

    const acscdn = adRequests.filter((u) => /acscdn\.com/.test(u));
    check("banner: consent record is accepted in the browser", bannerState.consent === "accepted");
    check("banner: Adcash library was requested", acscdn.some((u) => /aclib\.js/.test(u)), acscdn.slice(0, 3).join(" | "));
    check(
      "banner: an Adcash creative/zone request or frame exists",
      adRequests.some((u) => /(aclib\.display|zoneId|adcash\.com\/(?!$)|youradexchange)/i.test(u)) ||
        bannerState.iframes.some((f) => /adcash|acscdn|youradexchange/.test(f.src)) ||
        bannerState.adContainers.length > 0,
      `aclib=${bannerState.aclib} frames=${bannerState.iframes.length} containers=${bannerState.adContainers.length}`,
    );
    console.log("  ad requests:", adRequests.slice(0, 10));
    console.log("  containers:", bannerState.adContainers.slice(0, 6));
    console.log("  console:", consoleLines.filter((l) => /ad|aclib|CSP|Content Security/i.test(l)).slice(0, 8));
    await context.close();
  }

  // ── 2. Post-match surface on a real finished run, real server answer ─────
  const runSolved = async (page, { proSimulated }) => {
    await page.route("**/api/ads/post-match", async (route) => {
      if (proSimulated) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ enabled: true, adFree: true }),
        });
      }
      return route.continue();
    });
    const surface = [];
    page.on("response", async (r) => {
      if (r.url().includes("/api/ads/post-match")) {
        surface.push({ status: r.status(), body: await r.text().catch(() => "") });
      }
    });
    const vast = [];
    page.on("request", (r) => {
      if (VAST_HOST.test(r.url())) vast.push(r.url());
    });

    await page.goto(`${BASE}/solitaire`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const resume = page.getByRole("button", { name: "Resume" });
    await page.waitForFunction(
      () =>
        Boolean(document.querySelector('[data-testid="solitaire-board"]')) ||
        [...document.querySelectorAll("button")].some((n) => n.textContent.trim() === "Resume"),
      null,
      { timeout: 60_000 },
    );
    if ((await resume.count()) > 0) await resume.first().click().catch(() => {});
    await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 60_000 });
    const panel = page.getByRole("dialog", { name: "Game complete" });
    await panel.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    const ended = /cleared the board|Personal best|Solved|Game complete/i.test(
      await page.locator("body").innerText(),
    );
    await page.waitForTimeout(12_000);
    const overlay = await page.evaluate(() => ({
      videos: [...document.querySelectorAll("video")].map((v) => ({
        src: v.currentSrc || v.src,
        paused: v.paused,
        duration: v.duration,
      })),
      adFrames: [...document.querySelectorAll("iframe")].map((f) => f.src).filter(Boolean).slice(0, 6),
      skip: /skip|advertisement|sponsored/i.test(document.body.innerText),
    }));
    return { ended, surface, vast, overlay };
  };

  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem("grynd_cookie_consent", "accepted");
        window.localStorage.setItem(key, value);
      },
      [SESSION_KEY, JSON.stringify(session)],
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    const result = await runSolved(page, { proSimulated: false });
    await page.screenshot({ path: `${REPORTS}/verify-ads-postmatch.png`, fullPage: false });
    check("post-match: the solo run reached its result panel", result.ended);
    console.log("  surface:", JSON.stringify(result.surface));
    console.log("  vast requests:", result.vast.slice(0, 5));
    console.log("  overlay:", JSON.stringify(result.overlay));
    console.log("  page errors:", errors.slice(0, 4));
    check(
      "post-match: the server answered the real surface request",
      result.surface.length > 0,
      JSON.stringify(result.surface[0] || null),
    );
    check(
      "post-match: a VAST tag was requested after the result",
      result.vast.length > 0,
      result.vast[0]?.slice(0, 70) || "none",
    );
    check(
      "post-match: a video creative actually rendered",
      result.overlay.videos.some((v) => v.src && !v.paused),
      JSON.stringify(result.overlay.videos),
    );
    await context.close();
  }

  // ── 3. A member answer (adFree: true) must produce nothing ───────────────
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem("grynd_cookie_consent", "accepted");
        window.localStorage.setItem(key, value);
      },
      [SESSION_KEY, JSON.stringify(session)],
    );
    const page = await context.newPage();
    const result = await runSolved(page, { proSimulated: true });
    await page.screenshot({ path: `${REPORTS}/verify-ads-pro.png`, fullPage: false });
    check("PRO (adFree answer): the result panel still rendered", result.ended);
    check(
      "PRO (adFree answer): no VAST tag request left the browser",
      result.vast.length === 0,
      result.vast.join(" | "),
    );
    check(
      "PRO (adFree answer): no video overlay rendered",
      result.overlay.videos.length === 0,
      JSON.stringify(result.overlay.videos),
    );
    await context.close();
  }
} finally {
  await browser.close();
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} live ad checks passed`);
if (failed.length) console.log("Failures:", failed.map((r) => r.label).join(", "));
