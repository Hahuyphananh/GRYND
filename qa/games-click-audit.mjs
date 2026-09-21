// qa/games-click-audit.mjs
//
// Companion to qa/games-blank-audit.mjs. The direct-load audit navigates to
// each game URL as a fresh page load; this one reproduces the real journey —
// open /casino, CLICK each game card, and see what the client-side navigation
// actually renders. A route can survive a full page load and still come out
// blank through the router (redirect/rewrite handling differs), which is
// exactly the "click a game -> blank page" report.
//
// Usage: BASE=http://localhost:3210 node qa/games-click-audit.mjs

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports", "games-blank-audit");
const BASE = process.env.BASE || "http://localhost:3000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
mkdirSync(REPORTS, { recursive: true });

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

await page.goto(`${BASE}/casino`, { waitUntil: "domcontentloaded" });
await sleep(2500);

// Every game card in the hub, paired with its href so we can click the real
// element the user clicks.
const cards = await page.evaluate(() =>
  Array.from(document.querySelectorAll("a[href]"))
    .map((a) => ({ href: a.getAttribute("href"), text: (a.innerText || "").trim().slice(0, 40) }))
    .filter((l) => /^\/(games|casino)\//.test(l.href) && !l.href.includes("#")),
);

const seen = new Set();
const results = [];

for (const card of cards) {
  if (seen.has(card.href)) continue;
  seen.add(card.href);

  // Always start from the hub so each click is a genuine client-side navigation.
  await page.goto(`${BASE}/casino`, { waitUntil: "domcontentloaded" });
  await sleep(1200);
  pageErrors.length = 0;

  let clicked = null;
  try {
    clicked = await page.evaluate((href) => {
      const el = document.querySelector(`a[href="${href}"]`);
      if (!el) return false;
      el.click();
      return true;
    }, card.href);
    await sleep(3500);
  } catch (err) {
    results.push({ href: card.href, clickError: String(err).slice(0, 160) });
    continue;
  }

  const probe = await page.evaluate(() => {
    const body = document.body;
    const text = (body?.innerText || "").replace(/\s+/g, " ").trim();
    const chrome = "nav, footer, header, script, style, template";
    let nodes = 0;
    for (const el of body.querySelectorAll("*")) {
      if (el.closest(chrome)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      if (hasText) nodes += 1;
    }
    return { textChars: text.length, textNodes: nodes, head: text.slice(0, 120) };
  });

  const row = {
    href: card.href,
    clicked,
    finalUrl: page.url(),
    ...probe,
    pageErrors: [...pageErrors],
    blank: probe.textChars < 120 && probe.textNodes < 8,
  };
  results.push(row);
  console.log(
    `${(row.blank ? "BLANK" : "ok").padEnd(5)} ${card.href.padEnd(28)} -> ${row.finalUrl.replace(BASE, "").padEnd(30)} text:${String(row.textChars).padStart(5)} nodes:${String(row.textNodes).padStart(4)} js:${row.pageErrors.length}`,
  );
  if (row.blank) {
    await page.screenshot({
      path: join(REPORTS, `click-${card.href.replace(/[^a-z0-9]+/gi, "-")}.png`),
    });
    console.log(`        text: ${row.head}`);
  }
}

await browser.close();
writeFileSync(
  join(REPORTS, "click-report.json"),
  JSON.stringify({ base: BASE, generatedAt: new Date().toISOString(), results }, null, 2),
);
const blanks = results.filter((r) => r.blank);
console.log(`\n${results.length} hub links clicked — blank: ${blanks.length}`);
if (blanks.length) console.log(blanks.map((b) => `${b.href} -> ${b.finalUrl}`).join("\n"));
