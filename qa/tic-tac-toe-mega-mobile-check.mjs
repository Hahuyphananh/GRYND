// qa/tic-tac-toe-mega-mobile-check.mjs
//
// Phone-presentation check for the Mega Tic-Tac-Toe lattice. It mounts the REAL
// MegaBoard (qa/tic-tac-toe-mega-mobile-harness.jsx) inside a copy of the REAL
// match page's width chain, together with the project's REAL Tailwind CSS
// (generated from tailwind.config.js + src/app/globals.css) — everything
// asserted here is responsive layout, so a stubbed stylesheet would make every
// assertion vacuous.
//
// The bug this guards: the lattice carried an always-on inline
// `min-width: cols * 10.5rem` — 504px at Round 3 — inside an `overflow-x-auto`
// strip. That is wider than any phone's content width, so the 9-board round
// became a horizontally-scrolling band, and because the page root is
// `overflow-x-clip` a phone could silently lose whole boards off the right edge.
//
// Asserted for every round (1 → 4 → 9 boards) at 390 / 360 / 320 px:
//   1. the page does not scroll sideways;
//   2. the lattice's own box sits inside the page gutter;
//   3. the lattice does not overflow its scroll strip (`overflow-x-auto` is a
//      safety net, not the way the 3×3 is shown) and carries no width floor;
//   4. every board is rendered, painted inside the viewport, and never overlaps
//      its neighbours;
//   5. Round 3 really is a 3×3 (three distinct rows AND three columns) — the fix
//      must fit the lattice by shrinking it, never by stacking the boards;
//   6. the cards shrink as one: the nine cells fill the card's content box
//      exactly (so nothing is clipped) and stay tappable — ≥24px, the WCAG 2.2
//      minimum target size, wherever the geometry can reach it;
//   7. the "Board N" label and its control badge stay inside the card;
//   8. a tap on a shrunken board still reports the right (boardIndex, cellIndex);
//   9. desktop is untouched;
//  10. no console / page errors.
//
// Screenshots land in qa/reports/tic-tac-toe-mobile/.
//
// Run: node qa/tic-tac-toe-mega-mobile-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(root, "qa/reports/tic-tac-toe-mobile");
mkdirSync(SHOTS, { recursive: true });
const outDir = mkdtempSync(join(tmpdir(), "grynd-ttt-mobile-"));

// ── 1. Bundle the real component ───────────────────────────────────────────
// MegaBoard imports only React, framer-motion, the board component and the pure
// `lib/tic-tac-toe` helpers, so nothing needs stubbing — but the resolver is
// kept anyway so a future import of `next/*` cannot silently break the run.
await esbuild.build({
  entryPoints: [join(root, "qa/tic-tac-toe-mega-mobile-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "qa-stubs",
      setup(build) {
        build.onResolve({ filter: /^next\/|^@clerk\/|^posthog-js\// }, (args) => ({
          path: args.path,
          namespace: "qa-bare",
        }));
        build.onLoad({ filter: /.*/, namespace: "qa-bare" }, (args) => {
          const contents =
            args.path.startsWith("@clerk/")
              ? `export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "Tester" } });
export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
export const useClerk = () => ({ signOut() {} });
export default {};`
              : args.path.startsWith("posthog-js/")
                ? `export const usePostHog = () => null; export default {};`
                : `const Null = () => null;
export const useRouter = () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} });
export const usePathname = () => "/casino/tic-tac-toe/1";
export const useSearchParams = () => new URLSearchParams();
export default Null;`;
          return { contents, loader: "js", resolveDir: root };
        });
      },
    },
  ],
});

// ── 2. Real Tailwind CSS from the project config + globals ─────────────────
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

// ── 3. Reporting helpers ───────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};
const px = (v) => (v == null ? "?" : `${Math.round(v * 10) / 10}px`);

// ── 4. Viewports ───────────────────────────────────────────────────────────
// `minCell` is the WCAG 2.2 SC 2.5.8 minimum (24 CSS px). At 320 px the
// arithmetic cannot reach it: nine boards need 3 × (3 cells + 2 gaps) + card
// padding + page gutter, and 320 px buys ~21.8 px cells. That is a physical
// limit, not a regression, so 320 asserts its own lower floor and the run
// reports the gap.
const VIEWPORTS = [
  { label: "390", width: 390, height: 844, dpr: 3, phone: true, minCell: 24 },
  { label: "360", width: 360, height: 800, dpr: 2, phone: true, minCell: 24 },
  { label: "320", width: 320, height: 568, dpr: 2, phone: true, minCell: 20 },
  { label: "1280", width: 1280, height: 900, dpr: 1, phone: false, minCell: 40 },
];

const STAGE_BOARDS = { 1: 1, 2: 4, 3: 9 };
const STAGE_COLS = { 1: 1, 2: 2, 3: 3 };

// The card's inner padding (p-1.5 → 6px, sm:p-2 → 8px) and the lattice board's
// cell gap: `compact` (rounds 2 and 3) is `gap-1 sm:gap-1.5` → 4 / 6px, while
// Round 1's lone board is `gap-2 sm:gap-3` → 8 / 12px. `sm` is 640px.
const cardMetrics = (viewportWidth, compact) => ({
  pad: viewportWidth >= 640 ? 8 : 6,
  gap: compact ? (viewportWidth >= 640 ? 6 : 4) : viewportWidth >= 640 ? 12 : 8,
});

const browser = await chromium.launch();
const consoleErrors = [];
const shots = [];

const mount = async (vp) => {
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    hasTouch: vp.phone,
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror(${vp.label}): ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // A file:// page has no network; font/asset fetches fail by construction.
    if (/Failed to load resource|fonts\.googleapis|net::ERR/.test(text)) return;
    consoleErrors.push(`console(${vp.label}): ${text}`);
  });
  await page.goto("file://" + join(outDir, "index.html").replace(/\\/g, "/"));
  await page.waitForFunction(() => !!window.__ttt?.mount, null, { timeout: 20000 });
  return page;
};

const render = async (page, stage) => {
  await page.evaluate((s) => window.__ttt.mount(s), stage);
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid^="tic-tac-toe-lattice-board-"]').length === n,
    STAGE_BOARDS[stage],
    { timeout: 15000 },
  );
  // Let framer-motion's entrance spring settle before measuring.
  await page.waitForTimeout(1100);
  return page.evaluate(() => window.__ttt.measure());
};

// ── 5. The layout assertions ───────────────────────────────────────────────
const latticeChecks = (tag, m, vp) => {
  const { lattice, scroller, boards } = m;
  const stage = m.stage;
  const expected = STAGE_BOARDS[stage];
  const cols = STAGE_COLS[stage];

  check(
    `${tag}: the page never scrolls sideways`,
    m.documentScrollWidth <= m.documentClientWidth + 1 &&
      m.page.scrollWidth <= m.page.clientWidth + 1,
    `document ${m.documentScrollWidth}/${m.documentClientWidth}, page ${m.page.scrollWidth}/${m.page.clientWidth}`,
  );

  check(`${tag}: the lattice exists and carries no width floor`, !!lattice && lattice.minWidth === "0px", `min-width ${lattice?.minWidth}`);
  if (!lattice) return;

  check(
    `${tag}: the lattice sits inside the page gutter`,
    lattice.left >= -1 && lattice.right <= m.viewportWidth + 1,
    `lattice ${px(lattice.left)}..${px(lattice.right)} of ${px(m.viewportWidth)}`,
  );

  // `overflow-x-auto` is the safety net the bug used to lean on: with the fix
  // there is nothing to scroll, so the strip's content must equal its box.
  check(
    `${tag}: the lattice never overflows its scroll strip`,
    scroller.scrollWidth <= scroller.clientWidth + 1 &&
      lattice.scrollWidth <= lattice.clientWidth + 1,
    `strip ${scroller.scrollWidth}/${scroller.clientWidth} (overflow-x ${scroller.overflowX}), lattice ${lattice.scrollWidth}/${lattice.clientWidth}`,
  );

  check(
    `${tag}: the lattice never grows past the strip it was given`,
    lattice.width <= scroller.clientWidth + 1,
    `lattice ${px(lattice.width)} vs strip ${px(scroller.clientWidth)}`,
  );
  // Round 1 keeps its 20rem ceiling, so only the wider rounds must fill.
  if (cols > 1) {
    check(
      `${tag}: the lattice fills the strip (it fits by shrinking, not by a floor)`,
      Math.abs(lattice.width - scroller.clientWidth) <= 1,
      `lattice ${px(lattice.width)} vs strip ${px(scroller.clientWidth)}`,
    );
  }

  check(
    `${tag}: all ${expected} boards are rendered`,
    boards.length === expected,
    `${boards.length} of ${expected}`,
  );

  check(
    `${tag}: every board is painted inside the viewport (none clipped off the edge)`,
    boards.length === expected &&
      boards.every((b) => b.left >= -1 && b.right <= m.viewportWidth + 1 && b.width > 0),
    boards
      .map((b) => `#${b.slot} ${px(b.left)}..${px(b.right)} (${px(b.width)}w)`)
      .join(", "),
  );

  // Group the boards into rows by their painted top, then assert the grid is
  // genuinely `cols × cols` and that no two neighbours overlap.
  const rows = [...new Set(boards.map((b) => Math.round(b.top)))].sort((a, b) => a - b);
  const columns = [...new Set(boards.map((b) => Math.round(b.left)))].sort((a, b) => a - b);
  check(
    `${tag}: the round draws a real ${cols}×${cols} lattice (not a stacked column)`,
    rows.length === cols && columns.length === cols,
    `${rows.length} rows × ${columns.length} columns, tops [${rows.map(Math.round).join(", ")}], lefts [${columns.map(Math.round).join(", ")}]`,
  );

  const overlaps = [];
  for (const top of rows) {
    const row = boards.filter((b) => Math.round(b.top) === top).sort((a, b) => a.left - b.left);
    check(
      `${tag}: row at top ${top} holds ${cols} boards, ordered and non-overlapping`,
      row.length === cols && row.every((b, i) => i === 0 || b.left >= row[i - 1].right - 0.5),
      row.map((b) => `#${b.slot} ${px(b.left)}..${px(b.right)}`).join(", "),
    );
    for (let i = 1; i < row.length; i += 1) {
      if (row[i].left < row[i - 1].right - 0.5) overlaps.push(`${row[i - 1].slot}/${row[i].slot}`);
    }
  }
  check(`${tag}: no two boards overlap`, overlaps.length === 0, overlaps.join(", "));

  // The nine cells must fill the card's content box exactly: that is what proves
  // the board shrank with the card instead of spilling out of it.
  const { pad, gap } = cardMetrics(m.viewportWidth, stage > 1);
  const expectedCell = (boards[0].width - 2 * pad - 2 * gap) / 3;
  check(
    `${tag}: each board's cells fill its card exactly (${px(pad)} padding, ${px(gap)} gap)`,
    boards.every((b) => Math.abs(b.cellWidth - expectedCell) <= 1.5),
    `cells ${boards.map((b) => px(b.cellWidth)).join("/")} vs expected ${px(expectedCell)}`,
  );

  const smallest = Math.min(...boards.map((b) => b.cellWidth));
  check(
    `${tag}: the smallest cell is still tappable (${vp.minCell}px floor)`,
    smallest >= vp.minCell - 0.5,
    `smallest cell ${px(smallest)} (floor ${vp.minCell}px)`,
  );

  check(
    `${tag}: the "Board N" label and its control badge stay inside the card`,
    boards.every((b) => b.badge && b.label && b.badge.right <= b.right + 1 && b.badge.left >= b.left - 1),
    boards
      .map((b) => `#${b.slot} badge ${px(b.badge?.left)}..${px(b.badge?.right)} in ${px(b.left)}..${px(b.right)}`)
      .join(", "),
  );

  check(
    `${tag}: the viewer can still move somewhere (cells stay playable)`,
    boards.every((b) => b.playableCells === 9),
    boards.map((b) => `#${b.slot}:${b.playableCells}`).join(" "),
  );

  return { smallest };
};

console.log("── Round 1 → 4 → 9 boards on every phone ─────────────────────────");
for (const vp of VIEWPORTS) {
  const page = await mount(vp);
  console.log(`\n▸ ${vp.label} × ${vp.height} (dpr ${vp.dpr})`);

  // Sanity: the shipped stylesheet really is in play, so the geometry below is
  // the geometry the app ships.
  const first = await render(page, 1);
  check(
    `${vp.label}: the harness carries the real page chrome and stylesheet`,
    first.page.overflowX === "clip" &&
      first.page.paddingLeft === (vp.phone ? "12px" : "24px") &&
      first.scroller.overflowX === "auto",
    `overflow-x ${first.page.overflowX}, padding-left ${first.page.paddingLeft}, strip overflow-x ${first.scroller.overflowX}`,
  );

  for (const stage of [1, 2, 3]) {
    const m = stage === 1 && first.stage === 1 ? first : await render(page, stage);
    const tag = `${vp.label} round ${stage}`;
    const measured = latticeChecks(tag, m, vp);
    if (measured) console.log(`   ${tag}: ${STAGE_BOARDS[stage]} boards, ${px(m.lattice.width)} lattice, smallest cell ${px(measured.smallest)}`);
    await page.screenshot({
      path: join(SHOTS, `${vp.label}-round${stage}.png`),
      fullPage: false,
    });
    shots.push(join(SHOTS, `${vp.label}-round${stage}.png`));
  }

  // ── The round the user reported, measured precisely ─────────────────────
  const nine = await render(page, 3);
  const nineTag = `${vp.label} round 3 (9 boards)`;
  if (vp.phone) {
    const cell = nine.boards[0].cellWidth;
    console.log(
      `   ${nineTag}: page gutter ${nine.page.paddingLeft}, card ${px(nine.boards[0].width + 2 * cardMetrics(vp.width, true).pad)}, cell ${px(cell)}`,
    );
    if (vp.minCell < 24) {
      console.log(
        `   note: at ${vp.label}px the nine-board geometry caps cells at ${px(cell)}, below the 24px WCAG 2.5.8 target — a physical limit of a 3×3-of-3×3 inside this width.`,
      );
    }
  }

  // ── A tap on a shrunken board still addresses the right cell ────────────
  await page.evaluate(() => {
    window.__ttt.plays = [];
  });
  await page.$eval('[data-testid="tic-tac-toe-lattice-board-4"] [data-testid="tic-tac-toe-cell-6"]', (el) => el.click());
  await page.waitForTimeout(200);
  const plays = await page.evaluate(() => window.__ttt.plays);
  check(
    `${vp.label}: a tap on board 5, cell 7 reports (4, 6) after shrinking`,
    plays.length === 1 && plays[0][0] === 4 && plays[0][1] === 6,
    JSON.stringify(plays),
  );

  await page.close();
}

// ── Desktop must be untouched: the boards stay big ─────────────────────────
const desktop = await mount(VIEWPORTS[3]);
const wide = await render(desktop, 3);
latticeChecks("1280 round 3", wide, VIEWPORTS[3]);
check(
  "1280: the desktop lattice still uses the full board column",
  wide.boards[0].width >= 200,
  `board width ${px(wide.boards[0].width)}`,
);
const wideRound1 = await render(desktop, 1);
check(
  "1280: Round 1 keeps its 20rem ceiling",
  wideRound1.lattice.width <= 320 + 1,
  `Round-1 lattice ${px(wideRound1.lattice.width)}`,
);
await desktop.screenshot({ path: join(SHOTS, "1280-round3.png") });
shots.push(join(SHOTS, "1280-round3.png"));
await desktop.close();

check("no page/console errors anywhere in the run", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\nScreenshots written to qa/reports/tic-tac-toe-mobile/ (${shots.length} files)`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
