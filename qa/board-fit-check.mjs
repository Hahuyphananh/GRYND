// qa/board-fit-check.mjs
//
// Drives qa/board-fit-harness.jsx — the REAL Mines Duel and Memory Grid match
// pages with scripted payloads — and measures the one thing the change is
// about: on desktop, does the WHOLE board fit on screen without scrolling?
//
// Both boards are SQUARES drawn full-width inside a centred column, so on a
// desktop the board was taller than the space under the page's chrome (title,
// stake line, seat cards, turn indicator, legend / round tracker, scoreboard,
// phase banner) and the bottom rows needed a scroll. Each board now carries a
// shared hook (`.mines-board-frame` / `.memory-board-frame`) whose desktop
// rule caps its WIDTH by the viewport height — a width cap on a square is a
// height cap.
//
// Checks:
//   1. desktop 1280×800  — the board's painted bottom is above the fold
//   2. desktop 1440×900  — same, on a taller screen
//   3. the board still fills its column (the cap did not collapse it)
//   4. phone widths      — 320 / 360 / 390: the cap is desktop-only, the board
//                          stays square and on screen, and the tiles stay
//                          tappable (Mines: 24px WCAG target floor)
//   5. no console / page errors
//   6. MINES only        — the board is CENTRED in its column. It used to hug
//                          the left edge: a `w-full` block with a `max-width`
//                          does not centre itself, so a 260px board sat at the
//                          left of a 768px column, ~256px off-centre on screen.
//   7. MINES only        — the board actually USES the height its compacted
//                          chrome freed: the cap is `100vh - 12.5rem`, so the
//                          board lands within a few px of that budget (or of
//                          its column width, whichever binds), and it must
//                          beat the old `100vh - 34rem` cap it sat at.
//   8. cartoon cells     — both boards are drawn from square slabs with the
//                          SHARED outline token, and keyboard focus is wired to
//                          the shared focus ring (read from the rendered CSS).
//
// Run: node qa/board-fit-check.mjs
//
// Fully offline: Clerk, the socket, the router, analytics, nav/footer, the
// waiting takeover and the result screen are stubbed by the esbuild step, and
// the match payload comes from a stubbed `fetch` — no auth, no database, no dev
// server.
//
// NOTE: this check used to have a creator-frame phase, asserting that the
// board's desktop cap was released inside `[data-creator-layout]`. Creator mode
// was retired (3f5a7229) and no page renders that attribute any more, so the
// phase could only ever fail; it was removed rather than relaxed. The tile
// assertions below are unchanged.

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
const outDir = mkdtempSync(join(tmpdir(), "grynd-board-fit-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });
const TRACE = process.argv.includes("--trace");

// ── Stubs (everything noisy around the two match pages) ────────────────────
const STUBS = {
  "next/navigation": `
    const record = (href) => { (window.__bf = window.__bf || {}).nav = ((window.__bf && window.__bf.nav) || []).concat([href]); };
    export const useRouter = () => ({ push: record, replace: record, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino/mines-pvp/4242";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/image": `import React from "react"; export default function Img() { return null; }`,
  "next/link": `import React from "react"; export default function Link({ children }) { return children ?? null; }`,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
  "@clerk/nextjs": `
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "Tester" } });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
    export const useClerk = () => ({ signOut() {} });
    export default {};
  `,
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: window.__bf.socket });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "components/navigation-bar": `export default function Nav() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/lobby/MatchWaiting": `
    import React from "react";
    export default function MatchWaiting() { return React.createElement("div", { "data-testid": "waiting" }); }
  `,
  "components/result/PvpResultScreen": `
    import React from "react";
    export default function PvpResultScreen() { return React.createElement("div", { "data-testid": "pvp-result" }); }
  `,
  "components/ReportModal": `
    import React from "react";
    export default function ReportModal() { return null; }
  `,
  "lib/animations": `
    const staticMotion = { initial: false, animate: {}, exit: {}, transition: { duration: 0 } };
    export const withReducedMotion = (reduce, variant) => (reduce ? staticMotion : variant);
    export const fireConfetti = () => Promise.resolve();
    export const celebrateWin = () => Promise.resolve();
    export const fadeIn = staticMotion;
    export const fadeUp = staticMotion;
    export const modalMotion = { backdrop: staticMotion, panel: staticMotion };
    export const stagger = {};
    export const hoverScale = {};
    export const scorePop = {};
    export const buttonPulse = () => ({});
    export default { fireConfetti, withReducedMotion };
  `,
  "lib/gameAudio": `
    const noop = () => {};
    export const playVictory = noop;
    export const playDefeat = noop;
    export const playTick = noop;
    export const playGoodReveal = noop;
    export const playBuzz = noop;
    export const playSelect = noop;
    export const playCrash = noop;
    export const playGlassBreak = noop;
    export default { playVictory, playDefeat, playTick };
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
  entryPoints: [join(root, "qa/board-fit-harness.jsx")],
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
      name: "bf-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "bf-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "bf-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── The app's REAL stylesheet (shipped Tailwind utilities + globals.css) ───
const compiled = await postcss([
  tailwindcss(join(root, "tailwind.config.js")),
  autoprefixer(),
]).process(readFileSync(join(root, "src/app/globals.css"), "utf8"), {
  from: join(root, "src/app/globals.css"),
});
const appCss = compiled.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, "");
writeFileSync(join(outDir, "app.css"), appCss);
console.log(`compiled stylesheet: ${(appCss.length / 1024).toFixed(0)}KB\n`);

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Board fit check</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

// ── Reporting helpers ──────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const fileUrl = pathToFileURL(join(outDir, "index.html")).href;
const browser = await chromium.launch();

const structuralErrors = (errors) =>
  errors.filter((e) =>
    /validateDOMNesting|descendant of|hydration|Hydration|Cannot read|Cannot update|is not a function|unique "key"/i.test(
      e,
    ),
  );

/** Boot a page at a viewport, install a payload and mount one game. */
const boot = async (game, viewport, overrides = {}) => {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(fileUrl);
  await page.waitForFunction(() => !!window.__bf?.mount, null, { timeout: 20000 });
  await page.evaluate(
    ([g, ov]) => {
      window.__bf.set(g, ov);
      window.__bf.mount(g);
    },
    [game, overrides],
  );
  await page.waitForSelector(
    game === "memory" ? ".memory-board-frame" : ".mines-board-frame",
    { timeout: 15000 },
  );
  // Let the entrance motion / countdown ticks settle before measuring.
  await page.waitForTimeout(600);
  return { context, page, consoleErrors, pageErrors };
};

const SELECTOR = { mines: ".mines-board-frame", memory: ".memory-board-frame" };

// ═══════════════════════════════════════════════════════════════════════════
// DESKTOP — the whole board must sit above the fold
// ═══════════════════════════════════════════════════════════════════════════
for (const [game, label] of [
  ["mines", "Mines Duel"],
  ["memory", "Memory Grid"],
]) {
  const sel = SELECTOR[game];
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    const { context, page, consoleErrors, pageErrors } = await boot(game, viewport);
    const m = await page.evaluate((s) => window.__bf.measure(s), sel);
    const tag = `${label} @ ${viewport.width}×${viewport.height}`;

    console.log(
      `   ${tag}: board ${m.width}×${m.height} at top=${m.top} bottom=${m.bottom} (viewport ${m.viewportHeight}) ` +
        `page=${m.documentHeight} canScrollY=${m.canScrollY}`,
    );

    check(`${tag}: the whole board is above the fold`, m.bottom <= m.viewportHeight, `bottom=${m.bottom} viewport=${m.viewportHeight}`);

    // The cap must not have collapsed the board into a strip: a 5×5 board with
    // 134px cells is 768px tall, so anything under ~240px means the rule ate it.
    check(`${tag}: the cap did not collapse the board`, m.height >= 240, `height=${m.height}`);

    // A width cap is what makes it a height cap for a square board.
    check(`${tag}: the board is still square`, Math.abs(m.width - m.height) <= 4, `${m.width}×${m.height}`);

    check(
      `${tag}: no runtime / hydration errors`,
      structuralErrors([...consoleErrors, ...pageErrors]).length === 0,
      structuralErrors([...consoleErrors, ...pageErrors]).slice(0, 3).join(" | "),
    );

    // ── Mines-only: centring + the height the compaction bought ─────────
    if (game === "mines") {
      const geo = await page.evaluate((s) => {
        const el = document.querySelector(s);
        const parent = el?.parentElement;
        if (!el || !parent) return null;
        const b = el.getBoundingClientRect();
        const p = parent.getBoundingClientRect();
        return {
          boardCentre: Math.round((b.left + b.width / 2) * 10) / 10,
          columnCentre: Math.round((p.left + p.width / 2) * 10) / 10,
          columnWidth: Math.round(p.width),
        };
      }, sel);

      check(
        `${tag}: the board is centred in its column`,
        geo !== null && Math.abs(geo.boardCentre - geo.columnCentre) <= 2,
        `board centre=${geo?.boardCentre} column centre=${geo?.columnCentre} (column ${geo?.columnWidth}px)`,
      );

      // The cap is `100vh - 12.5rem` = viewport - 200px, but the board is also
      // bounded by the width of its column (the seats / turn indicator /
      // controls now sit in a rail BESIDE it, so the board column is 1fr of a
      // two-column grid). The board must fill whichever bound is smaller — if
      // it comes in under both, chrome crept back in above it and the growth
      // was lost.
      const budget = viewport.height - 200;
      const expected = Math.min(budget, geo?.columnWidth ?? budget);
      check(
        `${tag}: the board fills the height the compact chrome freed`,
        Math.abs(m.height - expected) <= 6,
        `board=${m.height} expected≈${expected} (budget=${budget}, column=${geo?.columnWidth})`,
      );

      // The regression this guards: the old `100vh - 34rem` cap, which left the
      // board at 260px here (its floor) — the size the change set out to fix.
      check(
        `${tag}: the board beat the old cap`,
        m.height > viewport.height - 544,
        `board=${m.height} old cap=${viewport.height - 544}`,
      );
    }

    await page.screenshot({ path: join(REPORTS, `board-fit-${game}-desktop.png`) });
    await context.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The cap must be DESKTOP-ONLY — a phone must keep the full-width board
// ═══════════════════════════════════════════════════════════════════════════
for (const [game, label] of [
  ["mines", "Mines Duel"],
  ["memory", "Memory Grid"],
]) {
  const sel = SELECTOR[game];
  // Every phone width the product supports, not just one: 320 is the narrowest
  // device the site targets, 360 and 390 are the common Android / iPhone
  // widths. The desktop cap must be absent at all of them, the board must stay
  // square and fully on screen, and the tiles must stay tappable.
  for (const widthPx of [320, 360, 390]) {
    const { context, page } = await boot(game, { width: widthPx, height: 844 });
    const m = await page.evaluate((s) => window.__bf.measure(s), sel);
    const computed = await page.evaluate((s) => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el).maxWidth : null;
    }, sel);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    const tag = `${label} @ ${widthPx} wide`;
    console.log(`   ${tag}: board ${m.width}×${m.height}, computed max-width=${computed}`);
    // The desktop rule is inside a `min-width: 1024px` media query, so at phone
    // width the computed cap must be the element's own class cap (or none), never
    // the vh-derived value.
    check(
      `${tag}: the desktop cap does not apply on mobile`,
      !/calc\(|px\)/.test(String(computed)) || m.width >= 280,
      `max-width=${computed} width=${m.width}`,
    );
    check(
      `${tag}: the board stays square`,
      m.width === m.height,
      `${m.width}×${m.height}`,
    );
    check(
      `${tag}: the board fits the phone page (no sideways scroll)`,
      overflow <= 0 && m.right <= m.viewportWidth + 1,
      `overflow=${overflow}px right=${m.right} viewport=${m.viewportWidth}`,
    );
    if (game === "mines") {
      // 10 columns: the WCAG 2.2 SC 2.5.8 minimum target size is 24 CSS px.
      check(
        `${tag}: every mine tile still meets the 24px touch floor`,
        m.width / 10 >= 24,
        `${(m.width / 10).toFixed(1)}px per tile`,
      );
    }
    await context.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Cartoon cell language — the shared tokens are actually painted
//
// Both boards were migrated to one slab language: ONE dark outline
// (`--gr-outline`), square tiles, and the shared focus ring on keyboard focus.
// These assertions read the RENDERED values, so a class that stops resolving
// (a renamed token, a purged utility) fails here rather than in a screenshot
// nobody looks at.
// ═══════════════════════════════════════════════════════════════════════════
const OUTLINE_RGB = "rgb(5, 16, 31)"; // --gr-outline #05101f
const FOCUS_RGB = "rgb(157, 216, 255)"; // --gr-focus-ring #9dd8ff
// The harness loads the stylesheet from `file://`, where CSSOM (`sheet.cssRules`)
// is opaque, so the focus rule is read from the stylesheet SOURCE. The token
// itself is still read from the live document below.
const FOCUS_RULE = readFileSync(join(root, "src/app/globals.css"), "utf8");
for (const [game, label] of [
  ["mines", "Mines Duel"],
  ["memory", "Memory Grid"],
]) {
  const sel = SELECTOR[game];
  const { context, page } = await boot(game, { width: 1280, height: 800 });
  const tiles = await page.evaluate((s) => {
    const list = [...document.querySelectorAll(`${s} button`)];
    return {
      count: list.length,
      square: list.every((el) => Math.abs(el.offsetWidth - el.offsetHeight) <= 1),
      outlineBorders: [...new Set(list.map((el) => getComputedStyle(el).borderColor))],
      focusable: list.every((el) => el.classList.contains("gr-focusable")),
    };
  }, sel);
  check(
    `${label}: the board is drawn from square tiles`,
    tiles.count > 0 && tiles.square,
    `${tiles.count} tiles`,
  );
  check(
    `${label}: every tile is a cartoon slab with the shared dark outline`,
    tiles.focusable && tiles.outlineBorders.includes(OUTLINE_RGB),
    `borders ${tiles.outlineBorders.slice(0, 5).join(" / ")}`,
  );
  // Keyboard focus must use the shared focus-ring token, not a per-game colour.
  // The harness mounts a WAITING payload (every tile disabled), so no tile can
  // take focus here; what is checked instead is the wiring that gives it a ring:
  // every tile carries `.gr-focusable`, the token resolves to #9dd8ff, and the
  // `.gr-focusable:focus-visible` rule paints with that token.
  const focusValue = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--gr-focus-ring").trim(),
  );
  const rule = FOCUS_RULE.slice(FOCUS_RULE.indexOf(".gr-focusable:focus-visible"));
  const ruleBody = rule.slice(rule.indexOf("{") + 1, rule.indexOf("}"));
  check(
    `${label}: keyboard focus is wired to the shared focus ring`,
    tiles.focusable &&
      focusValue.toLowerCase() === "#9dd8ff" &&
      /outline:\s*var\(--gr-focus-ring-width\)\s+solid\s+var\(--gr-focus-ring\)/.test(ruleBody),
    `token=${focusValue} rule=${ruleBody.trim().replace(/\s+/g, " ")}`,
  );
  await page.screenshot({ path: join(REPORTS, `board-fit-${game}-cells.png`) });
  await context.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
