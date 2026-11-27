import { chromium } from "playwright";
import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";
const BASE = "https://www.grynd.dedyn.io";
const SESSION_KEY = "grynd.solitaire.session.v1";
const line = solveDealLine(dealFromSeed(1));
const session = { mode: "solo", seed: 1, dateKey: null, log: line.map((m) => ({ kind: m.kind, move: m })), startedAtMs: Date.now() - 90_000, endedAtMs: null, won: false };
const browser = await chromium.launch({ channel: "chrome", headless: true });
const out = {};
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(() => localStorage.setItem("grynd_cookie_consent", "accepted"));
  const page = await ctx.newPage();
  const hits = [];
  page.on("request", (r) => { if (/acscdn|adcash|rapidadexchange|crcdn|usrpubtrck|youradexchange|vidwestxyz/.test(r.url())) hits.push(r.url().slice(0, 60)); });
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(12000);
  out.banner = await page.evaluate(() => ({
    slot: Boolean(document.querySelector("[data-banner-placement]")),
    adMarker: Boolean(document.querySelector("[data-grynd-ad]")),
    imgs: [...document.querySelectorAll("img")].filter((i) => /crcdn/.test(i.currentSrc || i.src)).length,
  }));
  out.bannerHits = hits;
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(([k, v]) => { localStorage.setItem("grynd_cookie_consent", "accepted"); localStorage.setItem(k, v); }, [SESSION_KEY, JSON.stringify(session)]);
  const page = await ctx.newPage();
  const vast = [];
  page.on("request", (r) => { if (/rude-movie|youradexchange|vidwestxyz/.test(r.url())) vast.push(r.url().slice(0, 60)); });
  await page.goto(`${BASE}/solitaire`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const resume = page.getByRole("button", { name: "Resume" });
  await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="solitaire-board"]')) || [...document.querySelectorAll("button")].some((n) => n.textContent.trim() === "Resume"), null, { timeout: 60000 });
  if (await resume.count()) await resume.first().click().catch(() => {});
  await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 60000 });
  await page.waitForTimeout(14000);
  out.postMatch = await page.evaluate(() => ({ videos: document.querySelectorAll("video").length, adText: /advertisement|skip in/i.test(document.body.innerText) }));
  out.vast = vast;
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 1));
