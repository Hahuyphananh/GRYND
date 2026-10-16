import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto("http://localhost:3000/shop", { waitUntil: "networkidle0", timeout: 30000 });
await page.screenshot({ path: "emotes-preview.png", fullPage: true });
await browser.close();
console.log("Wrote emotes-preview.png");
