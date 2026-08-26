/**
 * Detailed axe-core scan: prints every failing node with its selector and
 * failure summary, for one route.
 *
 *   node scripts/axe-detail.mjs /casino/roulette
 */

import puppeteer from "puppeteer-core";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const BASE = "http://localhost:3000";
const ROUTE = process.argv[2] || "/";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((c) => fs.existsSync(c));
if (!chromePath) throw new Error("Chrome not found. Set CHROME_PATH.");

const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
try {
  const res = await page.goto(`${BASE}${ROUTE}`, {
    waitUntil: "networkidle0",
    timeout: 45000,
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate((src) => {
    const s = document.createElement("script");
    s.textContent = src;
    document.head.appendChild(s);
  }, axeSource);

  const violations = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => ({
        target: n.target.join(" "),
        summary: (n.failureSummary || "").replace(/\s+/g, " ").slice(0, 220),
      })),
    }));
  });

  console.log(`\n=== ${ROUTE} (HTTP ${res.status()}) — ${violations.length} violation rule(s) ===\n`);
  for (const v of violations) {
    console.log(`[${v.impact}] ${v.id} — ${v.help}`);
    for (const n of v.nodes.slice(0, 4)) {
      console.log(`    <${n.target}>`);
      if (n.summary) console.log(`      ${n.summary}`);
    }
    console.log("");
  }
} finally {
  await browser.close();
}
