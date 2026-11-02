// qa/dominoes-board-check.mjs
//
// Drives qa/dominoes-board-harness.jsx — the REAL Dominoes board, in the REAL
// page chrome — and measures the four things this board was reworked for:
//
//   1. THE BOARD IS THE PAGE. On a desktop the whole board (felt included) sits
//      above the fold, with no page scroll to reach it.
//   2. THE TABLE FITS THE FELT. A long chain is laid out INSIDE the felt the
//      player can see: the surface may never be wider or taller than the board's
//      scroll box, which is what "turn the line at the edge" is for.
//   3. THE HAND IS IN THE SIDEBAR, and its tiles are still thumb-sized.
//   4. THE VALUES ARE READABLE on a turned tile: the rotation placed on a tile
//      plus the rotation painted back onto its halves must come to 0°, so a
//      domino lying vertically still reads left to right.
//
// Screenshots land in qa/reports/ for a human look.
//
// Run: node qa/dominoes-board-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "grynd-dominoes-board-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });
// `--sections` prints how many pixels each part of the board spends, which is how
// "it does not fit" turns into "this row is 60px of felt the player never sees".
const SECTIONS = process.argv.includes("--sections");

// ── Bundle the harness (the app's own components, the app's own CSS) ───────
await esbuild.build({
  entryPoints: [join(root, "qa/dominoes-board-harness.jsx")],
  bundle: true,
  // IIFE, not ESM: the harness is opened from file://, where module scripts are
  // blocked by the browser's CORS policy.
  format: "iife",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  jsx: "automatic",
  loader: { ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
});

const compiled = await postcss([
  tailwindcss(join(root, "tailwind.config.js")),
  autoprefixer(),
]).process(readFileSync(join(root, "src/app/globals.css"), "utf8"), {
  from: join(root, "src/app/globals.css"),
});
const appCss = compiled.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, "");
writeFileSync(join(outDir, "app.css"), appCss);

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dominoes board check</title>
<link rel="stylesheet" href="./app.css"></head>
<body class="bg-[#03040c]"><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

// ── Reporting ──────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const fileUrl = pathToFileURL(join(outDir, "index.html")).href;
// The machine's own Chrome, so the check needs no browser download; the bundled
// Chromium is used when it is present.
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());

const structuralErrors = (errors) =>
  errors.filter((e) =>
    /validateDOMNesting|descendant of|hydration|Cannot read|Cannot update|is not a function|unique "key"/i.test(
      e,
    ),
  );

/** Mount a live match at a viewport and let the felt measurement settle. */
const boot = async (viewport, props = {}) => {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(fileUrl);
  await page
    .waitForFunction(() => !!window.__dm?.mount, null, { timeout: 20000 })
    .catch((error) => {
      throw new Error(
        `the harness never mounted: ${error.message}\n` +
          `console: ${consoleErrors.slice(0, 5).join(" | ")}\n` +
          `pageerror: ${pageErrors.slice(0, 5).join(" | ")}`,
      );
    });
  await page.evaluate((p) => window.__dm.mount(p), props);
  await page.waitForSelector(".dominoes-chain-surface", { timeout: 15000 });
  // The felt is MEASURED after mount (ResizeObserver → re-layout), so give both
  // passes a frame to land before anything is read.
  await page.waitForTimeout(700);
  return { context, page, consoleErrors, pageErrors };
};

/** Everything asserted about one rendered board. */
const inspect = async (page, tag, { expectSidebar = true, expectAboveFold = true } = {}) => {
  const m = await page.evaluate(() => window.__dm.measure());
  const tiles = await page.evaluate(() => window.__dm.tiles());
  const errors = structuralErrors([
    ...(page.__consoleErrors ?? []),
    ...(page.__pageErrors ?? []),
  ]);

  if (SECTIONS) {
    const sections = await page.evaluate(() => window.__dm.sections());
    const ranked = Object.entries(sections)
      .filter(([, value]) => value && typeof value === "object")
      .sort((a, b) => b[1].height - a[1].height)
      .map(([key, value]) => `${key}=${value.height}`)
      .join(" ");
    console.log(`   sections ${tag}: ${ranked}`);
  }

  console.log(
    `   ${tag}: viewport ${m.viewport.width}×${m.viewport.height} · document ${m.document.scrollHeight}px tall ` +
      `(client ${m.document.clientHeight}) · board ${m.board?.width}×${m.board?.height} bottom=${m.board?.bottom} · ` +
      `felt ${m.chain.cols}×${m.chain.rows} cells · surface ${m.surface?.width}×${m.surface?.height} ` +
      `in ${m.scroller.clientWidth}×${m.scroller.clientHeight}`,
  );

  // 1. The board is the page: nothing below the fold, no page scroll. On a phone
  // the sidebar stacks under the felt and the PAGE is meant to scroll, so this is
  // a desktop rule.
  if (expectAboveFold) {
    check(
      `${tag}: the whole board is above the fold`,
      m.document.scrollHeight <= m.document.clientHeight + 2,
      `document ${m.document.scrollHeight} > viewport ${m.document.clientHeight}`,
    );
  }

  // 2. The table fits the felt — the limits are real.
  check(
    `${tag}: the chain is laid out inside the felt`,
    m.surface &&
      m.surface.width <= m.scroller.clientWidth + 1 &&
      m.surface.height <= m.scroller.clientHeight + 1,
    `surface ${m.surface?.width}×${m.surface?.height} vs felt ${m.scroller.clientWidth}×${m.scroller.clientHeight}`,
  );

  // 2b. …and the felt itself never needs scrolling: nothing on the table is out
  // of reach, which is the whole point of turning the line at the edge.
  check(
    `${tag}: the felt needs no scrolling`,
    m.scroller.scrollWidth <= m.scroller.clientWidth + 1 &&
      m.scroller.scrollHeight <= m.scroller.clientHeight + 1,
    `scroll ${m.scroller.scrollWidth}×${m.scroller.scrollHeight} vs client ${m.scroller.clientWidth}×${m.scroller.clientHeight}`,
  );

  // 3. The felt uses the board (it must not collapse to a strip).
  check(
    `${tag}: the felt fills the board`,
    (m.scroller.rect?.height ?? 0) >= 180,
    `felt height ${m.scroller.rect?.height}`,
  );

  // 4. The values are upright on every tile, however it is lying.
  const crooked = tiles.filter((tile) => tile.painted !== 0);
  const doubles = tiles.filter((tile) => tile.isDouble);
  check(
    `${tag}: every tile's values read upright`,
    crooked.length === 0,
    crooked.map((t) => `${t.tile}@${t.placement}°+${t.halfAngle}°`).join(", "),
  );
  check(`${tag}: the chain has an upright double to check against`, doubles.length > 0, `${doubles.length} doubles`);
  check(
    `${tag}: an upright tile has its numbers upright`,
    doubles.every((tile) => tile.placement === 90 ? tile.halfAngle === 270 : true),
    doubles.map((t) => `${t.tile}@${t.placement}/${t.halfAngle}`).join(", "),
  );

  // 4b. The last-play badge floats in free felt — it never hides another tile.
  const badge = await page.evaluate(() => window.__dm.markerOverlaps());
  check(
    `${tag}: the last-play badge covers no other tile`,
    badge.marker === null || badge.covers.length === 0,
    badge.covers.join(", "),
  );

  // 5. The hand lives in the sidebar, and it is thumb-sized.
  if (expectSidebar) {
    check(
      `${tag}: the hand is in the sidebar, beside the board`,
      Boolean(m.hand && m.sidebar && m.hand.left >= m.sidebar.left - 1 && m.hand.right <= m.sidebar.right + 1),
      `hand ${m.hand?.left}-${m.hand?.right} sidebar ${m.sidebar?.left}-${m.sidebar?.right}`,
    );
    check(
      `${tag}: the hand's tiles are thumb-sized`,
      m.handTileHeight >= 40,
      `half=${m.handTileHeight}px`,
    );
    check(
      `${tag}: the sidebar is a column beside the felt`,
      Boolean(m.sidebar && m.main && m.sidebar.left >= m.main.left + m.main.width - 1),
      `sidebar left=${m.sidebar?.left} board column right=${m.main?.left + m.main?.width}`,
    );
  }

  // 6. No sideways creep anywhere.
  check(
    `${tag}: the page never scrolls sideways`,
    m.document.scrollWidth <= m.document.clientWidth + 1,
    `scrollWidth ${m.document.scrollWidth} clientWidth ${m.document.clientWidth}`,
  );

  check(`${tag}: no runtime / hydration errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  return m;
};

// ══════════════════════════════════════════════════════════════════════════
// DESKTOP — the board is the page, and a long chain still fits the felt
// ══════════════════════════════════════════════════════════════════════════
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  for (const chainLength of [7, 26]) {
    const { context, page, consoleErrors, pageErrors } = await boot(viewport, { chainLength });
    page.__consoleErrors = consoleErrors;
    page.__pageErrors = pageErrors;
    const tag = `desktop ${viewport.width}×${viewport.height}, ${chainLength}-tile chain`;
    await inspect(page, tag);
    await page.screenshot({
      path: join(REPORTS, `dominoes-desktop-${viewport.width}-${chainLength}.png`),
    });
    await context.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PHONE — stacked, scrollable page, and the hand still reachable
// ══════════════════════════════════════════════════════════════════════════
for (const width of [390, 360, 320]) {
  const { context, page, consoleErrors, pageErrors } = await boot(
    { width, height: 844 },
    { chainLength: 26 },
  );
  page.__consoleErrors = consoleErrors;
  page.__pageErrors = pageErrors;
  const tag = `phone ${width}×844`;
  const m = await inspect(page, tag, { expectSidebar: false, expectAboveFold: false });
  // ONE SCREEN FOR THE WHOLE BOARD — felt, hand and controls — even though the
  // page itself still scrolls past it to the move log.
  check(
    `${tag}: the whole board is on the first screen`,
    Boolean(m.board && m.board.bottom <= m.viewport.height + 1),
    `board bottom=${m.board?.bottom} viewport=${m.viewport.height}`,
  );
  const stacked = await page.evaluate(() => {
    const hand = document.querySelector(".dominoes-hand");
    const felt = document.querySelector(".dominoes-chain-scroller");
    if (!hand || !felt) return null;
    return {
      handTop: Math.round(hand.getBoundingClientRect().top),
      feltBottom: Math.round(felt.getBoundingClientRect().bottom),
      feltHeight: Math.round(felt.getBoundingClientRect().height),
    };
  });
  check(
    `${tag}: the hand stacks under the felt, and the felt keeps its height`,
    Boolean(stacked && stacked.handTop >= stacked.feltBottom - 1 && stacked.feltHeight >= 150),
    stacked ? `hand top=${stacked.handTop} felt bottom=${stacked.feltBottom} height=${stacked.feltHeight}` : "missing",
  );
  await page.screenshot({ path: join(REPORTS, `dominoes-phone-${width}.png`), fullPage: true });
  await context.close();
}

await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
