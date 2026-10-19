// qa/tic-tac-toe-mega-mobile-check.mjs
//
// Phone-presentation check for the Ultimate Tic-Tac-Toe lattice. It mounts the
// REAL MegaBoard (qa/tic-tac-toe-mega-mobile-harness.jsx) inside a copy of the
// REAL match page's width chain, together with the project's REAL Tailwind CSS
// (generated from tailwind.config.js + src/app/globals.css) — everything
// asserted here is responsive layout, so a stubbed stylesheet would make every
// assertion vacuous.
//
// The bug this guards: the lattice carried an always-on inline
// `min-width: cols * 10.5rem` — 504px at nine boards — inside an `overflow-x-auto`
// strip. That is wider than any phone's content width, so the nine-board lattice
// became a horizontally-scrolling band, and because the page root is
// `overflow-x-clip` a phone could silently lose whole boards off the right edge.
//
// Ultimate Tic-Tac-Toe is a FIXED 3x3 lattice (there is no expansion, so there is
// exactly one layout to verify), asserted at 390 / 360 / 320 / 1280 px:
//   1. the page does not scroll sideways;
//   2. the lattice's own box sits inside the page gutter;
//   3. the lattice does not overflow its scroll strip (`overflow-x-auto` is a
//      safety net, not the way the 3×3 is shown) and carries no width floor;
//   4. all nine boards are rendered, painted inside the viewport, and never
//      overlap their neighbours;
//   5. it really is a 3×3 (three distinct rows AND three columns) — the fix must
//      fit the lattice by shrinking it, never by stacking the boards;
//   6. the cards shrink as one: the nine cells fill the card's content box
//      exactly (so nothing is clipped) and stay tappable — ≥24px, the WCAG 2.2
//      minimum target size, wherever the geometry can reach it;
//   7. the "Board N" label and its control badge stay inside the card;
//   8. the opening snapshot communicates FREE CHOICE (no required board);
//   9. a tap on a shrunken board still reports the right (boardIndex, cellIndex);
//  10. desktop is one screen: the page does not scroll, the match card ends
//      inside the viewport, and the lattice grew (500px at 1280×900, 400px at
//      1280×800, up from 480px / 380px);
//  11. no console / page errors.
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

// The shared cartoon outline and the two seat colours, as the browser resolves
// them. The visual checks below assert the rendered strokes, not the source.
const OUTLINE_STROKE = /rgb\(5,\s*16,\s*31\)/;
const SEAT_STROKE = /rgb\((245,\s*158,\s*11|34,\s*211,\s*238)\)/;

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

// A SHORT laptop window (1280×800 is the common one) is the viewport the height
// reserve has to be calibrated against: it is where the cap binds hardest and
// where the bottom row used to fall below the fold. Mounted separately because
// it is a sizing check, not a phone-presentation check.
const LAPTOP = { label: "1280x800", width: 1280, height: 800, dpr: 1, phone: false, minCell: 40 };

// The desktop promise is "one screen, no page scroll" at the two laptop sizes
// the match page is built for — including the wider 1440×900, where the board
// is height-capped rather than column-capped.
const WIDE = { label: "1440x900", width: 1440, height: 900, dpr: 1, phone: false, minCell: 40 };

// The transient banner (~50px) is part of the reserve: when a board resolves the
// message pushes the lattice down for two seconds, so a board sized to fit
// ONLY without it would push its bottom row under the fold right after a move.
const BANNER_CASES = [
  { vp: VIEWPORTS[3], banner: false },
  { vp: VIEWPORTS[3], banner: true },
  { vp: LAPTOP, banner: false },
  { vp: LAPTOP, banner: true },
  { vp: WIDE, banner: false },
];

/** Nine mini-boards, always: the lattice has no other shape. */
const BOARDS = 9;
const COLS = 3;

// The smallest lattice worth showing: 240px is ~24px cells, the WCAG 2.2 target
// size. Below this the one-screen promise is dropped in favour of a usable
// board, because a board that fits but cannot be tapped is not a board.
const MIN_USABLE_LATTICE_PX = 240;

// The card's own metrics, read off the component's classes: `p-1` / `sm:p-1.5`
// padding, a 1px border, and the compact board's `gap-[3px]` / `sm:gap-1` cells.
const cardMetrics = (viewportWidth) => ({
  pad: viewportWidth >= 640 ? 6 : 4,
  gap: viewportWidth >= 640 ? 4 : 3,
  border: 1,
});

const browser = await chromium.launch();
const consoleErrors = [];
const shots = [];

const mount = async (vp, { reducedMotion = false } = {}) => {
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    hasTouch: vp.phone,
  });
  // Set BEFORE navigation: `useReducedMotion` reads the preference once, when
  // the first board mounts, so emulating it afterwards would test nothing.
  if (reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
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

const render = async (page) => {
  await page.evaluate(() => window.__ttt.mount());
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid^="tic-tac-toe-lattice-board-"]').length === n,
    BOARDS,
    { timeout: 15000 },
  );
  // Let framer-motion's entrance spring settle before measuring.
  await page.waitForTimeout(1100);
  return page.evaluate(() => window.__ttt.measure());
};

// ── 5. The layout assertions ───────────────────────────────────────────────
const latticeChecks = (tag, m, vp) => {
  const { lattice, scroller, boards } = m;

  check(
    `${tag}: the page never scrolls sideways`,
    m.documentScrollWidth <= m.documentClientWidth + 1 &&
      m.page.scrollWidth <= m.page.clientWidth + 1,
    `document ${m.documentScrollWidth}/${m.documentClientWidth}, page ${m.page.scrollWidth}/${m.page.clientWidth}`,
  );

  check(
    `${tag}: the lattice exists and carries no width floor`,
    !!lattice && lattice.minWidth === "0px",
    `min-width ${lattice?.minWidth}`,
  );
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
    scroller.scrollWidth <= scroller.clientWidth + 1 && lattice.scrollWidth <= lattice.clientWidth + 1,
    `strip ${scroller.scrollWidth}/${scroller.clientWidth} (overflow-x ${scroller.overflowX}), lattice ${lattice.scrollWidth}/${lattice.clientWidth}`,
  );

  check(
    `${tag}: the lattice never grows past the strip it was given`,
    lattice.width <= scroller.clientWidth + 1,
    `lattice ${px(lattice.width)} vs strip ${px(scroller.clientWidth)}`,
  );
  // The lattice is no longer asked to fill the strip: on a desktop column it is
  // TALLER than it is wide, and a board sized by width alone pushed its bottom
  // row (and the free-choice controls under it) below the fold. It is capped by
  // the room left under the page chrome instead, so the answer here is "fits
  // inside the strip" plus "ends above the fold".
  check(
    `${tag}: the lattice fits inside the strip instead of overflowing it`,
    lattice.width <= scroller.clientWidth + 1,
    `lattice ${px(lattice.width)} vs strip ${px(scroller.clientWidth)}`,
  );
  // ONE SCREEN is the promise, but it can only be kept where the viewport has
  // the room for it: the chrome above the lattice is fixed (header, seat cards,
  // turn guidance, card padding — measured, not assumed), so on a short window
  // the choice is between a board nobody can tap and a scroll. 320×568 is that
  // case (an iPhone SE 1: ~466px of chrome leaves ~100px for nine boards), so
  // the run states the arithmetic and requires the board to hold a USABLE size
  // there instead. Everywhere the promise is achievable it stays strict.
  const roomUnderChrome = m.viewportHeight - m.chrome.aboveLattice;
  const oneScreenIsAchievable = roomUnderChrome >= MIN_USABLE_LATTICE_PX;
  check(
    `${tag}: the whole lattice ends inside the viewport (one screen, no scroll)`,
    oneScreenIsAchievable
      ? lattice.bottom <= m.viewportHeight + 1
      : lattice.width >= MIN_USABLE_LATTICE_PX,
    oneScreenIsAchievable
      ? `lattice bottom ${px(lattice.bottom)} of ${px(m.viewportHeight)}`
      : `not physically possible here: ${px(m.chrome.aboveLattice)} of chrome leaves ${px(roomUnderChrome)} for nine boards — the board keeps its usable ${px(lattice.width)} and the page scrolls`,
  );

  check(
    `${tag}: all ${BOARDS} boards are rendered`,
    boards.length === BOARDS,
    `${boards.length} of ${BOARDS}`,
  );

  check(
    `${tag}: every board is painted inside the viewport (none clipped off the edge)`,
    boards.length === BOARDS &&
      boards.every((b) => b.left >= -1 && b.right <= m.viewportWidth + 1 && b.width > 0),
    boards.map((b) => `#${b.slot} ${px(b.left)}..${px(b.right)} (${px(b.width)}w)`).join(", "),
  );

  // Group the boards into rows by their painted top, then assert the grid is
  // genuinely 3×3 and that no two neighbours overlap.
  const rows = [...new Set(boards.map((b) => Math.round(b.top)))].sort((a, b) => a - b);
  const columns = [...new Set(boards.map((b) => Math.round(b.left)))].sort((a, b) => a - b);
  check(
    `${tag}: the lattice draws a real ${COLS}×${COLS} grid (not a stacked column)`,
    rows.length === COLS && columns.length === COLS,
    `${rows.length} rows × ${columns.length} columns, tops [${rows.map(Math.round).join(", ")}], lefts [${columns.map(Math.round).join(", ")}]`,
  );

  const overlaps = [];
  for (const top of rows) {
    const row = boards.filter((b) => Math.round(b.top) === top).sort((a, b) => a.left - b.left);
    check(
      `${tag}: row at top ${top} holds ${COLS} boards, ordered and non-overlapping`,
      row.length === COLS && row.every((b, i) => i === 0 || b.left >= row[i - 1].right - 0.5),
      row.map((b) => `#${b.slot} ${px(b.left)}..${px(b.right)}`).join(", "),
    );
    for (let i = 1; i < row.length; i += 1) {
      if (row[i].left < row[i - 1].right - 0.5) overlaps.push(`${row[i - 1].slot}/${row[i].slot}`);
    }
  }
  check(`${tag}: no two boards overlap`, overlaps.length === 0, overlaps.join(", "));

  // The nine cells must fill the card's content box exactly: that is what proves
  // the board shrank with the card instead of spilling out of it.
  const { pad, gap, border } = cardMetrics(m.viewportWidth);
  const expectedCell = (boards[0].width - 2 * pad - 2 * gap - 2 * border) / 3;
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
    `${tag}: every open board still offers its nine cells`,
    boards.every((b) => b.playableCells === 9),
    boards.map((b) => `#${b.slot}:${b.playableCells}`).join(" "),
  );

  // The opening snapshot has no required destination, so the lattice must SAY
  // that any open board may be played — never leave it to inference.
  check(
    `${tag}: free choice is stated in words`,
    m.destination?.freeChoice === "true" &&
      m.destination?.required === "" &&
      /any open board/i.test(m.destination?.text ?? ""),
    `${m.destination?.required || "-"} / ${m.destination?.text?.slice(0, 60)}`,
  );

  return { smallest };
};

console.log("── The nine-board lattice on every phone ──────────────────────────");
for (const vp of VIEWPORTS) {
  const page = await mount(vp);
  console.log(`\n▸ ${vp.label} × ${vp.height} (dpr ${vp.dpr})`);

  const m = await render(page);
  // Sanity: the shipped stylesheet really is in play, so the geometry below is
  // the geometry the app ships.
  check(
    `${vp.label}: the harness carries the real page chrome and stylesheet`,
    // Desktop locks BOTH axes (`lg:overflow-hidden`) so the fixed-height page
    // can never scroll; phones keep the older `overflow-x: clip`.
    (m.page.overflowX === "clip" || m.page.overflowX === "hidden") &&
      m.page.paddingLeft === (vp.phone ? "12px" : "24px") &&
      m.scroller.overflowX === "auto",
    `overflow-x ${m.page.overflowX}, padding-left ${m.page.paddingLeft}, strip overflow-x ${m.scroller.overflowX}`,
  );

  const measured = latticeChecks(`${vp.label} lattice`, m, vp);
  if (measured) {
    console.log(
      `   ${vp.label}: ${BOARDS} boards, ${px(m.lattice.width)} lattice, smallest cell ${px(measured.smallest)}`,
    );
  }
  if (vp.phone) {
    const cell = m.boards[0].cellWidth;
    console.log(
      `   ${vp.label}: page gutter ${m.page.paddingLeft}, card ${px(m.boards[0].width + 2 * cardMetrics(vp.width).pad)}, cell ${px(cell)}`,
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

  await page.screenshot({ path: join(SHOTS, `${vp.label}-lattice.png`), fullPage: false });
  shots.push(join(SHOTS, `${vp.label}-lattice.png`));
  await page.close();
}

// ── The bottom row is playable without a scroll, banner or not ─────────────
// The one promise the height cap exists for, measured against the REAL chrome:
// the lattice's bottom edge must end inside the viewport, so the player never
// has to scroll mid-turn to reach the bottom row. Checked with the transient
// "claims the board" banner mounted too. On a viewport where the promise is
// physically impossible — the chrome alone (header + seats + guidance + card
// padding) plus the smallest usable board is already taller than the window —
// the run says so and asserts the honest alternative instead of inventing a
// pass (320×568 is that case: see the note printed by its own block).
console.log("\n── The bottom row, on a laptop, with and without the transient banner ──");
for (const { vp, banner } of BANNER_CASES) {
  const page = await mount(vp);
  await page.evaluate(
    (opts) => window.__ttt.mount("opening", opts),
    { banner },
  );
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid^="tic-tac-toe-lattice-board-"]').length === n,
    9,
    { timeout: 15000 },
  );
  await page.waitForTimeout(1100);
  const m = await page.evaluate(() => window.__ttt.measure());
  const tag = `${vp.label}${banner ? " + banner" : ""}`;
  // The board must also actually be bigger than it was before the reserve was
  // calibrated (455px at 1280×900), otherwise the banner case is trivially
  // green because the board never grew.
  check(
    `${tag}: the lattice's bottom edge ends inside the viewport (no scroll to reach the last row)`,
    m.lattice.bottom <= m.viewportHeight + 1,
    `lattice bottom ${px(m.lattice.bottom)} of ${px(m.viewportHeight)} — chrome above ${px(m.chrome.aboveLattice)}, board ${px(m.lattice.width)}${banner ? `, banner ${px(m.chrome.banner)}` : ""}`,
  );
  // The page itself must fit too: the whole match card ends inside the
  // viewport, so scrolling is never needed while the board is being recorded.
  check(
    `${tag}: the match card ends inside the viewport`,
    m.card !== null && m.card.bottom <= m.viewportHeight + 1,
    `card bottom ${px(m.card?.bottom)} of ${px(m.viewportHeight)}`,
  );
  check(
    `${tag}: the match page does not scroll vertically`,
    m.documentScrollHeight <= m.viewportHeight + 1,
    `document ${px(m.documentScrollHeight)} vs viewport ${px(m.viewportHeight)}`,
  );
  // Every board the check was previously capped at: the reserve used to be
  // 420px, so the same viewport now has to produce a bigger lattice.
  const wasWidth = vp.height - 420;
  if (!banner) {
    // At 900px the 40px desktop target still holds; a 1280×800 window has less
    // height to give, so its floor is the 32px it already cleared before.
    const cellFloor = vp.height >= 900 ? 40 : 32;
    check(
      `${tag}: the boards grew, and every cell still clears the ${cellFloor}px target`,
      m.lattice.width > wasWidth && Math.round(m.boards[0].cellWidth) >= cellFloor,
      `lattice ${px(m.lattice.width)} (was ${px(wasWidth)}), smallest cell ${px(m.boards[0].cellWidth)}`,
    );
  }
  await page.screenshot({ path: join(SHOTS, `${vp.label}${banner ? "-banner" : ""}-fold.png`), fullPage: false });
  shots.push(join(SHOTS, `${vp.label}${banner ? "-banner" : ""}-fold.png`));
  await page.close();
}

// ── Desktop must be untouched: the boards stay big ─────────────────────────
const desktop = await mount(VIEWPORTS[3]);
const wide = await render(desktop);
latticeChecks("1280 lattice", wide, VIEWPORTS[3]);
// Desktop is capped by HEIGHT now, not by the column: the boards shrink just
// enough to keep the whole lattice on one screen, and not beyond that — a
// readable board is the point of the cap, so a floor is asserted too.
check(
  "1280: the desktop lattice stays a readable size after the height cap",
  wide.boards[0].width >= 140,
  `board width ${px(wide.boards[0].width)}`,
);
await desktop.close();

// ── The states the live page can show ──────────────────────────────────────
// Layout is only half the board: the destination, free choice, ownership and
// the terminal line are what the interface has to SAY. Each scenario mounts the
// real MegaBoard with a server-produced snapshot.
const renderScenario = async (page, name) => {
  await page.evaluate((scenario) => window.__ttt.mount(scenario), name);
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid^="tic-tac-toe-lattice-board-"]').length === n,
    BOARDS,
    { timeout: 15000 },
  );
  // The cards animate in once; wait for the spring, never for a move.
  await page.waitForTimeout(650);
  return page.evaluate(() => {
    const mega = document.querySelector('[data-testid="tic-tac-toe-mega"]');
    const dest = document.querySelector('[data-testid="lattice-destination"]');
    const cards = [...document.querySelectorAll('[data-testid^="tic-tac-toe-lattice-board-"]')].map((card) => ({
      slot: Number((card.getAttribute("data-testid") ?? "").split("-").pop()),
      state: card.getAttribute("data-state"),
      control: card.getAttribute("data-control"),
      required: card.getAttribute("data-required"),
      selectable: card.getAttribute("data-selectable"),
      latticeLine: card.getAttribute("data-lattice-line"),
      playableCells: card.querySelectorAll('[data-playable="true"]').length,
      marks: card.querySelectorAll('button[data-state="X"], button[data-state="O"]').length,
      badge: card.querySelector('[data-testid^="lattice-board-badge-"]')?.textContent?.trim() ?? "",
      // The claimed-board overlay: what it says, whether it is inert, whether it
      // really covers the board, and how big the outcome glyph is drawn.
      overlay: (() => {
        const el = card.querySelector('[data-testid^="lattice-board-overlay-"]');
        if (!el) return null;
        // "The board" is the 3x3 cell grid, not the card chrome: the overlay
        // covers the playfield while the card's own label and badge stay
        // readable above it.
        const grid = card.querySelector('[data-testid="tic-tac-toe-board"]');
        const target = (grid ?? card).getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const glyph = el.querySelector("svg")?.getBoundingClientRect() ?? null;
        return {
          outcome: el.getAttribute("data-outcome"),
          inert: getComputedStyle(el).pointerEvents === "none",
          covers:
            box.left <= target.left + 1 &&
            box.right >= target.right - 1 &&
            box.top <= target.top + 1 &&
            box.bottom >= target.bottom - 1,
          glyphRatio: glyph ? glyph.width / box.width : 0,
        };
      })(),
    }));
    const cells = [...document.querySelectorAll('[data-testid^="tic-tac-toe-cell-"]')];
    // The drawn win line and the marks' own strokes: the visual contract asserts
    // the outline-under-colour two-pass art and the line through the won cells,
    // not just their attributes.
    const winLines = [...document.querySelectorAll('[data-testid="tic-tac-toe-win-line"]')].map((svg) => {
      const card = svg.closest('[data-testid^="tic-tac-toe-lattice-board-"]');
      const cardBox = card.getBoundingClientRect();
      const box = svg.getBoundingClientRect();
      const lines = [...svg.querySelectorAll("line")];
      return {
        slot: Number((card.getAttribute("data-testid") ?? "").split("-").pop()),
        strokes: lines.map((line) => getComputedStyle(line).stroke),
        inside:
          box.left >= cardBox.left - 1 &&
          box.right <= cardBox.right + 1 &&
          box.top >= cardBox.top - 1 &&
          box.bottom <= cardBox.bottom + 1,
        span: lines.map((line) => {
          const r = line.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        }),
      };
    });
    const marks = cells
      .filter((cell) => ["X", "O"].includes(cell.getAttribute("data-state")))
      .map((cell) => {
        const svg = cell.querySelector("svg");
        return {
          state: cell.getAttribute("data-state"),
          strokes: svg ? [...svg.querySelectorAll("g")].map((g) => getComputedStyle(g).stroke) : [],
        };
      });
    return {
      winLines,
      marks,
      requiredBoard: mega?.getAttribute("data-required-board"),
      freeChoice: mega?.getAttribute("data-free-choice"),
      destination: dest
        ? {
            text: dest.textContent?.trim() ?? "",
            required: dest.getAttribute("data-required"),
            freeChoice: dest.getAttribute("data-free-choice"),
          }
        : null,
      winLineText: document.querySelector('[data-testid="mega-win-line"]')?.textContent?.trim() ?? "",
      svgLine: !!document.querySelector('[data-testid="mega-winning-line"]'),
      cards,
      cells: cells.length,
      focusableCells: cells.filter((c) => c.tabIndex >= 0 && !c.disabled).length,
      playableTotal: cells.filter((c) => c.getAttribute("data-playable") === "true").length,
    };
  });
};

const scenarioPage = await mount(VIEWPORTS[0]);
console.log("\n── Turn guidance, board states and keyboard play ─────────────────");

// 1. The forced destination: ONE board, said in words.
const requiredState = await renderScenario(scenarioPage, "required");
check(
  "states: the required destination is exactly one board, and it is board 5",
  requiredState.requiredBoard === "4" &&
    requiredState.cards.filter((c) => c.required === "true").length === 1 &&
    requiredState.cards.find((c) => c.required === "true")?.slot === 4,
  `required ${requiredState.requiredBoard}, flagged ${requiredState.cards
    .filter((c) => c.required === "true")
    .map((c) => c.slot)
    .join(",")}`,
);
check(
  "states: the destination is stated in words, from the server's own slot",
  requiredState.destination.required === "4" &&
    requiredState.destination.freeChoice === "false" &&
    /required/i.test(requiredState.destination.text) &&
    /centre/i.test(requiredState.destination.text),
  `${requiredState.destination.required} / ${requiredState.destination.text?.slice(0, 60)}`,
);
// The same rule with a different destination: the copy must follow it, which is
// only possible if it is derived rather than hardcoded.
const cornerState = await renderScenario(scenarioPage, "requiredTopLeft");
check(
  "states: a different destination produces different words and a different board",
  cornerState.requiredBoard === "0" &&
    cornerState.cards.find((c) => c.required === "true")?.slot === 0 &&
    /top-left/i.test(cornerState.destination.text) &&
    cornerState.destination.text !== requiredState.destination.text,
  `"${cornerState.destination.text?.slice(0, 40)}" vs "${requiredState.destination.text?.slice(0, 40)}"`,
);
// Back to board 5 for the keyboard run below.
await renderScenario(scenarioPage, "required");
check(
  "states: only the required board offers cells; the other eight are inert",
  requiredState.playableTotal === 9 &&
    requiredState.cards.filter((c) => c.selectable === "true").length === 1 &&
    requiredState.cards.find((c) => c.slot === 4)?.playableCells === 9 &&
    requiredState.cards.filter((c) => c.slot !== 4).every((c) => c.playableCells === 0),
  `${requiredState.playableTotal} playable cells, ${
    requiredState.cards.filter((c) => c.selectable === "true").length
  } selectable boards`,
);
await scenarioPage.screenshot({ path: join(SHOTS, "state-required.png") });
shots.push(join(SHOTS, "state-required.png"));

// 2. Keyboard: a cell is reachable with Tab, and Enter places the mark.
await scenarioPage.evaluate(() => {
  window.__ttt.plays = [];
});
let focusedCell = null;
let tabs = 0;
for (; tabs < 60 && !focusedCell; tabs += 1) {
  await scenarioPage.keyboard.press("Tab");
  focusedCell = await scenarioPage.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active.getAttribute("data-playable") !== "true") return null;
    const card = active.closest('[data-testid^="tic-tac-toe-lattice-board-"]');
    return {
      slot: Number((card?.getAttribute("data-testid") ?? "").split("-").pop()),
      cell: Number((active.getAttribute("data-testid") ?? "").split("-").pop()),
      label: active.getAttribute("aria-label") ?? "",
    };
  });
}
check(
  "keyboard: Tab reaches a playable cell inside the required board",
  focusedCell !== null && focusedCell.slot === 4,
  `${tabs} tabs → ${
    focusedCell ? `board ${focusedCell.slot + 1}, cell ${focusedCell.cell + 1}` : "no playable cell focused"
  }`,
);
check(
  "keyboard: every cell stays focusable, and each is labelled on its own terms",
  requiredState.focusableCells === 81 &&
    requiredState.cells === 81 &&
    /Row \d, column \d/.test(focusedCell?.label ?? ""),
  `${requiredState.focusableCells} of ${requiredState.cells} focusable — "${focusedCell?.label ?? ""}"`,
);
// Keyboard parity with the pointer: focusing an offered cell previews the mark
// (a SHAPE cue), instead of only recolouring the cell.
await scenarioPage.waitForTimeout(200);
const ghostOpacity = await scenarioPage.evaluate(() => {
  const active = document.activeElement;
  const ghost = active?.querySelector?.('[data-testid="tic-tac-toe-mark-preview"]');
  return ghost ? Number.parseFloat(getComputedStyle(ghost).opacity) : null;
});
check(
  "keyboard: focusing a playable cell previews the mark, not just a colour change",
  ghostOpacity !== null && ghostOpacity > 0.2,
  `ghost opacity ${ghostOpacity}`,
);
await scenarioPage.keyboard.press("Enter");
await scenarioPage.waitForTimeout(150);
const afterEnter = await scenarioPage.evaluate(() => window.__ttt.plays.length);
await scenarioPage.keyboard.press("Space");
await scenarioPage.waitForTimeout(150);
const keyboardPlays = await scenarioPage.evaluate(() => window.__ttt.plays);
check(
  "keyboard: Enter and Space both place the mark on the focused cell",
  afterEnter === 1 &&
    keyboardPlays.length === 2 &&
    keyboardPlays.every(([board, cell]) => board === 4 && cell === focusedCell?.cell),
  JSON.stringify(keyboardPlays),
);
check(
  "keyboard: keys never send a move outside the required board",
  keyboardPlays.every(([board]) => board === 4),
  JSON.stringify(keyboardPlays),
);

// 3. A resolved destination: free choice, said in words, for every open board.
const freeState = await renderScenario(scenarioPage, "resolved");
check(
  "states: a resolved destination turns into free choice for every open board",
  freeState.requiredBoard === "" &&
    freeState.cards.every((c) => c.required === "false") &&
    freeState.freeChoice === "true" &&
    freeState.destination.freeChoice === "true" &&
    /any open board/i.test(freeState.destination.text),
  `required "${freeState.requiredBoard}" / free ${freeState.freeChoice} / ${freeState.destination.text?.slice(0, 60)}`,
);
check(
  "states: free choice offers exactly the eight unfinished boards",
  freeState.cards.filter((c) => c.selectable === "true").length === 8 &&
    freeState.cards.find((c) => c.slot === 4)?.selectable === "false" &&
    freeState.playableTotal === 72,
  `${
    freeState.cards.filter((c) => c.selectable === "true").length
  } selectable boards, ${freeState.playableTotal} playable cells`,
);

// 4. Ownership: X, O and a draw are distinguishable, and no mark is covered.
const ownedState = await renderScenario(scenarioPage, "claimed");
const ownedBy = (slot) => ownedState.cards.find((c) => c.slot === slot);
check(
  "states: a won mini-board names its owner, without hiding its marks",
  ownedBy(0).control === "X" &&
    ownedBy(0).state === "won-x" &&
    ownedBy(0).badge === "X" &&
    ownedBy(0).marks === 3 &&
    ownedBy(2).control === "O" &&
    ownedBy(2).state === "won-o" &&
    ownedBy(2).badge === "O" &&
    ownedBy(2).marks === 3,
  `#1 ${ownedBy(0).state}/${ownedBy(0).badge}/${ownedBy(0).marks} marks, #3 ${ownedBy(2).state}/${
    ownedBy(2).badge
  }/${ownedBy(2).marks} marks`,
);
// A resolved board is COVERED, not merely tinted: the overlay spans the card,
// it is inert (the cells underneath never lose a click), and the outcome mark is
// drawn huge — the point is to read "this board is gone" from across the room.
const covered = [ownedBy(0), ownedBy(2), ownedBy(1)];
check(
  "states: every resolved mini-board carries a covering outcome overlay",
  covered.every((c) => c.overlay && c.overlay.covers && c.overlay.inert),
  covered
    .map((c) => (c.overlay ? `#${c.slot} ${c.overlay.outcome} covers=${c.overlay.covers} inert=${c.overlay.inert}` : `#${c.slot} MISSING`))
    .join(", "),
);
check(
  "states: a won mini-board's overlay is its owner's mark, drawn huge",
  ownedBy(0).overlay?.outcome === "X" &&
    ownedBy(2).overlay?.outcome === "O" &&
    ownedBy(0).overlay.glyphRatio >= 0.6 &&
    ownedBy(2).overlay.glyphRatio >= 0.6,
  `#1 ${ownedBy(0).overlay?.outcome} ${Math.round((ownedBy(0).overlay?.glyphRatio ?? 0) * 100)}%, #3 ${
    ownedBy(2).overlay?.outcome
  } ${Math.round((ownedBy(2).overlay?.glyphRatio ?? 0) * 100)}%`,
);
check(
  "states: a drawn mini-board says so in its overlay",
  ownedBy(1).overlay?.outcome === "draw",
  `#2 ${ownedBy(1).overlay?.outcome ?? "missing"}`,
);
check(
  "states: an open board is never covered by an outcome overlay",
  [3, 4, 5, 6, 7, 8].every((slot) => ownedBy(slot)?.overlay === null),
  ownedState.cards.filter((c) => c.overlay).map((c) => c.slot).join(",") || "none",
);

check(
  "states: a drawn mini-board is locked and every one of its nine marks survives",
  ownedBy(1).control === "draw" &&
    ownedBy(1).state === "drawn" &&
    /draw/i.test(ownedBy(1).badge) &&
    ownedBy(1).marks === 9 &&
    ownedBy(1).playableCells === 0,
  `#2 ${ownedBy(1).state}/${ownedBy(1).badge}/${ownedBy(1).marks} marks, ${ownedBy(1).playableCells} playable`,
);
check(
  "states: a resolved board never offers a move of its own",
  ownedBy(0).playableCells === 0 && ownedBy(2).playableCells === 0,
  `#1 ${ownedBy(0).playableCells}, #3 ${ownedBy(2).playableCells}`,
);
check(
  "visual: every placed mark is drawn twice — the shared dark outline under the seat colour",
  ownedState.marks.length === 15 &&
    ownedState.marks.every(
      (mark) => mark.strokes.some((s) => OUTLINE_STROKE.test(s)) && mark.strokes.some((s) => SEAT_STROKE.test(s)),
    ),
  `${ownedState.marks.length} marks, e.g. ${JSON.stringify(ownedState.marks[0]?.strokes)}`,
);
check(
  "visual: each won mini-board draws a line across its own three winning cells",
  ownedState.winLines.length === 2 &&
    ownedState.winLines.every(
      (line) =>
        line.strokes.length === 2 &&
        line.strokes.some((s) => OUTLINE_STROKE.test(s)) &&
        line.strokes.some((s) => SEAT_STROKE.test(s)) &&
        line.inside &&
        line.span.every((s) => s.w > 4 || s.h > 4),
    ),
  `lines on ${ownedState.winLines.map((l) => l.slot + 1).join(",")} — ${JSON.stringify(
    ownedState.winLines.map((l) => l.span),
  )}`,
);
await scenarioPage.screenshot({ path: join(SHOTS, "state-claimed.png") });
shots.push(join(SHOTS, "state-claimed.png"));

// 5. The terminal result: three boards ringed, a drawn line, no move offered.
const finishedState = await renderScenario(scenarioPage, "finished");
check(
  "states: the winning three boards are marked as the lattice line",
  finishedState.cards.filter((c) => c.latticeLine === "true").length === 3 &&
    [0, 4, 8].every((slot) => finishedState.cards.find((c) => c.slot === slot)?.latticeLine === "true"),
  `line on ${finishedState.cards
    .filter((c) => c.latticeLine === "true")
    .map((c) => c.slot + 1)
    .join(",")}`,
);
check(
  "states: the result banner names the line and the winner",
  /wins the match/i.test(finishedState.winLineText) &&
    /Board 1/.test(finishedState.winLineText) &&
    finishedState.svgLine,
  `"${finishedState.winLineText.replace(/\s+/g, " ").slice(0, 80)}", svg ${finishedState.svgLine}`,
);
check(
  "states: a finished match offers no cells at all",
  finishedState.playableTotal === 0 &&
    finishedState.cards.every((c) => c.playableCells === 0) &&
    finishedState.cards.length === 9,
  `${finishedState.playableTotal} playable cells across ${finishedState.cards.length} boards`,
);
check(
  "visual: the finished match draws a line in each of the three claimed boards",
  finishedState.winLines.length === 3 &&
    finishedState.winLines.every(
      (line) => line.inside && line.span.some((s) => s.w > 4 || s.h > 4),
    ),
  `lines on ${finishedState.winLines.map((l) => l.slot + 1).join(",")}`,
);
await scenarioPage.screenshot({ path: join(SHOTS, "state-finished.png") });
shots.push(join(SHOTS, "state-finished.png"));
await scenarioPage.close();

// ── Reduced motion: the same board, without the springs ────────────────────
// `prefers-reduced-motion` must remove the entrance animation, not the game: a
// player who asked for less motion has to be able to move on the first frame.
const calmPage = await mount(VIEWPORTS[0], { reducedMotion: true });
await calmPage.evaluate(() => window.__ttt.mount("required"));
await calmPage.waitForFunction(
  (n) => document.querySelectorAll('[data-testid^="tic-tac-toe-lattice-board-"]').length === n,
  BOARDS,
  { timeout: 15000 },
);
// Deliberately short: the entrance spring would still be in flight at 120 ms.
await calmPage.waitForTimeout(120);
const calm = await calmPage.evaluate(() => {
  const cards = [...document.querySelectorAll('[data-testid^="tic-tac-toe-lattice-board-"]')];
  const cells = [...document.querySelectorAll('[data-testid^="tic-tac-toe-cell-"]')];
  return {
    cards: cards.length,
    playable: cells.filter((c) => c.getAttribute("data-playable") === "true").length,
    unsettled: cards
      .map((card, slot) => {
        const style = getComputedStyle(card);
        const ok = style.opacity === "1" && (style.transform === "none" || style.transform === "matrix(1, 0, 0, 1, 0, 0)");
        return ok ? null : `#${slot + 1} opacity ${style.opacity} transform ${style.transform}`;
      })
      .filter(Boolean),
    animated: cells.some((c) => getComputedStyle(c).animationName !== "none"),
  };
});
check(
  "reduced motion: cards paint fully at once instead of animating in",
  calm.cards === 9 && calm.unsettled.length === 0,
  `${calm.cards} cards, ${calm.unsettled.length} unsettled${calm.unsettled.length ? " — " + calm.unsettled.join("; ") : ""}`,
);
check(
  "reduced motion: the required board is playable on the first frame",
  calm.playable === 9,
  `${calm.playable} playable cells 120ms after mount`,
);
let calmFocused = null;
let calmTabs = 0;
for (; calmTabs < 60 && !calmFocused; calmTabs += 1) {
  await calmPage.keyboard.press("Tab");
  calmFocused = await calmPage.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active.getAttribute("data-playable") !== "true") return null;
    const card = active.closest('[data-testid^="tic-tac-toe-lattice-board-"]');
    return {
      slot: Number((card?.getAttribute("data-testid") ?? "").split("-").pop()),
      cell: Number((active.getAttribute("data-testid") ?? "").split("-").pop()),
    };
  });
}
await calmPage.evaluate(() => {
  window.__ttt.plays = [];
});
await calmPage.keyboard.press("Enter");
await calmPage.waitForTimeout(80);
const calmPlays = await calmPage.evaluate(() => window.__ttt.plays);
check(
  "reduced motion: a legal move is accepted with no animation delay",
  calmFocused?.slot === 4 &&
    calmPlays.length === 1 &&
    calmPlays[0][0] === 4 &&
    calmPlays[0][1] === calmFocused?.cell,
  JSON.stringify(calmPlays),
);
await calmPage.screenshot({ path: join(SHOTS, "state-reduced-motion.png") });
shots.push(join(SHOTS, "state-reduced-motion.png"));
await calmPage.close();

check("no page/console errors anywhere in the run", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\nScreenshots written to qa/reports/tic-tac-toe-mobile/ (${shots.length} files)`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
