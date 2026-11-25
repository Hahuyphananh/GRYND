#!/usr/bin/env node
// qa/solitaire-theme-check.mjs
//
// THE TABLE THEME, in a real browser, against the BUILT standalone package.
//
// The unit suite proves the catalog and the wiring; this proves the part only a
// browser can: that the board actually PAINTS the stored felt, that a junk value
// falls back instead of leaving an unstyled board, that the choice survives a
// reload, and that the cards themselves are untouched by the theme.
//
// Usage:
//   npm run build:portal:solitaire && node qa/solitaire-theme-check.mjs
//   node qa/solitaire-theme-check.mjs --dir=dist/portal/solitaire-duel

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const STORAGE_KEY = "grynd.solitaire.boardTheme.v1";

const dirArg = process.argv.slice(2).find((entry) => entry.startsWith("--dir="));
const OUT = resolve(process.cwd(), dirArg ? dirArg.slice("--dir=".length) : "dist/portal/solitaire-duel");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

assert.ok(existsSync(join(OUT, "index.html")), `no index.html in ${OUT} — run "npm run build:portal:solitaire" first`);

const server = createServer((req, res) => {
  const requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const safe = normalize(requested).replace(/^([/\\])+/, "");
  let file = join(OUT, safe || "index.html");
  if (!file.startsWith(OUT)) return res.writeHead(403).end("forbidden");
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
assert.ok(chromePath, "Chrome not found — set CHROME_PATH to a Chrome/Chromium binary");

const browser = await puppeteer.launch({ executablePath: chromePath, headless: "new", args: ["--no-sandbox"] });
const notes = [];
const note = (message) => {
  notes.push(message);
  console.log(`  ✓ ${message}`);
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  /** Open the package with `stored` already in localStorage (or nothing). */
  const open = async (stored) => {
    // Land on the app origin, write the preference, reload: a returning visitor
    // whose very first render already reads the stored value.
    await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      (key, value) => {
        try {
          if (value === null) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, value);
        } catch {
          // storage blocked: the app still has to render
        }
      },
      STORAGE_KEY,
      stored,
    );
    await page.reload({ waitUntil: "networkidle2" });
    // The portal opens on a seat picker; the board exists once the race starts.
    const start = await page.$('[data-testid="start-race"]');
    if (start) {
      await start.click();
    }
    await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30_000 });
    await sleep(400);
    return page.evaluate(() => {
      const board = document.querySelector('[data-testid="solitaire-board"]');
      const card = document.querySelector('[data-face-up="true"]');
      const slot = document.querySelector('[data-drop-kind]');
      const style = getComputedStyle(board);
      return {
        theme: board.getAttribute("data-solitaire-theme"),
        felt: style.backgroundImage,
        radius: style.borderRadius,
        cardClass: card?.className ?? "",
        cardBackground: card ? getComputedStyle(card).backgroundImage : "",
        slotBackground: slot ? getComputedStyle(slot).backgroundColor : "",
        cards: document.querySelectorAll("[data-card]").length,
      };
    });
  };

  // ── 1. No preference → Classic Green ─────────────────────────────────
  console.log("\n1. with no stored preference");
  const fallback = await open(null);
  assert.equal(fallback.theme, "classic", "no preference must resolve to Classic Green");
  assert.match(fallback.felt, /radial-gradient/, "the board must paint a felt");
  assert.ok(fallback.cards > 0, "the deal must still render");
  note(`defaults to ${fallback.theme}, felt painted, ${fallback.cards} cards dealt`);

  // The portal must expose the SAME selector as the app — painting a stored
  // theme is not enough if a portal player can never change it.
  const pickerLabel = await page.$eval(
    '[data-testid="solitaire-theme-picker"] summary',
    (node) => node.textContent.replace(/\s+/g, " ").trim(),
  );
  assert.match(pickerLabel, /Table · Classic Green/, "the portal must render the shared table picker");
  await page.click('[data-testid="solitaire-theme-picker"] summary');
  await page.click('[data-theme-key="sand"]');
  await sleep(150);
  const portalPicked = await page.evaluate((key) => ({
    theme: document.querySelector('[data-testid="solitaire-board"]').getAttribute("data-solitaire-theme"),
    stored: localStorage.getItem(key),
  }), STORAGE_KEY);
  assert.equal(portalPicked.theme, "sand", "picking a preset must repaint the portal board");
  assert.equal(portalPicked.stored, "sand", "the portal choice must persist locally");
  note("the portal's picker repaints the board and persists the choice");
  // Leave the next step a clean slate.
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

  // ── 2. A stored preset applies ───────────────────────────────────────
  console.log("\n2. with a stored preset");
  const sand = await open("sand");
  assert.equal(sand.theme, "sand", "the stored preset must be applied");
  assert.notEqual(sand.felt, fallback.felt, "the felt must actually change");
  assert.match(sand.felt, /radial-gradient/);
  note(`"sand" applied — the felt differs from Classic Green`);

  // ── 3. Invalid preference → fallback, not a broken board ─────────────
  console.log("\n3. with an invalid stored value");
  const invalid = await open("neon-disco");
  assert.equal(invalid.theme, "classic", "an unknown preset must fall back to Classic Green");
  assert.match(invalid.felt, /radial-gradient/);
  note("an unknown value falls back to Classic Green, board still styled");

  // ── 4. The choice survives a reload ──────────────────────────────────
  console.log("\n4. after a reload");
  await page.reload({ waitUntil: "networkidle2" });
  const startAgain = await page.$('[data-testid="start-race"]');
  if (startAgain) await startAgain.click();
  await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30_000 });
  await sleep(400);
  const reloaded = await page.evaluate(() => ({
    theme: document.querySelector('[data-testid="solitaire-board"]').getAttribute("data-solitaire-theme"),
  }));
  assert.equal(reloaded.theme, "classic", "the fallback must be stable across a reload");
  // Now store a real choice, reload, and check it persisted.
  await page.evaluate((key) => window.localStorage.setItem(key, "ocean"), STORAGE_KEY);
  await page.reload({ waitUntil: "networkidle2" });
  const startThird = await page.$('[data-testid="start-race"]');
  if (startThird) await startThird.click();
  await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30_000 });
  await sleep(400);
  const persisted = await page.evaluate(() => document.querySelector('[data-testid="solitaire-board"]').getAttribute("data-solitaire-theme"));
  assert.equal(persisted, "ocean", "a stored theme must survive a reload");
  note("the stored theme persists across reloads");

  // ── 5. Cards are untouched by the theme ──────────────────────────────
  console.log("\n5. the cards do not change with the table");
  const ocean = await page.evaluate(() => {
    const card = document.querySelector('[data-face-up="true"]');
    const back = document.querySelector('[data-face-up="false"]');
    return {
      face: getComputedStyle(card).backgroundImage,
      faceClass: card.className,
      backClass: back?.className ?? "",
      slotBackground: getComputedStyle(document.querySelector("[data-drop-kind]")).backgroundColor,
    };
  });
  assert.match(ocean.face, /linear-gradient/, "a face-up card keeps its printed white face");
  assert.match(ocean.faceClass, /from-white/, "the card's own palette is unchanged");
  assert.match(ocean.backClass, /from-\[#1d3a63\]/, "a face-down card keeps its patterned back");
  assert.equal(ocean.face.replace(/\s/g, ""), fallback.cardBackground.replace(/\s/g, ""), "the card face is identical on every felt");
  assert.notEqual(ocean.slotBackground, fallback.slotBackground, "the empty pile DOES follow the theme");
  note("card faces and backs identical; the empty pile follows the theme");

  // ── 6. The portal's MOBILE picker is the same bottom sheet ────────────
  console.log("\n6. the mobile table sheet in the portal");
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY);
  await page.reload({ waitUntil: "networkidle2" });
  const startMobile = await page.$('[data-testid="start-race"]');
  if (startMobile) await startMobile.click();
  await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30_000 });
  await sleep(400);
  await page.click('[data-testid="solitaire-theme-picker"] summary');
  await sleep(150);

  const sheet = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="solitaire-theme-panel"]');
    const board = document.querySelector('[data-testid="solitaire-board"]');
    const picker = document.querySelector('[data-testid="solitaire-theme-picker"]');
    const rect = (node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, w: box.width, h: box.height };
    };
    return {
      panel: rect(panel),
      board: rect(board),
      open: picker.open,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  assert.equal(sheet.open, true, "the picker must open on a phone");
  assert.ok(Math.abs(sheet.panel.bottom - sheet.viewport.h) <= 2, "the phone picker must be pinned to the bottom edge");
  assert.ok(Math.abs(sheet.panel.x) <= 1 && Math.abs(sheet.panel.right - sheet.viewport.w) <= 1, "the sheet spans the phone width");
  assert.ok(sheet.panel.y >= sheet.board.bottom - 1, "the sheet must sit below the board, never over it");
  assert.ok(sheet.overflow <= 1, "the sheet must not add horizontal overflow");
  note("the portal's phone picker is a bottom sheet below the board");

  await page.click('[data-theme-key="ocean"]');
  await sleep(150);
  const mobileTheme = await page.evaluate(() => document.querySelector('[data-testid="solitaire-board"]').getAttribute("data-solitaire-theme"));
  assert.equal(mobileTheme, "ocean", "the sheet must repaint the portal board");
  await page.click('[data-testid="solitaire-theme-sheet-done"]');
  await sleep(120);
  const sheetClosed = await page.evaluate(() => document.querySelector('[data-testid="solitaire-theme-picker"]').open);
  assert.equal(sheetClosed, false, "Done must close the sheet");
  note("the sheet repaints the board and Done closes it");

  assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join("; ")}`);
  console.log(`\n${notes.length} theme assertions passed.`);
} finally {
  await browser.close();
  server.close();
}
