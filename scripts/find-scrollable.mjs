import puppeteer from "puppeteer-core";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const chrome = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find(fs.existsSync);
const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setViewport({ width: 800, height: 600 });

for (let i = 0; i < 6; i++) {
  await p.goto("http://localhost:3000/privacy-policy", { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1200));
  await p.evaluate((src) => {
    const s = document.createElement("script");
    s.textContent = src;
    document.head.appendChild(s);
  }, axeSource);
  const r = await p.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: ["scrollable-region-focusable"] });
    return res.violations.map((v) => ({
      impact: v.impact,
      nodes: v.nodes.map((n) => ({
        html: n.html.slice(0, 200),
        any: (n.any || []).map((x) => x.message).slice(0, 2),
      })),
    }));
  });
  if (r.length) {
    console.log(`run ${i + 1}: FOUND`);
    console.log(JSON.stringify(r, null, 1));
    break;
  } else {
    console.log(`run ${i + 1}: none`);
  }
}
await b.close();
