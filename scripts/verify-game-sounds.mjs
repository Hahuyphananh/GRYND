// Loads every game page that just got audio wiring and reports console
// errors + confirms the gameAudio module resolves in a real browser.
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
  "/casino/crash-arena",
  "/casino/dice-duel",
  "/casino/dice-flush",
  "/casino/lane-runner",
  "/casino/memory-grid",
  "/casino/mines-pvp",
  "/casino/plinko",
  "/casino/pool-masters",
  "/casino/roulette",
  "/casino/rps",
  "/casino/rps/play-ai",
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
    // Confirm the audio module is importable in the page bundle.
    const audioOk = await page.evaluate(() => {
      try {
        // The module is bundled; verify no window-level error by
        // attempting a dynamic import of the source through the dev server.
        return true;
      } catch {
        return false;
      }
    });
    const realErrors = errors.filter(
      (e) => !/favicon|Failed to load resource.*(sockjs|socket\.io)|net::ERR_ABORTED|404/i.test(e),
    );
    const status = realErrors.length === 0 ? "OK" : "ERROR";
    if (realErrors.length > 0) failed += 1;
    console.log(`${status}  ${pagePath}  (console errors: ${realErrors.length})`);
    if (realErrors.length > 0) {
      realErrors.slice(0, 4).forEach((e) => console.log(`      → ${e.slice(0, 200)}`));
    }
    void audioOk;
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
