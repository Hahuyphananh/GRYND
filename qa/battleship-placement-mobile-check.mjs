// qa/battleship-placement-mobile-check.mjs
//
// Phone-presentation check for the Battleship PLACEMENT screen: the 14-column
// board, the six-ship shelf, the timer/rotate controls and the confirm button,
// mounted from the real component (qa/battleship-placement-mobile-harness.jsx)
// with the project's REAL Tailwind CSS, so every number below is the shipped
// layout.
//
// Two requirements pull in opposite directions at phone width, and this check
// pins the resolution:
//
//   * a TAPPABLE cell — 24 CSS px, the WCAG 2.2 SC 2.5.8 minimum target size;
//   * no SIDEWAYS PAGE SCROLL — the page itself must never scroll horizontally.
//
// Fourteen columns at 24px need ~380px of board, which no 320px phone has, so
// the board keeps a minimum width and scrolls inside its own strip. The page
// still never scrolls; only the board strip does, and only where it must.
//
// Checks per viewport:
//   1. the page does not scroll sideways;
//   2. the board strip sits inside the viewport and its card;
//   3. all 140 cells are drawn, square, and at least 24px wide (phone) / 40px
//      (desktop);
//   4. the strip scrolls on phones (the board is wider than the strip) and does
//      NOT scroll on desktop (the floor is released once the card is wide);
//   5. scrolling to the end really reveals the last column (N) on screen;
//   6. no ship button, control or the confirm button is clipped off-screen;
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
// The machine has Chrome installed but Playwright's own download may not be;
// prefer it when present and fall back to the bundled browser.
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
    // A file:// page cannot fetch fonts; those failures are the harness, not the app.
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
  { label: "320", width: 320, height: 568, dpr: 2, phone: true },
  { label: "360", width: 360, height: 800, dpr: 2, phone: true },
  { label: "390", width: 390, height: 844, dpr: 3, phone: true },
  { label: "1280", width: 1280, height: 900, dpr: 1, phone: false },
];

for (const vp of VIEWPORTS) {
  const page = await mount(vp.width, vp.height, vp.dpr);
  const m = await page.evaluate(() => window.__bs.measure());
  const tag = `${vp.label} wide`;
  const floor = vp.phone ? 24 : 40;

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
    `${tag}: every cell is drawn, square and at least ${floor}px`,
    m.cells === 140 &&
      Math.abs(m.cellWidth - m.cellHeight) <= 1.5 &&
      m.cellWidth >= floor,
    `${m.cells} cells, ${px(m.cellWidth)}×${px(m.cellHeight)} (floor ${floor}px)`,
  );

  // The floor is the reason the strip exists: on a phone the board must be
  // wider than the strip (so it scrolls), and on desktop it must not be.
  check(
    `${tag}: the board strip ${vp.phone ? "scrolls to the far columns" : "fits without scrolling"}`,
    m.scroller !== null &&
      (vp.phone
        ? m.scroller.scrollWidth > m.scroller.clientWidth + 1 && m.scroller.overflowX === "auto"
        : m.scroller.scrollWidth <= m.scroller.clientWidth + 1),
    `content ${px(m.scroller?.scrollWidth)} vs strip ${px(m.scroller?.clientWidth)} (overflow-x ${m.scroller?.overflowX})`,
  );

  // And scrolling must actually reach column N — a clipped last column with a
  // scrollbar that stops short would be worse than no scroll at all.
  await page.evaluate(() => window.__bs.scrollBoardToEnd());
  await page.waitForTimeout(150);
  const scrolled = await page.evaluate(() => window.__bs.measure());
  check(
    `${tag}: scrolling to the end reveals column N on screen`,
    scrolled.lastCell !== null &&
      scrolled.lastCell.left >= (scrolled.scroller?.left ?? 0) - 1 &&
      scrolled.lastCell.right <= (scrolled.scroller?.right ?? 0) + 1 &&
      scrolled.lastCell.right <= scrolled.viewportWidth + 1,
    `N1 ${px(scrolled.lastCell?.left)}..${px(scrolled.lastCell?.right)} in strip ${px(scrolled.scroller?.left)}..${px(scrolled.scroller?.right)}`,
  );

  await page.screenshot({
    path: join(SHOTS, `${vp.label}-placement.png`),
    fullPage: false,
  });

  check(
    `${tag}: no ship button or board control is clipped off-screen`,
    m.shelfOverflow === 0 &&
      m.shelf.length === 6 &&
      [m.timer, m.rotate, m.confirm, m.auto].every(
        (control) => control !== null && control.right <= m.viewportWidth + 1 && control.left >= -1,
      ),
    `${m.shelf.length} ships, ${m.shelfOverflow} clipped, timer right ${px(m.timer?.right)}`,
  );

  if (vp.phone) {
    await page.screenshot({
      path: join(SHOTS, `${vp.label}-placement-scrolled.png`),
      fullPage: false,
    });
  }

  await page.close();
}

check("no console / page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
