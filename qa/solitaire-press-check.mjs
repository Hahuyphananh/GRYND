#!/usr/bin/env node
// qa/solitaire-press-check.mjs
//
// The board's INPUT LATENCY contract, driven in a real browser against the BUILT
// standalone package.
//
// Why this exists: a card used to be picked up by the `click` the browser fires
// only after the button comes back up, so every selection waited a full
// press-and-release, and a placement waited for the release too. Nothing in the
// pure interaction tests could see that — the delay lives in WHEN the decision is
// made, not in what the decision is. So it is asserted here, with the pointer:
//
//   1. PRESS alone selects a card (measured with the mouse still down), and the
//      release does not undo it.
//   2. Pressing a legal pile PLACES the held card on the press — exactly once.
//      The release must not repeat it.
//   3. A drag still resolves exactly one move, and leaves no ghost behind.
//
// Usage:
//   npm run build:portal:solitaire && node qa/solitaire-press-check.mjs
//   node qa/solitaire-press-check.mjs --dir=dist/portal/solitaire-duel

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer-core";

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

// ── Serve the package ─────────────────────────────────────────────────────
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

  /** Open the standalone package and take a seat at a fresh deal. */
  const freshDeal = async () => {
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle2" });
    await page.click('[data-testid="start-race"]');
    await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 60_000 });
    // The countdown gates the board: the stock becomes enabled at GO.
    for (let i = 0; i < 200; i += 1) {
      const ready = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="solitaire-stock"]');
        return Boolean(el) && !el.disabled;
      });
      if (ready) break;
      await sleep(100);
    }
  };
  await freshDeal();

  const ply = () =>
    page.evaluate(() => Number(document.querySelector('[data-testid="solitaire-board"]').dataset.ply));
  const held = () =>
    page.evaluate(() => document.querySelector('[data-testid="solitaire-board"]').getAttribute("data-selected"));
  const ghost = () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="solitaire-drag-ghost"]')));

  /**
   * A legal tableau→tableau move read from the DOM: a column's top card onto a
   * column whose top card is one rank higher and the other colour, or a King
   * onto an empty column. Returned as viewport coordinates for the pointer.
   */
  const findMove = () =>
    page.evaluate(() => {
      const suitOf = (card) => card.split("-")[0];
      const rankOf = (card) => Number(card.split("-")[1]);
      const isRed = (suit) => suit === "hearts" || suit === "diamonds";
      const columns = [...document.querySelectorAll('div[data-testid^="solitaire-column-"]')]
        .filter((column) => /^solitaire-column-\d+$/.test(column.dataset.testid))
        .map((column) => {
          const cards = [...column.querySelectorAll('[data-drag-slot="tableau"]')];
          const top = cards[cards.length - 1] ?? null;
          return {
            testid: column.dataset.testid,
            top: top && top.dataset.faceUp === "true" ? top : null,
            topCard: top?.dataset.card ?? null,
            empty: column.querySelector('button[data-drop-kind="column"]'),
          };
        });

      for (let from = 0; from < columns.length; from += 1) {
        const source = columns[from];
        if (!source.top || !source.topCard) continue;
        const rect = source.top.getBoundingClientRect();
        const at = { x: rect.left + rect.width / 2, y: rect.top + 5 };
        for (let to = 0; to < columns.length; to += 1) {
          if (to === from) continue;
          const target = columns[to];
          if (target.topCard) {
            const descends = rankOf(target.topCard) === rankOf(source.topCard) + 1;
            const alternates = isRed(suitOf(target.topCard)) !== isRed(suitOf(source.topCard));
            if (!descends || !alternates) continue;
            const drop = target.top.getBoundingClientRect();
            return { source: at, target: { x: drop.left + drop.width / 2, y: drop.top + 5 }, kind: "card", from: source.testid, to: target.testid };
          }
          if (target.empty && rankOf(source.topCard) === 13) {
            const drop = target.empty.getBoundingClientRect();
            return { source: at, target: { x: drop.left + drop.width / 2, y: drop.top + drop.height / 2 }, kind: "empty", from: source.testid, to: target.testid };
          }
        }
      }
      return null;
    });

  /** Draw from the stock until the deal offers a legal tableau move. */
  const playable = async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const move = await findMove();
      if (move) return move;
      await page.click('[data-testid="solitaire-stock"]').catch(() => {});
      await sleep(220);
    }
    return findMove();
  };

  /**
   * A legal tableau move, restarting on a fresh deal when this one has none
   * left. A shuffle guarantees a move, not a SEQUENCE of them, so each step
   * that consumes a move asks for its own deal instead of borrowing one.
   */
  const dealWithMove = async (what) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await freshDeal();
      const move = await playable();
      if (move) return move;
    }
    assert.fail(`no deal offered ${what}`);
  };

  // ── 1. A press selects, before any release ────────────────────────────
  console.log("\n1. press selects the card");
  const pressCards = await page.evaluate(() =>
    [...document.querySelectorAll('[data-face-up="true"][data-drag-slot]')]
      .filter((card) => {
        const rect = card.getBoundingClientRect();
        return rect.width > 10 && rect.top > 120 && rect.bottom < window.innerHeight;
      })
      .slice(0, 3)
      .map((card) => {
        const rect = card.getBoundingClientRect();
        return { testid: card.getAttribute("data-testid"), x: rect.left + rect.width / 2, y: rect.top + 5 };
      }),
  );
  assert.ok(pressCards.length > 0, "the board must expose at least one face-up card");

  for (const card of pressCards) {
    await page.mouse.move(card.x, card.y);
    await page.mouse.down();
    await sleep(120);
    const onPress = await held(); // decision measured with the button STILL DOWN
    await page.mouse.up();
    await sleep(250);
    const afterRelease = await held();
    assert.notEqual(onPress, "none", `${card.testid}: pressing the card must select it before release`);
    assert.equal(afterRelease, onPress, `${card.testid}: the release must not undo the selection`);
    note(`${card.testid}: selected on press (${onPress}) and held after release`);
    // Put it back down so the next card starts from nothing held.
    await page.mouse.click(card.x, card.y);
    await sleep(150);
  }

  // ── 2. A placement resolves on the press, exactly once ────────────────
  console.log("\n2. a placement applies on press, once");
  const placement = await dealWithMove("a legal tableau move to press");
  await page.mouse.click(placement.source.x, placement.source.y);
  await sleep(200);
  assert.notEqual(await held(), "none", "the card to place must be selected first");

  const plyBefore = await ply();
  await page.mouse.move(placement.target.x, placement.target.y);
  await page.mouse.down();
  await sleep(220);
  const plyOnPress = await ply();
  await page.mouse.up();
  await sleep(450);
  const plyAfterRelease = await ply();

  assert.equal(plyOnPress, plyBefore + 1, `${placement.from}→${placement.to} must be placed on the PRESS, not the release`);
  assert.equal(plyAfterRelease, plyOnPress, "the release must not place the card a second time");
  note(`${placement.from} → ${placement.to}: ply ${plyBefore} → ${plyOnPress} on press, unchanged on release`);

  // ── 3. A drag still moves exactly one card ────────────────────────────
  console.log("\n3. a drag still moves one card");
  const drag = await dealWithMove("a legal tableau move to drag");
  const dragBefore = await ply();
  await page.mouse.move(drag.source.x, drag.source.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    const ratio = step / 8;
    await page.mouse.move(
      drag.source.x + (drag.target.x - drag.source.x) * ratio,
      drag.source.y + (drag.target.y - drag.source.y) * ratio,
    );
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(700);
  const dragAfter = await ply();
  assert.equal(dragAfter, dragBefore + 1, "a drag must resolve exactly one move");
  assert.equal(await ghost(), false, "the drag ghost must be gone after the drop");
  note(`${drag.from} → ${drag.to}: dragged, ply ${dragBefore} → ${dragAfter}, ghost cleared`);

  assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join("; ")}`);

  console.log(`\n${notes.length} press-timing assertions passed.`);
} finally {
  await browser.close();
  server.close();
}
