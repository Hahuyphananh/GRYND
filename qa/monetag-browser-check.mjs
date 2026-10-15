// qa/monetag-browser-check.mjs
//
// Loads the local build in a REAL browser and reports what the Monetag tag
// actually does there — the two things a static test cannot see:
//
//   1. whether the loader's request chain succeeds (the tag script itself, the
//      zone endpoint it fetches, and every extra format host the zone returns);
//      and
//   2. whether ANY worker claims the ROOT scope — a second one there would
//      displace next-pwa's /sw.js, which is the one regression this integration
//      can cause. The network names its worker itself (`swName`, "sw.js"), so
//      watch for a registration pointing at /sw.js or at our own /sw1.js. The
//      check reports it as a finding, it does not fail on it.
//
// Run the app first (`npm run build && npx next start -p 3112`), then:
//   node qa/monetag-browser-check.mjs [url]
//
// Headless Chrome is used, so click-driven formats (the popunder) never fire —
// only the passive ones (in-page push, vignette) can render.

import puppeteer from "puppeteer-core";
import fs from "node:fs";

const TARGET = process.argv[2] ?? "http://localhost:3112/";
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const AD_HOSTS = /quge5\.com|auqot\.com|ekhay\.com|b3mny\.com|3nbf4\.com|6opo\.com|ay267\.com|e2ertt\.com/;

const browser = await puppeteer.launch({
  executablePath: CHROME_CANDIDATES.find((p) => p && fs.existsSync(p)),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  const requests = [];
  const failures = [];
  const consoleErrors = [];
  const workerRequests = [];

  page.on("request", (req) => {
    if (AD_HOSTS.test(req.url())) requests.push(`${req.method()} ${req.url()}`);
    // The worker file the network asks OUR origin for, if it ever asks: the
    // zone names it (`swName`), and /sw.js here is next-pwa's.
    const path = new URL(req.url()).pathname;
    if (path === "/sw.js" || path === "/sw1.js") workerRequests.push(`${path} (${req.resourceType()})`);
  });
  page.on("requestfailed", (req) => {
    failures.push(`${req.url()} — ${req.failure()?.errorText ?? "failed"}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(TARGET, { waitUntil: "networkidle2", timeout: 60000 });
  // Give the tag time to fetch its zone and pull the extra formats in.
  await new Promise((resolve) => setTimeout(resolve, 8000));

  const registrations = await page.evaluate(async () => {
    if (!navigator.serviceWorker) return [];
    const list = await navigator.serviceWorker.getRegistrations();
    return list.map((r) => ({
      scope: r.scope,
      scriptURL: r.active?.scriptURL ?? r.installing?.scriptURL ?? r.waiting?.scriptURL ?? null,
      state: r.active?.state ?? r.installing?.state ?? null,
    }));
  });

  const tagPresent = await page.evaluate(
    () => !!document.querySelector('script[src*="quge5.com/88/tag.min.js"]'),
  );

  console.log(`\nURL: ${TARGET}`);
  console.log(`tag in the DOM: ${tagPresent ? "yes" : "NO — the loader never ran"}`);
  console.log(`\nad-network requests (${requests.length}):`);
  for (const r of [...new Set(requests)]) console.log(`  ${r}`);
  console.log(`\nfailed requests (${failures.length}):`);
  for (const f of failures) console.log(`  ${f}`);
  console.log(`\nconsole errors (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
  console.log(`\nrequests to our own origin for a worker file: ${workerRequests.length ? workerRequests.join(", ") : "none (the zone's swName is \"sw.js\", which next-pwa owns)"}`);
  console.log(`\nservice-worker registrations (${registrations.length}):`);
  for (const r of registrations) {
    console.log(`  scope=${r.scope} script=${r.scriptURL} state=${r.state}`);
  }
  const rootScope = registrations.filter((r) => new URL(r.scope).pathname === "/");
  console.log(
    rootScope.length > 1
      ? `\nFINDING: ${rootScope.length} workers claim the ROOT scope — one of them is next-pwa's /sw.js, so offline caching may be displaced.`
      : "\nNo root-scope conflict observed (next-pwa's /sw.js is the only root-scope worker, or the tag did not register one).",
  );
} finally {
  await browser.close();
}
