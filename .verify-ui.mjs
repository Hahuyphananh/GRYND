// Temporary live UI check (deleted after the run).
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 520 });
await page.goto("https://grynd.dedyn.io/", { waitUntil: "networkidle2", timeout: 60000 });
await page.evaluate(() => {
  for (const b of document.querySelectorAll("button")) {
    const t = (b.textContent || "").trim().toUpperCase();
    if (t === "GOT IT" || t === "ACCEPT" || t === "ACCEPT ALL") b.click();
  }
});
await new Promise((r) => setTimeout(r, 3000));

const report = await page.evaluate(() => {
  const sticky = document.querySelector('[data-testid="home-streak-sticky"]');
  const proof = document.querySelector('[data-testid="home-social-proof"]');
  const tpLinks = [...document.querySelectorAll('[data-testid="home-social-proof"] a')].filter((a) =>
    /trustpilot\.com/.test(a.href),
  );
  const capsule = tpLinks[0];
  const cs = capsule ? getComputedStyle(capsule) : null;
  return {
    stickyWrapper: Boolean(sticky),
    stickyPosition: sticky ? getComputedStyle(sticky).position : null,
    stickyTop: sticky ? getComputedStyle(sticky).top : null,
    streakChipOnHome: document.querySelectorAll('[data-testid="streak-chip"]').length,
    trustpilotIframes: document.querySelectorAll(".trustpilot-widget").length,
    trustpilotLinks: tpLinks.length,
    capsuleBg: cs?.backgroundColor ?? null,
    capsuleBorder: cs?.borderColor ?? null,
    capsuleText: capsule?.textContent?.replace(/\s+/g, " ").trim() ?? null,
  };
});
console.log(JSON.stringify(report, null, 1));

await page.evaluate(() => {
  const el = document.querySelector('[data-testid="home-social-proof"]');
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, Math.max(0, top - 120));
});
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: ".proof-after.png" });

// A non-home page must keep the fixed top-right chip mount and no sticky one.
const page2 = await browser.newPage();
await page2.setViewport({ width: 1100, height: 700 });
await page2.goto("https://grynd.dedyn.io/games", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 2000));
console.log(
  "games page:",
  JSON.stringify(
    await page2.evaluate(() => ({
      stickyWrapper: Boolean(document.querySelector('[data-testid="home-streak-sticky"]')),
    })),
  ),
);

await browser.close();
