// qa/roulette-mobile-check.mjs
//
// Phone-presentation check for the Roulette PvP match page. It mounts the REAL
// page (qa/roulette-reveal-harness.jsx → src/app/casino/roulette/[matchId]/
// PageClient.jsx) together with the project's REAL Tailwind CSS (generated from
// tailwind.config.js + src/**), because everything asserted here is responsive
// layout — a stubbed stylesheet would make every assertion vacuous.
//
//   1. Phone column order: the wheel is inside the first screen and ABOVE the
//      (tall) control sidebar, which follows it.
//   2. Tappable board: 6 columns of >= 44 px tiles at 360/390 px, the outside
//      bets >= 40 px tall, and no horizontally scrolling sub-board (the old
//      `min-w-[320px]` + `overflow-x-auto` grid).
//   3. Locked state: chips stay visible (no dimming), tiles are genuinely
//      disabled, and the mobile "Bets locked" cue shows right above the board.
//   4. The canvas keeps the Step 4 DPR-aware backing store and its CSS box
//      never moves across lock → release → spin → landing (no layout shift).
//   5. ONE SCREEN at 360 × 640: the wheel AND the whole number board (0 + 36)
//      end above the fold, with the fixed 64 px navbar cleared.
//   6. Touch chip clearing: the staged chip is its own touch target (hit-tested
//      with elementFromPoint, including 4 px outside the visible pill) and
//      tapping it removes ONLY that bet — the touch equivalent of right-click.
//      Tapping the tile body still bets, and a locked chip cannot be removed.
//   7. Desktop (SM+) is untouched: sidebar on the left, the classic 12 × 3
//      board reading 1,4,7 …, the "Last spin" strip, and the mobile-only cue
//      hidden.
//   8. Creator Mode's phone stacking still wins inside the recording frame
//      (`data-creator-phone` CSS forces the column + gameplay-first order over
//      the new mobile `flex-col-reverse`).
//
// The fixed navbar is stubbed with a stand-in carrying the REAL component's
// classes (`fixed … h-16 sm:h-20 md:h-24`), because the harness replaces
// <NavigationBar /> with a passthrough — the audit is about the page's top
// padding clearing that fixed bar.
//
// Run: node qa/roulette-mobile-check.mjs

import esbuild from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "tailwindcss";
import postcss from "postcss";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. Bundle the real page (same stub set as the other roulette checks) ────
const shell = (extra) => `import { createElement, Fragment } from "react";
const Passthrough = (p) => createElement(Fragment, null, p ? p.children : null);
const Null = () => null;
${extra}`;

const NEXT_STUBS = {
  "next/navigation": shell(`export const useRouter = () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} });
export const useParams = () => ({ matchId: "1" });
export const usePathname = () => "/casino/roulette/1";
export const useSearchParams = () => new URLSearchParams();
export const redirect = () => {};
export const notFound = () => {};
export default { useRouter, useParams, usePathname, useSearchParams };`),
  "next/image": shell(`export default Null;`),
  "next/link": shell(`export default Passthrough;`),
  "next/dynamic": shell(`export default () => Null;`),
  "next/font/google": shell(`export const Inter = () => ({ className: "" }); export default {};`),
  "next/font/local": shell(`export default () => ({ className: "" });`),
};

const CLERK_STUB = shell(`export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "Tester", fullName: "Tester" } });
export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
export const useClerk = () => ({ signOut() {} });
export const SignedIn = Passthrough;
export const SignedOut = Null;
export const ClerkProvider = Passthrough;
export const RedirectToSignIn = Null;
export default { useUser, useAuth, useClerk };`);

const APP_STUBS = new Map([
  ["components/navigation-bar", shell(`export default Passthrough;`)],
  ["components/IconAvatar", shell(`export default Passthrough;`)],
  ["components/ReportModal", shell(`export default Passthrough;`)],
  ["components/game/EmotePicker", shell(`export default Passthrough; export const EmoteArtwork = Passthrough;`)],
  ["components/creator-mode/CreatorModeHost", shell(`export default Passthrough;`)],
  ["components/creator-mode/CreatorModeLayout", shell(`export const CreatorResponsiveLayout = Passthrough; export default Passthrough;`)],
  ["components/lobby/MatchWaiting", shell(`export default Passthrough;`)],
  ["components/result/PvpResultScreen", shell(`export default Passthrough;`)],
  ["context/SocketProvider", shell(`export const useSocket = () => ({ socket: null }); export const SocketProvider = Passthrough;`)],
  ["lib/gameAudio", shell(`export const playVictory = () => {}; export const playDefeat = () => {}; export const playTick = () => {}; export const playCardPlace = () => {};`)],
]);

const outDir = mkdtempSync(join(tmpdir(), "roulette-mobile-"));
await esbuild.build({
  entryPoints: [join(root, "qa/roulette-reveal-harness.jsx")],
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
        build.onResolve({ filter: /^next\/|^@clerk\/|^posthog-js\// }, (args) => ({ path: args.path, namespace: "qa-bare" }));
        build.onLoad({ filter: /.*/, namespace: "qa-bare" }, (args) => {
          const js = (contents) => ({ contents, loader: "js", resolveDir: root });
          if (NEXT_STUBS[args.path]) return js(NEXT_STUBS[args.path]);
          if (args.path.startsWith("@clerk/")) return js(CLERK_STUB);
          if (args.path.startsWith("posthog-js/"))
            return js(shell(`export const usePostHog = () => null; export default {};`));
          return js(shell(`export default Null;`));
        });
        for (const tail of APP_STUBS.keys()) {
          const escaped = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          build.onResolve({ filter: new RegExp(`${escaped}$`) }, () => ({ path: tail, namespace: "qa-app" }));
        }
        build.onLoad({ filter: /.*/, namespace: "qa-app" }, (args) => ({
          contents: APP_STUBS.get(args.path),
          loader: "js",
          resolveDir: root,
        }));
        build.onLoad({ filter: /\.(png|jpe?g|webp|gif|svg)$/ }, () => ({
          contents: `export default { src: "/images/smalllogo.png", width: 612, height: 408 };`,
          loader: "js",
        }));
      },
    },
  ],
});

// ── 2. Real Tailwind CSS from the project config + the creator frame CSS ────
const generated = await postcss([
  tailwind(join(root, "tailwind.config.js")),
]).process("@tailwind base;\n@tailwind components;\n@tailwind utilities;\n", {
  from: join(root, "src/app/globals.css"),
});
const globals = readFileSync(join(root, "src/app/globals.css"), "utf8");
const creatorStart = globals.indexOf("[data-creator-phone] [data-creator-stack]");
const creatorEnd = globals.indexOf("@media (prefers-reduced-motion", creatorStart);
if (creatorStart < 0) throw new Error("creator phone-stacking CSS not found in globals.css");
writeFileSync(join(outDir, "tw.css"), generated.css + "\n" + globals.slice(creatorStart, creatorEnd));
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<nav id="qa-nav" class="fixed top-0 left-0 right-0 z-40 border-b border-[#00e5ff]/40 bg-[#050b1e]/75">
  <div class="flex h-16 items-center justify-between gap-2 sm:h-20 md:h-24"><span>nav</span></div>
</nav>
<div id="creatorPhone"><div id="root"></div></div>
<script src="./harness.js"></script></body></html>`,
);

// ── 3. Assertions ───────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};
const px = (v) => (v == null ? "?" : `${Math.round(v)}px`);

const measure = () =>
  page.evaluate(() => {
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const ownLabel = (b) =>
      b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild.textContent.trim() : "";
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        w: r.width,
        h: r.height,
      };
    };
    const buttons = [...document.querySelectorAll("button")];
    // Number tiles are the buttons whose label owns the button's first text
    // node AND whose parent is the board grid (the chip-value buttons are
    // numeric too, but they live in a flex row).
    const tiles = buttons.filter(
      (b) =>
        /^\d{1,2}$/.test(ownLabel(b)) &&
        getComputedStyle(b.parentElement).display === "grid",
    );
    const rectOf = (t) => t.getBoundingClientRect();
    const rowKeys = [
      ...new Set(tiles.map((t) => Math.round(rectOf(t).top))),
    ].sort((a, b) => a - b);
    const colKeys = [
      ...new Set(tiles.map((t) => Math.round(rectOf(t).left))),
    ].sort((a, b) => a - b);
    const row = (key) =>
      tiles
        .filter((t) => Math.round(rectOf(t).top) === key)
        .sort((a, b) => rectOf(a).left - rectOf(b).left)
        .map((t) => Number(ownLabel(t)));
    const col = (key) =>
      tiles
        .filter((t) => Math.round(rectOf(t).left) === key)
        .sort((a, b) => rectOf(a).top - rectOf(b).top)
        .map((t) => Number(ownLabel(t)));

    const canvas = document.querySelector("canvas");
    const canvasBox = box(canvas);
    const gridEl = tiles.length ? tiles[0].parentElement : null;
    const chipTitle = [...document.querySelectorAll("p")].find((p) =>
      /^Chip value/.test(txt(p) || ""),
    );
    const sidebarTitle = [...document.querySelectorAll("h1")].find((h) =>
      /Roulette/.test(txt(h) || ""),
    );
    // The badge's span also owns an inline SVG (whose <title> is part of
    // textContent), so match on the span's own DIRECT text node.
    const ownText = (el) =>
      [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(" ")
        .trim();
    const badge = [...document.querySelectorAll("span")].find((s) =>
      /^Bets locked/.test(ownText(s)),
    );
    // The fixed navbar stand-in (real navbar classes) + the "Last spin" strip.
    const nav = document.getElementById("qa-nav");
    const navBox = nav ? box(nav) : null;
    const strip = [...document.querySelectorAll("span")].find((s) =>
      /^Last spin/.test(ownText(s)),
    );
    // The chip's × hint is `sm:hidden` — it is in the DOM at every width, so
    // visibility (client rects) is what matters, not textContent.
    const chipHintVisible = [...document.querySelectorAll("[data-bet-chip] > span")].some(
      (s) => s.getClientRects().length > 0,
    );
    const tile17 = tiles.find((t) => ownLabel(t) === "17");
    const chip17 = tile17 ? tile17.querySelector("[data-bet-chip]") : null;
    const lockedBar = [...document.querySelectorAll("div")].find(
      (d) => /^Bets locked\. Waiting for opponent/.test(txt(d) || ""),
    );
    const statusSpan = [...document.querySelectorAll("span")].find((s) =>
      /^(Spinning…|Last spin )/.test(txt(s) || ""),
    );
    const zones = buttons.filter((b) =>
      /^(1-12|13-24|25-36|1-18|19-36|Even|Odd|Red|Black|Green)$/.test(txt(b) || ""),
    );

    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      tileCount: tiles.length,
      tileColumns: rowKeys.length ? row(rowKeys[0]).length : 0,
      firstRow: rowKeys.length ? row(rowKeys[0]) : [],
      firstCol: colKeys.length ? col(colKeys[0]) : [],
      gridTop: tiles.length ? Math.min(...tiles.map((t) => rectOf(t).top)) : null,
      minTile: tiles.length
        ? Math.min(...tiles.map((t) => Math.min(rectOf(t).width, rectOf(t).height)))
        : 0,
      zeroTile: (() => {
        const z = buttons.find((b) => ownLabel(b) === "0");
        return z ? box(z) : null;
      })(),
      zeroTileDisabled: Boolean(
        buttons.find((b) => ownLabel(b) === "0")?.disabled,
      ),
      zoneMinH: zones.length ? Math.min(...zones.map((z) => rectOf(z).height)) : 0,
      minTileW: tiles.length ? Math.min(...tiles.map((t) => rectOf(t).width)) : 0,
      minTileH: tiles.length ? Math.min(...tiles.map((t) => rectOf(t).height)) : 0,
      gridBottom: (() => {
        const bottoms = tiles.map((t) => rectOf(t).bottom);
        const z = buttons.find((b) => ownLabel(b) === "0");
        if (z) bottoms.push(z.getBoundingClientRect().bottom);
        return bottoms.length ? Math.max(...bottoms) : null;
      })(),
      navFixed: nav ? getComputedStyle(nav).position : null,
      navHeight: navBox ? navBox.h : null,
      navBottom: navBox ? navBox.bottom : null,
      stripExists: Boolean(strip),
      stripVisible: Boolean(strip && strip.getClientRects().length),
      chipHintVisible,
      chip17: chip17 ? { ...box(chip17), text: txt(chip17) } : null,
      gridOverflow: gridEl
        ? { client: gridEl.clientWidth, scroll: gridEl.scrollWidth }
        : null,
      canvas: { ...canvasBox, backing: canvas.width, cssWidth: canvas.clientWidth },
      chipPanelTop: chipTitle ? chipTitle.getBoundingClientRect().top : null,
      sidebarTitleTop: sidebarTitle
        ? sidebarTitle.getBoundingClientRect().top
        : null,
      sidebarTitleLeft: sidebarTitle
        ? sidebarTitle.getBoundingClientRect().left
        : null,
      lockedBarVisible: lockedBar ? lockedBar.getClientRects().length > 0 : false,
      badgeVisible: badge ? badge.getClientRects().length > 0 : false,
      badgeTop: badge && badge.getClientRects().length ? box(badge).top : null,
      tilesDisabled: tiles.filter((t) => t.disabled).length,
      dimmedTiles: tiles.filter((t) =>
        /opacity-([0-9]|[1-9][0-9])\b/.test(t.className),
      ).length,
      chips: tiles
        .filter((t) => t.querySelector("[data-bet-chip]"))
        .map(
          (t) =>
            `${ownLabel(t)}:${txt(t.querySelector("[data-bet-chip]"))
              .replace(/×/g, "")
              .trim()}`,
        ),
      winnerTiles: buttons
        .filter((b) => /ring-3/.test(b.className))
        .map((b) => ownLabel(b)),
      spinning: /^Spinning…/.test(txt(statusSpan) || ""),
    };
  });

const sameCanvasBox = (a, b) =>
  ["top", "left", "w", "h"].every((k) => Math.abs(a.canvas[k] - b.canvas[k]) <= 0.5);

// Centre of a number tile (grid buttons only), for real touch/mouse taps at
// the coordinates a player actually hits.
const tilePoint = (num) =>
  page.evaluate((n) => {
    const ownLabel = (b) =>
      b.firstChild && b.firstChild.nodeType === 3
        ? b.firstChild.textContent.trim()
        : "";
    const t = [...document.querySelectorAll("button")].find(
      (x) =>
        ownLabel(x) === String(n) &&
        getComputedStyle(x.parentElement).display === "grid",
    );
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, num);

// Interactions are driven from inside the page (`el.click()`), exactly like the
// other roulette checks: real synthesised input events wedge in this headless
// Chromium. That is the same code path a finger takes (the chip handler is a
// plain React onClick, and `stopPropagation` is what keeps the tap from also
// betting on the tile), and the TOUCH TARGET itself is asserted separately with
// `probe`, which hit-tests the coordinates a finger would land on.
const probe = ([x, y]) =>
  page.evaluate(([px_, py]) => {
    const el = document.elementFromPoint(px_, py);
    const chip = el && el.closest ? el.closest("[data-bet-chip]") : null;
    const tile = el && el.closest ? el.closest("button") : null;
    const ownLabel = (b) =>
      b && b.firstChild && b.firstChild.nodeType === 3
        ? b.firstChild.textContent.trim()
        : null;
    return {
      isChip: Boolean(chip),
      chipText: chip ? chip.textContent.replace(/\s+/g, " ").trim() : null,
      tileLabel: ownLabel(tile),
    };
  }, [x, y]);

const clickIn = (num, what) =>
  page.evaluate(
    ([n, target]) => {
      const ownLabel = (b) =>
        b.firstChild && b.firstChild.nodeType === 3
          ? b.firstChild.textContent.trim()
          : "";
      const tile = [...document.querySelectorAll("button")].find(
        (x) =>
          ownLabel(x) === String(n) &&
          getComputedStyle(x.parentElement).display === "grid",
      );
      if (!tile) return false;
      const el = target === "chip" ? tile.querySelector("[data-bet-chip]") : tile;
      if (!el) return false;
      el.click();
      return true;
    },
    [num, what],
  );

const clickTile = async (num) => {
  if (!(await clickIn(num, "tile"))) throw new Error(`tile ${num} not found`);
  await page.waitForTimeout(220);
};

const clickChip = async (num) => {
  if (!(await clickIn(num, "chip"))) throw new Error(`chip on ${num} not found`);
  await page.waitForTimeout(220);
};

const waitForSpin = () =>
  page.waitForFunction(
    () =>
      [...document.querySelectorAll("span")].some(
        (el) => el.textContent.replace(/\s+/g, " ").trim() === "Spinning…",
      ),
    null,
    { timeout: 20000 },
  );

const waitForLanding = () =>
  page.waitForFunction(
    () => {
      const spinning = [...document.querySelectorAll("span")].some(
        (el) => el.textContent.replace(/\s+/g, " ").trim() === "Spinning…",
      );
      return (
        !spinning &&
        [...document.querySelectorAll("button")].some((b) => /ring-3/.test(b.className))
      );
    },
    null,
    { timeout: 20000 },
  );

const waitForBadge = (want) =>
  page.waitForFunction(
    (w) => {
      const ownText = (el) =>
        [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .join(" ")
          .trim();
      const badge = [...document.querySelectorAll("span")].find((s) =>
        /^Bets locked/.test(ownText(s)),
      );
      return Boolean(badge && badge.getClientRects().length > 0) === w;
    },
    want,
    { timeout: 15000 },
  );

let browser = null;
let page = null;
const consoleErrors = [];

const mountPage = async (options) => {
  const p = await browser.newPage({ ...options });
  p.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  p.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (/non-boolean attribute/.test(msg.text())) return;
    consoleErrors.push(`console: ${msg.text()}`);
  });
  await p.goto("file://" + join(outDir, "index.html").replace(/\\/g, "/"));
  await p.addStyleTag({ path: join(outDir, "tw.css") });
  await p.waitForFunction(
    () => document.querySelectorAll("button").length > 30,
    null,
    { timeout: 20000 },
  );
  await p.waitForTimeout(250);
  return p;
};

try {
  browser = await chromium.launch();

  // ── A. 390 × 844 phone (DPR 3) ───────────────────────────────────────────
  page = await mountPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
  });
  let m = await measure();
  const initialCanvas = m.canvas;

  check(
    "phone 390: the page never scrolls sideways",
    m.docScrollWidth <= m.docClientWidth + 1,
    `scrollWidth ${m.docScrollWidth} vs ${m.docClientWidth}`,
  );
  check(
    "phone 390: the wheel fits the screen (no overflow beyond the canvas box)",
    m.canvas.right <= m.vw + 1,
    `canvas right ${px(m.canvas.right)} of ${px(m.vw)}`,
  );
  check(
    "phone 390: the wheel is inside the FIRST screen (no scrolling to reach it)",
    m.canvas.top >= 0 && m.canvas.bottom <= m.vh + 1,
    `canvas ${px(m.canvas.top)}..${px(m.canvas.bottom)} of ${px(m.vh)}`,
  );
  check(
    "phone 390: the wheel leads the controls (canvas above the chip panel)",
    m.chipPanelTop != null && m.canvas.top < m.chipPanelTop,
    `canvas top ${px(m.canvas.top)}, chip panel ${px(m.chipPanelTop)}`,
  );
  check(
    "phone 390: the wheel leads the sidebar (canvas above the sidebar title)",
    m.sidebarTitleTop != null && m.canvas.top < m.sidebarTitleTop,
    `canvas top ${px(m.canvas.top)}, sidebar ${px(m.sidebarTitleTop)}`,
  );
  check(
    "phone 390: the board is a 9-column grid (4 rows)",
    m.tileColumns === 9 && m.tileCount === 36 && Boolean(m.zeroTile),
    `${m.tileColumns} per row, ${m.tileCount} tiles + ${m.zeroTile ? "0" : "no 0"}`,
  );
  check(
    "phone 390: the board reads 1-9 on the first row (sequential)",
    JSON.stringify(m.firstRow) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    JSON.stringify(m.firstRow),
  );
  check(
    "phone 390: tiles stay tappable (>= 34 wide × 40 tall) to fit one screen",
    m.minTileW >= 34 && m.minTileH >= 40,
    `smallest tile ${m.minTileW.toFixed(1)}×${m.minTileH.toFixed(1)}`,
  );
  check(
    "phone 390: the 0 tile is at least 40 px tall",
    m.zeroTile && m.zeroTile.h >= 40,
    m.zeroTile ? `${m.zeroTile.w.toFixed(0)}×${m.zeroTile.h.toFixed(0)}` : "missing",
  );
  check(
    "phone 390: the fixed navbar is cleared at rest",
    m.navFixed === "fixed" && m.canvas.top >= m.navBottom,
    `nav ${m.navFixed}, ${px(m.navHeight)} tall (bottom ${px(m.navBottom)}), wheel top ${px(m.canvas.top)}`,
  );
  check(
    "phone 390: the last-spin strip is out of the way (status line carries it)",
    !m.stripVisible,
    `strip visible ${m.stripVisible}`,
  );
  check(
    "phone 390: the wheel AND the whole board fit the first screen",
    m.gridBottom != null && m.gridBottom <= m.vh + 1,
    `board bottom ${px(m.gridBottom)} of ${px(m.vh)}`,
  );
  check(
    "phone 390: the outside bets are >= 40 px tall",
    m.zoneMinH >= 40,
    `smallest zone ${m.zoneMinH.toFixed(1)}px`,
  );
  check(
    "phone 390: the board has no nested horizontal scroll",
    m.gridOverflow &&
      m.gridOverflow.scroll <= m.gridOverflow.client + 1,
    m.gridOverflow
      ? `grid scrollWidth ${m.gridOverflow.scroll} vs client ${m.gridOverflow.client}`
      : "grid not found",
  );
  check(
    "phone 390: the canvas keeps the DPR-aware backing store (>= 2 device px per CSS px)",
    m.canvas.backing >= Math.round(m.canvas.cssWidth) * 2 && m.canvas.backing <= 840,
    `backing ${m.canvas.backing}, css ${m.canvas.cssWidth}`,
  );
  check(
    "phone 390: nothing is locked and no cue shows before the round starts",
    m.tilesDisabled === 0 &&
      !m.zeroTileDisabled &&
      !m.badgeVisible &&
      m.winnerTiles.length === 0,
    `${m.tilesDisabled} disabled tiles, cue ${m.badgeVisible}`,
  );
  check(
    "phone 390: the stake chips + lock-in are hoisted above the sidebar panels",
    m.chipPanelTop != null &&
      m.sidebarTitleTop != null &&
      m.chipPanelTop < m.sidebarTitleTop,
    `chips ${px(m.chipPanelTop)}, sidebar title ${px(m.sidebarTitleTop)}`,
  );

  // Locked in, not yet spinning: the mobile cue must be visible above the board
  // while the confirmed chips stay at full strength.
  await page.evaluate(() => window.__lockMyBets({ 17: 25 }));
  await waitForBadge(true);
  m = await measure();
  const lockedCanvas = m.canvas;
  check(
    "phone 390 locked: the \"Bets locked\" cue is visible above the board",
    m.badgeVisible && m.badgeTop != null && m.badgeTop < m.gridTop,
    `cue top ${px(m.badgeTop)}, board top ${px(m.gridTop)}`,
  );
  check(
    "phone 390 locked: every tile (0 + 1-36) is genuinely disabled",
    m.tilesDisabled === m.tileCount && m.zeroTileDisabled,
    `${m.tilesDisabled}/${m.tileCount} + 0 ${m.zeroTileDisabled ? "locked" : "OPEN"}`,
  );
  check(
    "phone 390 locked: confirmed chips stay visible and undimmed",
    m.dimmedTiles === 0 && m.chips.includes("17:25"),
    `${m.dimmedTiles} dimmed, chips ${JSON.stringify(m.chips)}`,
  );
  check(
    "phone 390 locked: locking does not move the canvas (no layout shift)",
    sameCanvasBox({ canvas: initialCanvas }, { canvas: lockedCanvas }),
    `canvas ${px(lockedCanvas.top)} vs ${px(initialCanvas.top)}`,
  );

  // Released: betting re-opens on the phone exactly as on desktop.
  await page.evaluate(() => window.__lockMyBets(null));
  await waitForBadge(false);
  m = await measure();
  check(
    "phone 390 released: the cue clears and betting re-opens",
    !m.badgeVisible && m.tilesDisabled === 0 && !m.zeroTileDisabled,
    `${m.tilesDisabled} disabled tiles, cue ${m.badgeVisible}`,
  );

  // ── Clearing a single chip on a phone (a touch screen has no right-click) ──
  await clickTile(17);
  m = await measure();
  check(
    "phone: a tap on a number still stages a bet",
    m.chips.includes("17:10"),
    JSON.stringify(m.chips),
  );
  check(
    "phone: the staged chip shows the × clear affordance",
    Boolean(m.chip17 && /×/.test(m.chip17.text)) && m.chipHintVisible,
    m.chip17 ? `${m.chip17.text} (hint visible ${m.chipHintVisible})` : "no chip",
  );
  const chipA = m.chip17;
  const chipCentre = [chipA.left + chipA.w / 2, chipA.top + chipA.h / 2];
  // 4 px BELOW the visible pill: inside the enlarged (pseudo-element) hit area.
  const chipSkirt = [chipA.left + chipA.w / 2, chipA.bottom + 4];
  const tileCentre = await tilePoint(17);
  const onChip = await probe(chipCentre);
  const onSkirt = await probe(chipSkirt);
  const onTile = await probe([tileCentre.x, tileCentre.y]);
  check(
    "phone: a finger on the chip hits the CHIP, not the tile",
    onChip.isChip && onChip.tileLabel === "17",
    JSON.stringify(onChip),
  );
  check(
    "phone: the chip's touch target is bigger than the visible pill",
    onSkirt.isChip,
    JSON.stringify(onSkirt),
  );
  check(
    "phone: the tile body still belongs to the number",
    !onTile.isChip && onTile.tileLabel === "17",
    JSON.stringify(onTile),
  );
  await clickChip(17);
  m = await measure();
  check(
    "phone: tapping the chip clears that single bet",
    m.chips.length === 0 && m.chip17 === null,
    JSON.stringify(m.chips),
  );
  check(
    "phone: the tile itself is still free to bet on afterwards",
    m.tilesDisabled === 0 && m.zeroTileDisabled === false,
    `${m.tilesDisabled} disabled tiles`,
  );
  await clickTile(17);
  m = await measure();
  check(
    "phone: tapping the tile body still adds the bet back",
    m.chips.includes("17:10"),
    JSON.stringify(m.chips),
  );
  await page.evaluate(() => window.__lockMyBets({ 17: 25 }));
  await waitForBadge(true);
  await clickChip(17);
  m = await measure();
  check(
    "phone: a LOCKED chip cannot be cleared by tapping it",
    m.chips.includes("17:25"),
    JSON.stringify(m.chips),
  );
  await page.evaluate(() => window.__lockMyBets(null));
  await waitForBadge(false);

  // Spin (round 1): the cue is up (bets really are committed) and the wheel
  // keeps its original size — the only new thing above it is the "Last spin"
  // strip, which belongs to the round-result reveal.
  await page.evaluate(() => window.__settleRound({ number: 17 }));
  await waitForSpin();
  m = await measure();
  check(
    "phone 390 spinning: the locked cue is up while the wheel turns",
    m.spinning && m.badgeVisible && m.tilesDisabled === m.tileCount,
    `spinning ${m.spinning}, cue ${m.badgeVisible}, ${m.tilesDisabled} locked`,
  );
  check(
    "phone 390 spinning: the wheel keeps its size",
    m.canvas.w === initialCanvas.w &&
      m.canvas.h === initialCanvas.h &&
      m.canvas.left === initialCanvas.left,
    `canvas ${m.canvas.w.toFixed(0)}×${m.canvas.h.toFixed(0)} (was ${initialCanvas.w.toFixed(0)}×${initialCanvas.h.toFixed(0)})`,
  );
  check(
    "phone 390 spinning: still no sideways scroll / overflow",
    m.docScrollWidth <= m.docClientWidth + 1 && m.canvas.right <= m.vw + 1,
    `scrollWidth ${m.docScrollWidth}, canvas right ${px(m.canvas.right)}`,
  );

  await waitForLanding();
  m = await measure();
  check(
    "phone 390 landing: the server's winning pocket is highlighted",
    m.winnerTiles.includes("17"),
    JSON.stringify(m.winnerTiles),
  );
  check(
    "phone 390 landing: the result does not resize the wheel",
    m.canvas.w === initialCanvas.w && m.canvas.h === initialCanvas.h,
    `canvas ${m.canvas.w.toFixed(0)}×${m.canvas.h.toFixed(0)}`,
  );
  check(
    "phone 390 landing: the cue clears and the next round re-opens betting",
    !m.badgeVisible && m.tilesDisabled === 0 && !m.zeroTileDisabled,
    `${m.tilesDisabled} disabled tiles, cue ${m.badgeVisible}`,
  );
  check(
    "phone 390 landing: the last-spin strip exists but stays hidden on phones",
    m.stripExists && !m.stripVisible,
    `exists ${m.stripExists}, visible ${m.stripVisible}`,
  );

  // ── Round 2: with the result strip already on screen nothing at all may
  // move the wheel — locking, spinning and landing must all be pixel-stable.
  const round2Baseline = m.canvas;
  await page.evaluate(() => window.__lockMyBets({ 5: 10 }));
  await waitForBadge(true);
  m = await measure();
  check(
    "phone 390 round 2: locking does not move the wheel at all",
    sameCanvasBox({ canvas: round2Baseline }, m),
    `canvas top ${px(m.canvas.top)} vs ${px(round2Baseline.top)}`,
  );
  await page.evaluate(() => window.__settleRound({ number: 5 }));
  await waitForSpin();
  m = await measure();
  check(
    "phone 390 round 2 spinning: the wheel box is identical to the idle box",
    sameCanvasBox({ canvas: round2Baseline }, m),
    `canvas ${px(m.canvas.top)} vs ${px(round2Baseline.top)}`,
  );
  check(
    "phone 390 round 2 spinning: the cue is up and the board is locked",
    m.badgeVisible && m.tilesDisabled === m.tileCount && m.zeroTileDisabled,
    `cue ${m.badgeVisible}, ${m.tilesDisabled} locked`,
  );
  await waitForLanding();
  m = await measure();
  check(
    "phone 390 round 2 landing: the new winning pocket is highlighted",
    m.winnerTiles.includes("5"),
    JSON.stringify(m.winnerTiles),
  );
  check(
    "phone 390 round 2 landing: the wheel box is still identical (round-to-round stability)",
    sameCanvasBox({ canvas: round2Baseline }, m),
    `canvas ${px(m.canvas.top)} vs ${px(round2Baseline.top)}`,
  );

  // ── B. 360 px phone (smallest common width) ─────────────────────────────
  const narrow = await mountPage({
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 2,
  });
  const saved = page;
  page = narrow;
  m = await measure();
  check(
    "phone 360: the wheel is inside the first screen",
    m.canvas.top >= 0 && m.canvas.bottom <= m.vh + 1,
    `canvas ${px(m.canvas.top)}..${px(m.canvas.bottom)} of ${px(m.vh)}`,
  );
  check(
    "phone 360: 9 columns of >= 32 × 40 px tiles, no sideways scroll",
    m.tileColumns === 9 &&
      m.minTileW >= 32 &&
      m.minTileH >= 40 &&
      m.docScrollWidth <= m.docClientWidth + 1 &&
      m.gridOverflow.scroll <= m.gridOverflow.client + 1,
    `${m.tileColumns} cols, smallest tile ${m.minTileW.toFixed(1)}×${m.minTileH.toFixed(1)}, scrollWidth ${m.docScrollWidth}`,
  );
  check(
    "phone 360: the wheel AND the whole board fit one 360 × 640 screen",
    m.gridBottom != null &&
      m.gridBottom <= m.vh + 1 &&
      m.canvas.top >= m.navBottom,
    `board bottom ${px(m.gridBottom)} of ${px(m.vh)} (nav bottom ${px(m.navBottom)})`,
  );
  check(
    "phone 360: the fixed navbar (h-16 + its 1 px border) is cleared",
    m.navFixed === "fixed" &&
      m.navHeight <= 66 &&
      m.canvas.top - m.navBottom >= 8,
    `nav ${m.navFixed} ${px(m.navHeight)}, wheel top ${px(m.canvas.top)} (clearance ${px(m.canvas.top - m.navBottom)})`,
  );
  check(
    "phone 360: the wheel leads the sidebar and stays sharp",
    m.canvas.top < m.sidebarTitleTop &&
      m.canvas.backing >= Math.round(m.canvas.cssWidth) * 2,
    `canvas ${px(m.canvas.top)}, sidebar ${px(m.sidebarTitleTop)}, backing ${m.canvas.backing} @ css ${m.canvas.cssWidth}`,
  );
  await narrow.close();
  page = saved;

  // ── C. Desktop must be untouched ────────────────────────────────────────
  const desktop = await mountPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  page = desktop;
  m = await measure();
  check(
    "desktop: the control sidebar is still the LEFT column",
    m.sidebarTitleLeft != null && m.sidebarTitleLeft < m.canvas.left,
    `sidebar left ${px(m.sidebarTitleLeft)}, canvas left ${px(m.canvas.left)}`,
  );
  check(
    "desktop: the sidebar keeps its normal order (title + panels, then the chips)",
    m.chipPanelTop != null &&
      m.sidebarTitleTop != null &&
      m.sidebarTitleTop < m.chipPanelTop,
    `sidebar title ${px(m.sidebarTitleTop)}, chip panel ${px(m.chipPanelTop)}`,
  );
  check(
    "desktop: the board is still the classic 12 × 3 table (row 1,4,7 …)",
    m.tileColumns === 12 &&
      JSON.stringify(m.firstRow) ===
        JSON.stringify([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]),
    `${m.tileColumns} per row: ${JSON.stringify(m.firstRow)}`,
  );
  check(
    "desktop: the classic column reading (1,2,3 top-to-bottom) is preserved",
    JSON.stringify(m.firstCol) === JSON.stringify([1, 2, 3]),
    JSON.stringify(m.firstCol),
  );
  check(
    "desktop: tile size is unchanged by the phone work",
    m.minTile >= 30 && m.minTile <= 40,
    `smallest tile ${m.minTile.toFixed(1)}px`,
  );
  check(
    "desktop: the fixed navbar is cleared by the page padding",
    m.navFixed === "fixed" && m.canvas.top >= m.navBottom,
    `nav ${px(m.navHeight)} (bottom ${px(m.navBottom)}), canvas top ${px(m.canvas.top)}`,
  );
  check(
    "desktop: the outside bets keep their compact height",
    m.zoneMinH > 0 && m.zoneMinH < 40,
    `smallest zone ${m.zoneMinH.toFixed(1)}px`,
  );
  await page.evaluate(() => window.__lockMyBets({ 17: 25 }));
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("div")].some((d) =>
        /^Bets locked\. Waiting for opponent/.test(
          d.textContent.replace(/\s+/g, " ").trim(),
        ),
      ),
    null,
    { timeout: 10000 },
  );
  m = await measure();
  check(
    "desktop: the phone-only cue stays hidden and the sidebar bar carries the state",
    !m.badgeVisible && m.lockedBarVisible,
    `cue ${m.badgeVisible}, sidebar bar ${m.lockedBarVisible}`,
  );
  check(
    "desktop: locked chips still keep their colour",
    m.dimmedTiles === 0 && m.chips.includes("17:25"),
    `${m.dimmedTiles} dimmed, chips ${JSON.stringify(m.chips)}`,
  );

  // Desktop keeps the same chip affordance (click the pill) — and a locked
  // chip must never be clearable, on either input method.
  const lockedChip = m.chip17;
  check(
    "desktop: the chip keeps its compact look (the × hint is phone-only)",
    Boolean(lockedChip) && !m.chipHintVisible,
    lockedChip ? `${lockedChip.text} (hint visible ${m.chipHintVisible})` : "no chip",
  );
  await clickChip(17);
  m = await measure();
  check(
    "desktop: a locked chip cannot be clicked away either",
    m.chips.includes("17:25"),
    JSON.stringify(m.chips),
  );
  await page.evaluate(() => window.__lockMyBets(null));
  await page.waitForTimeout(250);
  await clickTile(17);
  m = await measure();
  check(
    "desktop: a tile click still stages a bet",
    m.chips.includes("17:10"),
    JSON.stringify(m.chips),
  );
  await clickChip(17);
  m = await measure();
  check(
    "desktop: clicking a staged chip clears that bet too",
    m.chips.length === 0,
    JSON.stringify(m.chips),
  );

  // ── D. Creator Mode frame still wins over the new mobile column order ───
  const creator = await page.evaluate(() => {
    const phone = document.getElementById("creatorPhone");
    phone.className = "relative flex min-h-0 min-w-0 flex-col self-start";
    phone.setAttribute("data-creator-phone", "");
    phone.style.width = "390px";
    const stack = document.querySelector("[data-creator-stack]");
    const kids = [...stack.children];
    const rect = (el) => el.getBoundingClientRect();
    return {
      direction: getComputedStyle(stack).flexDirection,
      orderFirst: getComputedStyle(kids[0]).order,
      orderLast: getComputedStyle(kids[kids.length - 1]).order,
      controlsTop: rect(kids[0]).top,
      boardTop: rect(kids[kids.length - 1]).top,
    };
  });
  check(
    "creator frame: the stack is still forced to a single column",
    creator.direction === "column",
    creator.direction,
  );
  check(
    "creator frame: the recording still leads with gameplay (wheel + board first)",
    creator.boardTop < creator.controlsTop,
    `wheel column ${px(creator.boardTop)} vs controls ${px(creator.controlsTop)}`,
  );
  check(
    "creator frame: the swap is still driven by the creator CSS order rules",
    creator.orderFirst === "2" && creator.orderLast === "1",
    `first ${creator.orderFirst}, last ${creator.orderLast}`,
  );

  check(
    "no console errors anywhere in the run",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );
} finally {
  if (browser) await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
