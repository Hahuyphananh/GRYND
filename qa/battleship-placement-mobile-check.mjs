// qa/battleship-placement-mobile-check.mjs
//
// Placement-screen check: the 14-column board, the six-ship shelf, the
// timer/rotate controls and the confirm button, mounted from the real component
// (qa/battleship-placement-mobile-harness.jsx) with the project's REAL Tailwind
// CSS, so every number below is the shipped layout.
//
// The board now fits the viewport on every device:
//
//   * no horizontal scroll — the old 28rem phone floor is gone, so the whole
//     A–N grid is visible without a swipe;
//   * no vertical scroll to place — the board is capped by `100dvh`, and the
//     Confirm button stays on the first screen;
//   * cells stay at least 17px on the narrowest 320px phone and 20px from 360px
//     up, so they remain tappable.
//
// Checks per viewport:
//   1. the page does not scroll sideways;
//   2. the board strip sits inside the viewport and its card;
//   3. all 140 cells are drawn, square, and above the width-appropriate floor;
//   4. the strip never scrolls sideways, and column N is visible;
//   5. the board and the Confirm button are fully on the first screen;
//   6. no ship button is clipped horizontally;
//   7. no console / page errors.
//
// Screenshots land in qa/reports/battleship-placement-mobile/.
//
// Run: node qa/battleship-placement-mobile-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(root, "qa/reports/battleship-placement-mobile");
mkdirSync(SHOTS, { recursive: true });
const outDir = mkdtempSync(join(tmpdir(), "grynd-bs-placement-"));

// ── 1. Bundle the real component ───────────────────────────────────────────
await esbuild.build({
  entryPoints: [join(root, "qa/battleship-placement-mobile-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
});

// ── 2. The app's REAL stylesheet ───────────────────────────────────────────
const globals = readFileSync(join(root, "src/app/globals.css"), "utf8").replace(
  /@import url\([^)]*\);\s*/g,
  "",
);
const generated = await postcss([
  tailwindcss(join(root, "tailwind.config.js")),
  autoprefixer(),
]).process(globals, { from: join(root, "src/app/globals.css") });
writeFileSync(join(outDir, "app.css"), generated.css);
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);
console.log(`compiled stylesheet: ${(generated.css.length / 1024).toFixed(0)}KB\n`);

// ── 3. Reporting ───────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};
const px = (value) => (value == null ? "?" : `${Math.round(value * 10) / 10}px`);

const fileUrl = pathToFileURL(join(outDir, "index.html")).href;
const browser = await chromium
  .launch({ channel: "chrome" })
  .catch(() => chromium.launch());

const errors = [];
const mount = async (width, height, dpr) => {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    hasTouch: true,
  });
  page.on("pageerror", (error) => errors.push(`pageerror(${width}): ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource|fonts\.googleapis|net::ERR/.test(message.text())) return;
    errors.push(`console(${width}): ${message.text()}`);
  });
  await page.goto(fileUrl);
  await page.waitForFunction(() => !!window.__bs?.mount, null, { timeout: 20000 });
  await page.evaluate(() => window.__bs.mount());
  await page.waitForSelector('[data-testid="placement-board-cell-A1"]', { timeout: 15000 });
  await page.waitForTimeout(400);
  return page;
};

// 320 is the narrowest device the site supports, 360 / 390 are the common
// Android and iPhone widths. 1280 is the desktop reference for the same board.
const VIEWPORTS = [
  { label: "320", width: 320, height: 568, dpr: 2, phone: true, floor: 17 },
  { label: "360", width: 360, height: 800, dpr: 2, phone: true, floor: 20 },
  { label: "390", width: 390, height: 844, dpr: 3, phone: true, floor: 20 },
  { label: "1280", width: 1280, height: 900, dpr: 1, phone: false, floor: 24 },
];

for (const vp of VIEWPORTS) {
  const page = await mount(vp.width, vp.height, vp.dpr);
  const m = await page.evaluate(() => window.__bs.measure());
  const tag = `${vp.label} wide`;

  console.log(
    `\n▸ ${vp.label}×${vp.height}: board ${px(m.board?.width)}×${px(m.board?.height)}, ` +
      `cell ${px(m.cellWidth)}×${px(m.cellHeight)}, strip ${px(m.scroller?.clientWidth)} ` +
      `(content ${px(m.scroller?.scrollWidth)}), ${m.cells} cells`,
  );

  check(
    `${tag}: the page does not scroll sideways`,
    m.documentScrollWidth <= m.documentClientWidth + 1,
    `document ${m.documentScrollWidth}/${m.documentClientWidth}`,
  );

  check(
    `${tag}: the board strip sits inside the viewport and its card`,
    m.scroller !== null &&
      m.scroller.left >= (m.card?.left ?? 0) - 1 &&
      m.scroller.right <= m.viewportWidth + 1,
    `strip ${px(m.scroller?.left)}..${px(m.scroller?.right)} in card ${px(m.card?.left)}..${px(m.card?.right)}`,
  );

  check(
    `${tag}: every cell is drawn, square and at least ${vp.floor}px`,
    m.cells === 140 &&
      Math.abs(m.cellWidth - m.cellHeight) <= 1.5 &&
      m.cellWidth >= vp.floor,
    `${m.cells} cells, ${px(m.cellWidth)}×${px(m.cellHeight)} (floor ${vp.floor}px)`,
  );

  check(
    `${tag}: the board never scrolls sideways`,
    m.scroller !== null && m.scroller.scrollWidth <= m.scroller.clientWidth + 1,
    `content ${px(m.scroller?.scrollWidth)} vs strip ${px(m.scroller?.clientWidth)}`,
  );

  check(
    `${tag}: column N is visible without scrolling`,
    m.lastCell !== null &&
      m.scroller !== null &&
      m.lastCell.right <= m.scroller.right + 1 &&
      m.lastCell.right <= m.viewportWidth + 1,
    `N1 ${px(m.lastCell?.left)}..${px(m.lastCell?.right)} in strip ${px(m.scroller?.left)}..${px(m.scroller?.right)}`,
  );

  check(
    `${tag}: the whole board is on the first screen`,
    m.board !== null && m.board.top >= -1 && m.board.bottom <= m.viewportHeight + 1,
    `board ${px(m.board?.top)}..${px(m.board?.bottom)} of ${px(m.viewportHeight)}`,
  );

  check(
    `${tag}: the Confirm button is on the first screen`,
    m.confirm !== null && m.confirm.bottom <= m.viewportHeight + 1 && m.confirm.top >= -1,
    `confirm ${px(m.confirm?.top)}..${px(m.confirm?.bottom)} of ${px(m.viewportHeight)}`,
  );

  await page.screenshot({ path: join(SHOTS, `${vp.label}-placement.png`) });

  check(
    `${tag}: no ship button is clipped off-screen horizontally`,
    m.shelfOverflow === 0 &&
      m.shelf.length === 6 &&
      [m.timer, m.rotate, m.confirm, m.auto].every(
        (control) => control !== null && control.right <= m.viewportWidth + 1 && control.left >= -1,
      ),
    `${m.shelf.length} ships, ${m.shelfOverflow} clipped`,
  );

  await page.close();
}

check("no console / page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
