/**
 * Automated accessibility scan (axe-core) of key GRYND routes.
 *
 * Drives the locally installed Chrome via puppeteer-core, injects axe-core,
 * and reports violations deduplicated by rule + impact, grouped by route.
 *
 *   node scripts/axe-scan.mjs [baseUrl] [route...]
 *
 * Examples:
 *   node scripts/axe-scan.mjs
 *   node scripts/axe-scan.mjs http://localhost:3000 / /casino /contact
 */

import puppeteer from "puppeteer-core";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const BASE = process.argv[2] || "http://localhost:3000";
const ROUTES = process.argv.slice(3).length
  ? process.argv.slice(3)
  : [
      "/",
      "/casino",
      "/games",
      "/classement",
      "/contact",
      "/faq",
      "/terms",
      "/privacy-policy",
      "/fair-play",
      "/security-policy",
      "/accessibility",
      "/casino/roulette",
      "/casino/blackjack",
      "/casino/plinko",
    ];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome not found. Set CHROME_PATH.");
}

const axeSource = fs.readFileSync(
  require.resolve("axe-core/axe.min.js"),
  "utf8",
);

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const summary = {};
const ruleCounts = {};

for (const route of ROUTES) {
  const page = await browser.newPage();
  try {
    const response = await page.goto(`${BASE}${route}`, {
      waitUntil: "networkidle0",
      timeout: 45000,
    });
    await new Promise((r) => setTimeout(r, 1500)); // hydration
    await page.evaluate((src) => {
      const s = document.createElement("script");
      s.textContent = src;
      document.head.appendChild(s);
    }, axeSource);

    const results = await page.evaluate(async () => {
      const r = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
      });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5),
      }));
    });

    const byImpact = { serious: 0, critical: 0, moderate: 0, minor: 0 };
    for (const v of results) {
      const key = v.impact || "minor";
      byImpact[key] = (byImpact[key] || 0) + 1;
      ruleCounts[v.id] = (ruleCounts[v.id] || 0) + 1;
      // Surface the offending element for serious/critical findings.
      if (key === "serious" || key === "critical") {
        console.log(`    ${v.id}: ${v.nodes[0]?.target?.join(" ") || v.nodes[0]?.html?.slice(0, 80)}`);
      }
    }
    summary[route] = { http: response.status(), ...byImpact };
    console.log(
      `${route} (HTTP ${response.status()}): ` +
        Object.entries(byImpact)
          .map(([k, n]) => `${k}=${n}`)
          .join(" "),
    );
  } catch (err) {
    console.log(`${route}: FAILED — ${err.message}`);
    summary[route] = { http: 0, error: err.message };
  } finally {
    await page.close();
  }
}

console.log("\n── Most common violations across routes ──");
Object.entries(ruleCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .forEach(([rule, n]) => console.log(`  ${n.toString().padStart(3)}  ${rule}`));

await browser.close();
