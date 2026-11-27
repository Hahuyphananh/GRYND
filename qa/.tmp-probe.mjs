import { chromium } from "playwright";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext();
await ctx.addInitScript(() => localStorage.setItem("grynd_cookie_consent", "accepted"));
const page = await ctx.newPage();
const log = [];
page.on("requestfailed", (r) => log.push(`FAILED ${r.failure()?.errorText} ${r.url().slice(0,90)}`));
page.on("request", (r) => { if (/acscdn|adcash/.test(r.url())) log.push(`REQ ${r.url().slice(0,90)}`); });
page.on("response", (r) => { if (/acscdn|adcash/.test(r.url())) log.push(`RESP ${r.status()} ${r.url().slice(0,90)}`); });
page.on("console", (m) => { if (/csp|refused|aclib|adcash/i.test(m.text())) log.push(`CONSOLE ${m.type()} ${m.text().slice(0,180)}`); });
await page.goto("https://www.grynd.dedyn.io/", { waitUntil: "domcontentloaded", timeout: 60000 });
for (const ms of [3000, 5000, 8000]) {
  await page.waitForTimeout(ms);
  const state = await page.evaluate(() => ({
    aclib: typeof window.aclib,
    keys: Object.keys(window).filter((k) => /aclib|adcash/i.test(k)),
    script: document.querySelector("script[data-grynd-adcash-library]")?.outerHTML.slice(0, 160) || null,
    aside: document.querySelector("aside[data-adcash-placement]")?.outerHTML.slice(0, 220) || null,
    container: document.querySelector('[id^="grynd-adcash-banner"]')?.getAttribute("data-grynd-adcash") || null,
  }));
  log.push(`STATE +${ms} ${JSON.stringify(state)}`);
}
console.log(log.join("\n"));
await browser.close();
