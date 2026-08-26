// Browser check for the three newly-voiced lobby modes.
import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const chromePath = CHROME_PATHS.find((p) => {
  try {
    return execSync(`test -f "${p}" && echo yes`).toString().trim() === "yes";
  } catch {
    return false;
  }
});
if (!chromePath) {
  console.error("No Chrome found — skipping browser check.");
  process.exit(0);
}

const BASE = "http://localhost:3000";
const PAGES = [
  "/casino/blackjack",
  "/casino/chess",
  "/casino/hex-duel/multiplayer",
];

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"],
});

let failed = 0;
for (const pagePath of PAGES) {
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  try {
    await page.goto(`${BASE}${pagePath}`, { waitUntil: "networkidle2", timeout: 45000 });
    await new Promise((r) => setTimeout(r, 1200));
    // Click an interactive element on each lobby to exercise the new
    // audio handlers (a real gesture also resumes the AudioContext).
    try {
      const clicked = await page.evaluate(() => {
        const btn =
          document.querySelector('button:not([disabled])') ||
          document.querySelector('input[type="number"]');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      await new Promise((r) => setTimeout(r, 600));
      void clicked;
    } catch {
      // non-interactive page — fine
    }
    const realErrors = errors.filter(
      (e) => !/favicon|Failed to load resource.*(sockjs|socket\.io)|net::ERR_ABORTED|401|404/i.test(e),
    );
    if (realErrors.length > 0) failed += 1;
    console.log(`${realErrors.length === 0 ? "OK" : "ERROR"}  ${pagePath}  (console errors: ${realErrors.length})`);
    if (realErrors.length > 0) {
      realErrors.slice(0, 4).forEach((e) => console.log(`      → ${e.slice(0, 200)}`));
    }
  } catch (err) {
    failed += 1;
    console.log(`ERROR  ${pagePath}  (load failed: ${String(err).slice(0, 160)})`);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log(failed === 0 ? "\nAll pages clean." : `\n${failed} page(s) had errors.`);
process.exit(failed === 0 ? 0 : 1);
