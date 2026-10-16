/**
 * Headless-Chrome verification of the policy pages.
 *
 * Drives the locally installed Chrome (via puppeteer-core — no browser
 * download) against a running dev server, waits for React hydration, then
 * asserts that key headings from the rewritten policies are actually
 * rendered and that no page errors occurred.
 *
 *   node scripts/verify-policy-pages.mjs [baseUrl]
 */

import puppeteer from "puppeteer-core";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BASE = process.argv[2] || "http://localhost:3000";

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
    try {
      require.resolve(candidate); // not how this works — resolve exists check below
    } catch {}
    if (require("node:fs").existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome not found. Set CHROME_PATH.");
}

const EXPECTATIONS = {
  "/privacy-policy": [
    "Information We Collect",
    "Analytics & Diagnostics",
    "Support & Live Chat",
    "Data Retention",
    "Cookies & Local Storage",
    "International Data Transfers",
  ],
  "/terms": [
    "Virtual Tokens & Transactions",
    "User Content & Community",
    "Communications",
    "15. Privacy",
  ],
  "/accessibility": ["Real-Time & Skill Games", "Reduced Motion"],
  "/fair-play": [
    "Responsible Gaming",
    "Game Integrity & Randomness",
    // The old text contained raw CJK characters — must be gone.
  ],
  "/security-policy": [
    "Payment & Token Integrity",
    "Vulnerability Management",
    "Incident Response",
  ],
  "/faq": ["What data does GRYND collect about me?"],
};

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let failures = 0;
try {
  for (const [path, expected] of Object.entries(EXPECTATIONS)) {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") pageErrors.push(msg.text());
    });

    const response = await page.goto(`${BASE}${path}`, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });
    // Give React hydration a moment to render the sections.
    await new Promise((r) => setTimeout(r, 1500));
    const text = await page.evaluate(() => document.body.innerText);

    const status = response.status();
    const missing = expected.filter((needle) => !text.includes(needle));
    const ok = status === 200 && missing.length === 0 && pageErrors.length === 0;
    console.log(`${ok ? "✔" : "✖"} ${path} (HTTP ${status})`);
    if (missing.length) console.log(`    missing: ${missing.join(", ")}`);
    if (pageErrors.length) {
      console.log(`    page errors (${pageErrors.length}): ${pageErrors.slice(0, 2).join(" | ")}`);
    }
    if (!ok) failures += 1;
    await page.close();
  }

  // Fair play: assert the CJK characters are gone from the rendered text.
  const page = await browser.newPage();
  await page.goto(`${BASE}/fair-play`, { waitUntil: "networkidle0", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  const body = await page.evaluate(() => document.body.innerText);
  const hasCjk = /[\u4e00-\u9fff]/.test(body);
  console.log(`${hasCjk ? "✖" : "✔"} /fair-play contains no CJK characters`);
  if (hasCjk) failures += 1;
  await page.close();
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nAll policy pages verified ✔" : `\n${failures} page(s) FAILED ✖`);
process.exit(failures === 0 ? 0 : 1);
