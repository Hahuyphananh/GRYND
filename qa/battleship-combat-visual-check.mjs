// qa/battleship-combat-visual-check.mjs
//
// Visual + layout verification for two things that changed together:
//
//   1. the COMBAT screen — two full-width 14×10 boards, stacked one per row
//      instead of squeezed side by side, each with the six-ship fleet;
//   2. the CARD ART (src/images/battleship-card.svg) — now a landscape 14×10
//      board showing all six ships, which is also the landing page's hero/OG
//      image.
//
// The screen is mounted from the REAL BattlePreview
// (qa/battleship-combat-visual-harness.jsx) with a server-shaped MatchView,
// bundled with the project's REAL Tailwind stylesheet. Only the mascot and the
// translation hook are stubbed — they need providers this page does not mount.
//
// Checks per viewport (390 phone, 1280 desktop):
//   1. the page does not scroll sideways;
//   2. both board strips sit inside the viewport and their cards;
//   3. the boards are STACKED (the enemy board starts below the fleet board);
//   4. all 140 cells are drawn, square, and tappable (≥24px phone, ≥40 desktop);
//   5. the strip scrolls on a phone and fits on a desktop, and scrolling reaches
//      column N;
//   6. the viewer's own six ships are drawn on their board;
//   7. the lock control is on-screen;
//   8. no console / page errors.
//
// Screenshots: qa/reports/battleship-combat/ (card art, both viewports, plus a
// full-page phone shot and a scrolled phone shot).
//
// Run: node qa/battleship-combat-visual-check.mjs

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
const SHOTS = join(root, "qa/reports/battleship-combat");
mkdirSync(SHOTS, { recursive: true });
const outDir = mkdtempSync(join(tmpdir(), "grynd-bs-combat-"));

// Providers this harness does not mount: the mascot and the language context.
const STUBS = {
  "components/mascot/GlitchSay": `
    export default function GlitchSay() { return null; }
  `,
  "hooks/useTranslation": `
    export function useTranslation() {
      return { t: (key, fallback) => (typeof fallback === "string" ? fallback : key), language: "en" };
    }
  `,
};
const stubKeys = Object.keys(STUBS);
const normalized = (value) => value.replace(/\\/g, "/");
const matchStubKey = (specifier, resolveDir) => {
  for (const key of stubKeys) {
    if (specifier === key || specifier.endsWith("/" + key)) return key;
  }
  if (!specifier.startsWith(".")) return null;
  const absolute = normalized(join(resolveDir, specifier));
  for (const key of stubKeys) {
    if (absolute.endsWith("/" + key)) return key;
  }
  return null;
};

await esbuild.build({
  entryPoints: [join(root, "qa/battleship-combat-visual-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "bs-combat-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "bs-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "bs-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

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

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};
const px = (value) => (value == null ? "?" : `${Math.round(value * 10) / 10}px`);

const browser = await chromium
  .launch({ channel: "chrome" })
  .catch(() => chromium.launch());

// ── 1. The card art, rendered on its own ───────────────────────────────────
const art = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await art.goto(pathToFileURL(join(root, "src/images/battleship-card.svg")).href);
await art.waitForTimeout(300);
const artShot = join(SHOTS, "battleship-card.png");
await art.screenshot({ path: artShot });
const artMetrics = await art.evaluate(() => {
  const svg = document.querySelector("svg");
  const svgBox = svg.getBoundingClientRect();
  return {
    title: svg.querySelector("title")?.textContent?.trim() ?? "",
    boards: [...svg.querySelectorAll('rect[width="523"][height="383"]')].length,
    ships: [...svg.querySelectorAll('rect[width="32"][height="32"]')].length,
    labels: [...svg.querySelectorAll("text")].map((node) => node.textContent.trim()),
    width: Math.round(svgBox.width),
    height: Math.round(svgBox.height),
    gridPatterns: svg.querySelectorAll("pattern#bs-grid").length,
  };
});
console.log(`card art: ${artMetrics.width}×${artMetrics.height}, ${artMetrics.boards} boards, ${artMetrics.gridPatterns} grid pattern(s)`);
check(
  "card art: two 14×10 boards are drawn at 1200×630",
  artMetrics.boards === 2 && artMetrics.width === 1200 && artMetrics.height === 630,
  `${artMetrics.boards} boards, ${artMetrics.width}×${artMetrics.height}`,
);
check(
  "card art: the board is labelled to column N",
  artMetrics.labels.includes("A") && artMetrics.labels.includes("N"),
  `labels ${artMetrics.labels.filter((l) => l.length === 1).join("")}`,
);
check(
  "card art: the six-ship fleet and the 14×10 size are stated",
  artMetrics.labels.some((label) => label.includes("14 × 10")) &&
    artMetrics.labels.some((label) => label.includes("SIX SHIPS")),
  artMetrics.labels.filter((label) => label.includes("×")).join(" | "),
);
await art.close();

// ── 2. The combat screen ───────────────────────────────────────────────────
const errors = [];
const mount = async (width, height, dpr) => {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    hasTouch: width < 640,
  });
  page.on("pageerror", (error) => errors.push(`pageerror(${width}): ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource|fonts\.googleapis|net::ERR/.test(message.text())) return;
    errors.push(`console(${width}): ${message.text()}`);
  });
  await page.goto(pathToFileURL(join(outDir, "index.html")).href);
  await page.waitForFunction(() => !!window.__bsc?.mount, null, { timeout: 20000 });
  await page.evaluate(() => window.__bsc.mount());
  await page.waitForSelector('[data-testid="enemy-waters-cell-A1"]', { timeout: 15000 });
  await page.waitForTimeout(500);
  return page;
};

for (const vp of [
  { label: "390", width: 390, height: 844, dpr: 3 },
  { label: "1280", width: 1280, height: 900, dpr: 1 },
]) {
  const page = await mount(vp.width, vp.height, vp.dpr);
  const m = await page.evaluate(() => window.__bsc.measure());
  const tag = `${vp.label} combat`;
  const floor = vp.width < 640 ? 24 : 40;

  console.log(
    `\n▸ ${vp.label}×${vp.height}: fleet board ${px(m.myFleet?.width)} ` +
      `(top ${px(m.myFleet?.top)}), enemy board ${px(m.enemy?.width)} (top ${px(m.enemy?.top)}), ` +
      `cell ${px(m.cellWidth)}`,
  );

  check(
    `${tag}: the page does not scroll sideways`,
    m.documentScrollWidth <= m.documentClientWidth + 1,
    `document ${m.documentScrollWidth}/${m.documentClientWidth}`,
  );

  check(
    `${tag}: both board strips sit inside the viewport`,
    [m.myFleet, m.enemy].every(
      (strip) => strip !== null && strip.left >= -1 && strip.right <= m.viewportWidth + 1,
    ),
    `fleet ${px(m.myFleet?.left)}..${px(m.myFleet?.right)}, enemy ${px(m.enemy?.left)}..${px(m.enemy?.right)} of ${px(m.viewportWidth)}`,
  );

  // The whole point of the change: one board per row, not two half-width boards.
  check(
    `${tag}: the boards are stacked full width, not side by side`,
    m.myFleet !== null && m.enemy !== null && m.enemy.top >= m.myFleet.bottom - 1,
    `fleet bottom ${px(m.myFleet?.bottom)}, enemy top ${px(m.enemy?.top)}`,
  );

  check(
    `${tag}: all 140 cells are drawn, square and at least ${floor}px`,
    m.enemyCells === 140 &&
      Math.abs(m.cellWidth - m.cellHeight) <= 1.5 &&
      m.cellWidth >= floor,
    `${m.enemyCells} cells, ${px(m.cellWidth)}×${px(m.cellHeight)} (floor ${floor}px)`,
  );

  check(
    `${tag}: the enemy strip ${vp.width < 640 ? "scrolls to the far columns" : "fits without scrolling"}`,
    m.enemy !== null &&
      (vp.width < 640
        ? m.enemy.scrollWidth > m.enemy.clientWidth + 1
        : m.enemy.scrollWidth <= m.enemy.clientWidth + 1),
    `content ${px(m.enemy?.scrollWidth)} vs strip ${px(m.enemy?.clientWidth)}`,
  );

  await page.evaluate(() => window.__bsc.scrollBoardToEnd("enemy-waters"));
  await page.waitForTimeout(150);
  const scrolled = await page.evaluate(() => window.__bsc.measure());
  check(
    `${tag}: scrolling the enemy board reaches column N on screen`,
    scrolled.lastCell !== null &&
      scrolled.lastCell.right <= (scrolled.enemy?.right ?? 0) + 1 &&
      scrolled.lastCell.right <= scrolled.viewportWidth + 1,
    `N1 ${px(scrolled.lastCell?.left)}..${px(scrolled.lastCell?.right)} in strip ${px(scrolled.enemy?.left)}..${px(scrolled.enemy?.right)}`,
  );

  // The row gutter is pinned: swiping a phone board must not hide the row
  // numbers, or a scrolled board cannot be read as a coordinate.
  check(
    `${tag}: the row numbers stay pinned to the left edge while the board scrolls`,
    scrolled.rowLabel !== null &&
      scrolled.rowLabel.left >= (scrolled.enemy?.left ?? 0) - 1 &&
      scrolled.rowLabel.right <= (scrolled.enemy?.left ?? 0) + 24,
    `row 1 ${px(scrolled.rowLabel?.left)}..${px(scrolled.rowLabel?.right)} against strip ${px(scrolled.enemy?.left)}`,
  );

  check(
    `${tag}: the viewer's own six ships are drawn on their board`,
    m.ownShipSprites === 6,
    `${m.ownShipSprites} ship sprites`,
  );

  check(
    `${tag}: the lock control is on-screen`,
    m.locked !== null && m.locked.right <= m.viewportWidth + 1 && m.locked.left >= -1,
    `lock ${px(m.locked?.left)}..${px(m.locked?.right)}`,
  );

  await page.screenshot({ path: join(SHOTS, `${vp.label}-combat.png`) });
  await page.screenshot({ path: join(SHOTS, `${vp.label}-combat-full.png`), fullPage: true });
  if (vp.width < 640) {
    await page.screenshot({ path: join(SHOTS, `${vp.label}-combat-scrolled.png`) });
  }
  await page.close();
}

check("no console / page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
