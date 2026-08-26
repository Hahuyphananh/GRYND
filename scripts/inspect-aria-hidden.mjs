import puppeteer from "puppeteer-core";
import fs from "node:fs";

const chrome = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find(fs.existsSync);

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
const p = await b.newPage();
await p.goto("http://localhost:3000/", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1500));

const r = await p.evaluate(() => {
  const out = [];
  document.querySelectorAll("[aria-hidden='true']").forEach((el) => {
    const focusable = el.querySelectorAll(
      "a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1']),iframe",
    );
    if (focusable.length) {
      out.push({
        el: (el.className?.toString() || el.tagName).slice(0, 70),
        focusable: [...focusable].map((f) => f.tagName + ":" + (f.className?.toString().slice(0, 50) || "")),
      });
    }
  });
  return out;
});
console.log(JSON.stringify(r, null, 1));
await b.close();
