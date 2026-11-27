import { chromium } from "playwright";
import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";

const BASE = "https://www.grynd.dedyn.io";
const SESSION_KEY = "grynd.solitaire.session.v1";
const line = solveDealLine(dealFromSeed(1));
const session = {
  mode: "solo", seed: 1, dateKey: null,
  log: line.map((move) => ({ kind: move.kind, move })),
  startedAtMs: Date.now() - 90_000, endedAtMs: null, won: false,
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
for (let run = 1; run <= 2; run += 1) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(([k, v]) => {
    localStorage.setItem("grynd_cookie_consent", "accepted");
    localStorage.setItem(k, v);
  }, [SESSION_KEY, JSON.stringify(session)]);
  const page = await ctx.newPage();
  const ext = new Map();
  page.on("request", (r) => {
    try {
      const u = new URL(r.url());
      if (!/grynd\.dedyn\.io$/.test(u.hostname)) ext.set(u.host, (ext.get(u.host) || 0) + 1);
    } catch {}
  });
  const vast = [];
  page.on("response", async (r) => {
    if (/rude-movie\.com|youradexchange\.com/.test(r.url())) {
      vast.push(`${r.status()} ${(await r.body().catch(() => Buffer.alloc(0))).length}b ${r.url().slice(0, 60)}`);
    }
  });
  await page.goto(`${BASE}/solitaire`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const resume = page.getByRole("button", { name: "Resume" });
  await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="solitaire-board"]')) || [...document.querySelectorAll("button")].some((n) => n.textContent.trim() === "Resume"), null, { timeout: 60_000 });
  if (await resume.count()) await resume.first().click().catch(() => {});
  await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 60_000 });
  await page.waitForTimeout(22_000);
  const video = await page.evaluate(() => [...document.querySelectorAll("video")].map((v) => v.currentSrc || v.src));
  console.log(`RUN ${run} external hosts:`, Object.fromEntries(ext));
  console.log(`RUN ${run} vast:`, vast);
  console.log(`RUN ${run} videos:`, video);
  await ctx.close();
}
await browser.close();
