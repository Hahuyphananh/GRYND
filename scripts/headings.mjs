import puppeteer from "puppeteer-core";
import fs from "node:fs";

const chrome = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find(fs.existsSync);
const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
const p = await b.newPage();
await p.goto("http://localhost:3000/classement", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1500));
const outline = await p.evaluate(() =>
  [...document.querySelectorAll("h1,h2,h3,h4")].map(
    (h) => `${h.tagName}: ${(h.textContent || "").trim().slice(0, 50)}`,
  ),
);
console.log(outline.join("\n"));
await b.close();
