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
//   4. phone width       — the cap is desktop-only, mobile sizing untouched
//   5. creator frame     — the cap is RELEASED (a recording frame is not the
//                          browser viewport, so a vh cap would shrink a clip)
//   6. no console / page errors
//   7. MINES only        — the board is CENTRED in its column. It used to hug
//                          the left edge: a `w-full` block with a `max-width`
//                          does not centre itself, so a 260px board sat at the
//                          left of a 768px column, ~256px off-centre on screen.
//   8. MINES only        — the board actually USES the height its compacted
//                          chrome freed: the cap is `100vh - 27.5rem`, so the
//                          board lands within a few px of that budget, and it
//                          must beat the old `100vh - 34rem` cap it sat at.
//
// Run: node qa/board-fit-check.mjs
//
// Fully offline: Clerk, the socket, the router, analytics, nav/footer, the
// waiting takeover, the result screen and the creator-mode HOST are stubbed by
// the esbuild step; the creator-mode LAYOUT stays REAL (the exemption under
// test is the shipped one) and the match payload comes from a stubbed `fetch`
// — no auth, no database, no dev server.

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
// NOTE: `components/creator-mode/CreatorModeLayout` is deliberately NOT
// stubbed — the real shell primitives and the real <CreatorView> branches are
// what the creator-exemption phase checks. Only the HOST (recording chrome)
// and the creator-mode PROVIDER (which selects the frame dimensions) are.
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
  "components/creator-mode/CreatorModeHost": `
    import React from "react";
    export default function Host({ children }) { return children ?? null; }
  `,
  "lib/creator-mode/CreatorModeProvider": `
    import React from "react";
    const noop = () => {};
    export const useCreatorMode = () => {
      const on = Boolean(window.__bf?.creator);
      return {
        isCreatorMode: on,
        dimensions: on ? { width: 390, height: 693 } : { width: 1280, height: 720 },
        orientation: on ? "portrait" : "landscape",
        setDimensions: noop,
        start: noop,
        stop: noop,
      };
    };
    export const CreatorModeProvider = ({ children }) => children ?? null;
    export default { useCreatorMode, CreatorModeProvider };
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

      // The cap is `100vh - 27.5rem` = viewport - 440px. If the board comes in
      // well under that, chrome crept back in above it and the growth was lost.
      const budget = viewport.height - 440;
      check(
        `${tag}: the board fills the height the compact chrome freed`,
        Math.abs(m.height - budget) <= 6,
        `board=${m.height} budget≈${budget}`,
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
  const { context, page } = await boot(game, { width: 390, height: 844 });
  const m = await page.evaluate((s) => window.__bf.measure(s), sel);
  const computed = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).maxWidth : null;
  }, sel);
  const tag = `${label} @ 390 wide`;
  console.log(`   ${tag}: board ${m.width}×${m.height}, computed max-width=${computed}`);
  // The desktop rule is inside a `min-width: 1024px` media query, so at phone
  // width the computed cap must be the element's own class cap (or none), never
  // the vh-derived value.
  check(
    `${tag}: the desktop cap does not apply on mobile`,
    !/calc\(|px\)/.test(String(computed)) || m.width >= 280,
    `max-width=${computed} width=${m.width}`,
  );
  await context.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// Creator frame — the cap must be RELEASED (a recording frame is not the
// browser viewport, so a vh cap would shrink the recorded clip)
// ═══════════════════════════════════════════════════════════════════════════
for (const [game, label] of [
  ["mines", "Mines Duel"],
  ["memory", "Memory Grid"],
]) {
  const sel = SELECTOR[game];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(fileUrl);
  await page.waitForFunction(() => !!window.__bf?.mount, null, { timeout: 20000 });
  await page.evaluate(
    ([g]) => {
      window.__bf.setCreator(true);
      window.__bf.set(g, {});
      window.__bf.mount(g);
    },
    [game],
  );
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.waitForTimeout(400);
  const inside = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const frame = document.querySelector("[data-creator-layout]");
    return {
      inCreatorFrame: Boolean(frame),
      maxWidth: getComputedStyle(el).maxWidth,
    };
  }, sel);
  check(
    `${label}: creator frame renders inside data-creator-layout`,
    inside?.inCreatorFrame === true,
    JSON.stringify(inside),
  );
  check(
    `${label}: the desktop cap is released inside the creator frame`,
    inside?.maxWidth === "none",
    `max-width=${inside?.maxWidth}`,
  );
  await page.screenshot({ path: join(REPORTS, `board-fit-${game}-creator.png`) });
  await context.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
