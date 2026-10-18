// qa/card-number-visual-check.mjs
//
// Prompt 7 — the card / number batch. Drives
// `qa/card-number-visual-harness.tsx` (the REAL Solitaire Duel board and the
// REAL Keno PvP match page, with fixed payloads) and measures what actually
// paints at 320, 360, 390 and 1280 px:
//
//   • no sideways scroll, and the board / card grid staying inside the page;
//   • card size and the rank / suit type still legible (numerals are the game
//     information — they must not shrink into decoration);
//   • ONE shared dark outline (`--gr-outline`) on every card and tile, and the
//     shared focus wiring (`.gr-focusable`);
//   • selected vs legal-target vs unavailable cues differing in SHAPE as well
//     as hue (dashed selection outline vs solid target ring);
//   • ownership cues existing without colour alone (white dot vs gold diamond),
//     and the live Keno tile still carrying its countdown bar.
//
// Run: node qa/card-number-visual-check.mjs
// Fully offline: Clerk, the socket, the router, analytics, nav/footer and the
// shared audio are stubbed by the esbuild step; the match payload comes from a
// stubbed `fetch`. No dev server, no auth, no database.

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
const outDir = mkdtempSync(join(tmpdir(), "grynd-card-number-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// ── Stubs (everything noisy around the two boards) ─────────────────────────
const STUBS = {
  "next/navigation": `
    const record = (href) => { (window.__cv = window.__cv || {}).nav = ((window.__cv && window.__cv.nav) || []).concat([href]); };
    const router = { push: record, replace: record, back(){}, refresh(){}, prefetch(){} };
    export const useRouter = () => router;
    export const usePathname = () => "/casino/keno-pvp/5150";
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
    export const useSocket = () => ({ socket: window.__cv.socket });
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
  "components/creator-mode/CreatorModeHost": `
    import React from "react";
    export default function Host({ children }) { return children ?? null; }
  `,
  "lib/creator-mode/CreatorModeProvider": `
    import React from "react";
    const noop = () => {};
    export const useCreatorMode = () => ({
      isCreatorMode: false,
      dimensions: { width: 1280, height: 720 },
      orientation: "landscape",
      setDimensions: noop,
      start: noop,
      stop: noop,
    });
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
    export const playCardPlace = noop;
    export const playCardDraw = noop;
    export const playTurnSwitch = noop;
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
  entryPoints: [join(root, "qa/card-number-visual-harness.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "cv-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "cv-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "cv-stub" }, (args) => ({
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
<title>Card / number legibility</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

// ── Reporting ──────────────────────────────────────────────────────────────
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

const boot = async (game, viewport) => {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(fileUrl);
  await page.waitForFunction(() => !!window.__cv?.mount, null, { timeout: 20000 });
  await page.evaluate((g) => window.__cv.mount(g), game);
  if (game === "solitaire") {
    await page.waitForSelector('[data-testid="solitaire-board"] button[data-card]', { timeout: 15000 });
  } else {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          'button[aria-label^="Tile "], button[aria-label^="Live tile "]',
        ).length === 40,
      null,
      { timeout: 15000 },
    );
  }
  await page.waitForTimeout(500);
  return { context, page, consoleErrors, pageErrors };
};

const tagFor = (label, viewport) => `${label} @ ${viewport.width}×${viewport.height}`;

// ═══════════════════════════════════════════════════════════════════════════
// SOLITAIRE DUEL — cards at every supported width
// ═══════════════════════════════════════════════════════════════════════════
for (const viewport of [
  { width: 320, height: 844 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  const { context, page, consoleErrors, pageErrors } = await boot("solitaire", viewport);
  const tag = tagFor("Solitaire Duel", viewport);
  const m = await page.evaluate(() => {
    const board = document.querySelector('[data-testid="solitaire-board"]');
    const cards = [...document.querySelectorAll('[data-testid="solitaire-board"] button[data-card]')];
    const first = cards[0];
    const rank = first?.querySelector("span span");
    const suit = rank?.nextElementSibling;
    const rect = board?.getBoundingClientRect();
    const cardRect = first?.getBoundingClientRect();
    const cs = first ? getComputedStyle(first) : null;
    return {
      columns: document.querySelectorAll('[data-testid^="solitaire-column-"]').length,
      cards: cards.length,
      boardWidth: rect?.width ?? 0,
      boardBottom: rect?.bottom ?? 0,
      cardWidth: cardRect?.width ?? 0,
      cardHeight: cardRect?.height ?? 0,
      rankSize: rank ? parseFloat(getComputedStyle(rank).fontSize) : 0,
      rankText: rank?.textContent ?? "",
      suitText: suit?.textContent ?? "",
      borderColor: cs?.borderTopColor ?? "",
      borderWidth: cs?.borderTopWidth ?? "",
      focusable: first?.classList.contains("gr-focusable") ?? false,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  console.log(
    `   ${tag}: board ${Math.round(m.boardWidth)}px, ${m.cards} face-up cards, card ${m.cardWidth}×${m.cardHeight}, rank ${m.rankSize}px`,
  );
  check(`${tag}: all seven tableau columns render`, m.columns === 7, `${m.columns}`);
  check(`${tag}: the board never scrolls sideways`, m.overflow <= 0, `overflow=${m.overflow}px`);
  check(
    `${tag}: the board stays inside the viewport`,
    m.boardWidth <= m.viewportWidth,
    `${Math.round(m.boardWidth)} ≤ ${m.viewportWidth}`,
  );
  check(
    `${tag}: cards keep their 1:1.42 playing-card ratio`,
    Math.abs(m.cardHeight / Math.max(1, m.cardWidth) - 1.42) <= 0.02,
    `${(m.cardHeight / Math.max(1, m.cardWidth)).toFixed(3)}`,
  );
  check(
    `${tag}: the rank numeral stays at least 9px`,
    m.rankSize >= 9,
    `${m.rankSize}px "${m.rankText}${m.suitText}"`,
  );
  check(`${tag}: every card carries the shared dark outline`, m.borderColor === "rgb(5, 16, 31)" && m.borderWidth === "2px", `${m.borderWidth} ${m.borderColor}`);
  check(`${tag}: cards are wired to the shared focus ring`, m.focusable);

  // Pick up the black 5 in column 1 (it can land on the red 6 in column 3).
  await page.click('[data-testid="solitaire-card-1-3"]');
  // Park the pointer away from the card: the app's global
  // `.cursor-pointer:hover` rule lifts a hovered card by exactly 1px and would
  // otherwise mask the selected card's own lift.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  const held = await page.evaluate(() => {
    const board = document.querySelector('[data-testid="solitaire-board"]');
    const selected = document.querySelector('[data-testid="solitaire-card-1-3"]');
    const target = document.querySelector('[data-testid="solitaire-column-3"] button[data-card]');
    const heldCs = selected ? getComputedStyle(selected) : null;
    const targetCs = target ? getComputedStyle(target) : null;
    return {
      selectedKind: board?.getAttribute("data-selected") ?? "",
      dashed: heldCs?.outlineStyle ?? "",
      outlineColor: heldCs?.outlineColor ?? "",
      transform: heldCs?.transform ?? "",
      targetRing: target?.classList.contains("ring-2") ?? false,
      targetShadow: targetCs?.boxShadow ?? "",
      selectedClass: selected?.className ?? "",
    };
  });
  check(
    `${tag}: clicking a movable card selects it`,
    held.selectedKind === "tableau",
    `data-selected=${held.selectedKind}`,
  );
  check(
    `${tag}: the held card uses the shared DASHED selection outline`,
    held.dashed === "dashed" && held.outlineColor === "rgb(245, 255, 59)",
    `${held.dashed} ${held.outlineColor}`,
  );
  check(
    `${tag}: the held card visibly lifts out of the stack`,
    /-translate-y-\[3px\]/.test(held.selectedClass) && /matrix\(1, 0, 0, 1, 0, -3\)/.test(held.transform),
    `${held.transform} lift=${/-translate-y-\[3px\]/.test(held.selectedClass)}`,
  );
  check(
    `${tag}: the legal target uses a SOLID cyan ring (shape, not hue alone)`,
    held.targetRing && /0, 229, 255/.test(held.targetShadow),
    `${held.targetRing ? "ring-2" : "no ring"} ${held.targetShadow.slice(0, 60)}`,
  );

  await page.screenshot({ path: join(REPORTS, `card-number-solitaire-${viewport.width}.png`) });

  const structural = structuralErrors([...consoleErrors, ...pageErrors]);
  check(`${tag}: no structural / hydration errors`, structural.length === 0, structural.slice(0, 2).join(" | "));
  await context.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// KENO PVP — number tiles at every supported width
// ═══════════════════════════════════════════════════════════════════════════
for (const viewport of [
  { width: 320, height: 844 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  const { context, page, consoleErrors, pageErrors } = await boot("keno", viewport);
  const tag = tagFor("Keno PvP", viewport);
  const m = await page.evaluate(() => {
    const all = [
      ...document.querySelectorAll(
        'button[aria-label^="Tile "], button[aria-label^="Live tile "]',
      ),
    ];
    const live = document.querySelector('button[aria-label^="Live tile "]');
    const rects = all.map((el) => el.getBoundingClientRect());
    const numeric = all
      .map((el) => parseFloat(getComputedStyle(el).fontSize))
      .filter((n) => Number.isFinite(n));
    const nonLive = all.find((el) => !el.getAttribute("aria-label").startsWith("Live tile"));
    const nonLiveCs = nonLive ? getComputedStyle(nonLive) : null;
    const liveCs = live ? getComputedStyle(live) : null;
    const byAria = (prefix) =>
      all.find((el) => (el.getAttribute("aria-label") || "").startsWith(prefix));
    const mine = byAria("Tile 3 claimed by you");
    const theirs = byAria("Tile 4 claimed by your opponent");
    const both = byAria("Tile 5 claimed by you and your opponent");
    const missed = byAria("Tile 6 went unclaimed");
    const marker = (el, selector) => Boolean(el?.querySelector(selector));
    // The numeral must stay readable: a marker may not sit on top of it.
    const numberBox = (el) => el?.querySelector("span.relative.z-0")?.getBoundingClientRect();
    const overlapsNumber = (el, selector) => {
      const n = numberBox(el);
      const m = el?.querySelector(selector)?.getBoundingClientRect();
      if (!n || !m) return false;
      return m.left < n.right && m.right > n.left && m.top < n.bottom && m.bottom > n.top;
    };
    const pips = [...document.querySelectorAll('[aria-label$="lives left"]')];
    const oppPips = pips[1] ? [...pips[1].children] : [];
    return {
      count: all.length,
      square: rects.every((r) => Math.abs(r.width - r.height) <= 1),
      minWidth: Math.min(...rects.map((r) => r.width)),
      minFont: Math.min(...numeric),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      nonLiveBorder: `${nonLiveCs?.borderTopWidth} ${nonLiveCs?.borderTopColor}`,
      liveBorder: `${liveCs?.borderTopWidth} ${liveCs?.borderTopColor}`,
      livePulse: live?.classList.contains("animate-pulse") ?? false,
      liveBar: live
        ? [...live.querySelectorAll("span")].some((s) => s.className.includes("h-1") && s.getAttribute("style")?.includes("width"))
        : false,
      focusable: all.every((el) => el.classList.contains("gr-focusable")),
      mineDot: marker(mine, "span.rounded-full"),
      oppDiamond: marker(theirs, "span.rotate-45"),
      bothDot: marker(both, "span.rounded-full"),
      bothDiamond: marker(both, "span.rotate-45"),
      missedAnnounced: /lost a life/.test(missed?.getAttribute("aria-label") || ""),
      markerOverlap:
        overlapsNumber(mine, "span.rounded-full") ||
        overlapsNumber(both, "span.rotate-45") ||
        overlapsNumber(both, "span.rounded-full"),
      oppPipShape: oppPips[0]?.className.includes("rotate-45") ?? false,
      myPipShape: oppPips.length
        ? (pips[0]?.children?.[0]?.className.includes("rounded-full") ?? false)
        : false,
    };
  });
  console.log(
    `   ${tag}: 40 tiles, smallest ${m.minWidth.toFixed(1)}px, numeral ${m.minFont}px`,
  );
  check(`${tag}: the full 1–40 board renders`, m.count === 40, `${m.count}`);
  check(`${tag}: every number tile stays square`, m.square);
  check(
    `${tag}: every tile keeps a 24px touch target`,
    m.minWidth >= 24,
    `${m.minWidth.toFixed(1)}px`,
  );
  check(`${tag}: the numerals stay at least 12px`, m.minFont >= 12, `${m.minFont}px`);
  check(`${tag}: the board never scrolls sideways`, m.overflow <= 0, `overflow=${m.overflow}px`);
  check(
    `${tag}: every tile carries the shared dark outline`,
    m.nonLiveBorder === "2px rgb(5, 16, 31)",
    m.nonLiveBorder,
  );
  check(
    `${tag}: the live tile is ringed with the shared target colour`,
    m.liveBorder === "2px rgb(234, 246, 255)",
    m.liveBorder,
  );
  check(`${tag}: the live tile still pulses`, m.livePulse);
  check(`${tag}: the live tile still shows its countdown bar`, m.liveBar);
  check(`${tag}: every tile is wired to the shared focus ring`, m.focusable);
  check(`${tag}: your claim is a DOT, not colour alone`, m.mineDot);
  check(`${tag}: the opponent's claim is a DIAMOND`, m.oppDiamond);
  check(`${tag}: a shared tile shows both markers`, m.bothDot && m.bothDiamond);
  check(`${tag}: a missed tile is announced as a lost life`, m.missedAnnounced);
  check(
    `${tag}: no ownership marker covers the numeral`,
    !m.markerOverlap,
    m.markerOverlap ? "marker intersects the number" : "clear",
  );
  check(
    `${tag}: seat pips differ by shape (circle vs diamond)`,
    m.myPipShape && m.oppPipShape,
    `mine circle=${m.myPipShape} opp diamond=${m.oppPipShape}`,
  );

  await page.screenshot({ path: join(REPORTS, `card-number-keno-${viewport.width}.png`) });

  const structural = structuralErrors([...consoleErrors, ...pageErrors]);
  check(`${tag}: no structural / hydration errors`, structural.length === 0, structural.slice(0, 2).join(" | "));
  await context.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
