// qa/lane-rush-opponent-check.mjs
//
// Drives qa/lane-rush-opponent-harness.jsx — the REAL Lane Rush match page
// with a scripted bot match — and reports what the page actually renders and
// plays for the OPPONENT's moves:
//
//   1. mounting on a match already in progress announces nothing (the load
//      baseline must swallow the history) and fires no cue;
//   2. the bot's survived tiles show on the SHARED board (badge + marker);
//   3. a safe pick / bank / bust each announce themselves and fire exactly
//      one restrained, distinct cue — a peek fires none;
//   4. the board's own bust marker names what the run lost;
//   5. a peek leaves a persistent "which level are they scouting" read-out;
//   6. re-delivering the same snapshot (the 5s poll / a socket re-push) never
//      replays or extends any of it;
//   7. no React nesting / hydration / runtime error surfaces anywhere;
//   8. the creator PORTRAIT frame (real shell + real portrait branch) renders
//      the same feedback at phone width, and screenshots are written;
//   9. PHASE 3 — state transitions: nothing on a live board animates forever
//      (proved by pixel-comparing an idle board, not by trusting animation
//      objects), a bust banner retires on the seat's next resolved action
//      including the hold/peek cases the engine's own rule leaves alone, the
//      bankable amount cues once and the button is then still, a peek card
//      narrates only its own row, the 1,000-banked target cues once and
//      holds a static mark, and a repeated snapshot restarts none of it.
//
// Run: npm run verify:lane-rush-opponent
//
// It runs fully offline: Clerk, the socket, the router, analytics, the
// nav/footer, the waiting takeover and the creator-mode HOST are stubbed by
// the esbuild step; the match payload comes from a stubbed `fetch`, so this is
// a MOCKED bot match — no auth, no database, no dev server involved.
//
// Run: node qa/lane-rush-opponent-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "lane-rush-opponent-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// ── Stubs (everything noisy around the match page) ─────────────────────────
// NOTE: `components/creator-mode/CreatorModeLayout` is deliberately NOT
// stubbed — the real shell primitives and the real <CreatorView> portrait
// branch are what the portrait phase checks. Only the HOST (recording chrome)
// and the creator-mode PROVIDER (which selects the frame dimensions) are.
const STUBS = {
  "next/navigation": `
    // Navigation is recorded so "the rematch/continue CTA actually goes
    // somewhere" is assertable, not just "a button exists".
    const record = (href) => { (window.__lr = window.__lr || {}).nav = ((window.__lr && window.__lr.nav) || []).concat([href]); };
    export const useRouter = () => ({ push: record, replace: record, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino/lane-runner/4242";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/image": `
    import React from "react";
    export default function Img() { return null; }
  `,
  "next/link": `
    import React from "react";
    export default function Link({ children }) { return children ?? null; }
  `,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
  "@clerk/nextjs": `
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "Tester" } });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });
    export const useClerk = () => ({ signOut() {} });
  `,
  // `lib/lane-rush-duel/constants.js` (pulled in for the shared tower rules)
  // imports node's crypto at module scope. The page only ever uses the pure
  // rule helpers, so a deterministic shim is enough to bundle it.
  crypto: `
    const zeros = (n) => "0".repeat(n);
    const createHash = () => {
      const h = { update: () => h, digest: (enc) => (enc === "hex" ? zeros(64) : zeros(32)) };
      return h;
    };
    const randomBytes = (n) => ({ toString: () => zeros(n * 2) });
    export default { createHash, randomBytes };
    export { createHash, randomBytes };
  `,
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: window.__lr.socket });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "components/navigation-bar": `export default function Nav() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/lobby/MatchWaiting": `
    import React from "react";
    export default function MatchWaiting() { return React.createElement("div", { "data-testid": "waiting" }); }
  `,
  "components/creator-mode/CreatorModeHost": `
    import React from "react";
    export default function Host({ children }) { return children ?? null; }
  `,
  // The frame geometry the recording shell + <CreatorView> read. Flipping
  // `__lr.portrait` before mounting is what puts the page in its 9:16 branch.
  "lib/creator-mode/CreatorModeProvider": `
    import React from "react";
    const noop = () => {};
    export const useCreatorMode = () => {
      const portrait = Boolean(window.__lr?.portrait);
      return {
        isCreatorMode: portrait,
        dimensions: portrait ? { width: 390, height: 693 } : { width: 1280, height: 720 },
        orientation: portrait ? "portrait" : "landscape",
        setDimensions: noop,
        start: noop,
        stop: noop,
      };
    };
    export const CreatorModeProvider = ({ children }) => children ?? null;
    export default { useCreatorMode, CreatorModeProvider };
  `,
  // Celebration spy: "how many bursts, how big" without a real canvas.
  // `withReducedMotion` mirrors the real implementation exactly, so the
  // result panel's entrance sequencing is the shipped one.
  "lib/animations": `
    const staticMotion = { initial: false, animate: {}, exit: {}, transition: { duration: 0 } };
    export const withReducedMotion = (reduce, variant) => (reduce ? staticMotion : variant);
    export const fireConfetti = (opts) => {
      const w = (window.__lr = window.__lr || {});
      w.confetti = (w.confetti || []).concat([Number(opts?.particleCount) || 0]);
      return Promise.resolve();
    };
    export const celebrateWin = () => fireConfetti({ particleCount: 100 });
    export const fadeIn = staticMotion;
    export const fadeUp = staticMotion;
    export const modalMotion = { backdrop: staticMotion, panel: staticMotion };
    export const staticMotionExport = staticMotion;
    export const stagger = {};
    export const hoverScale = {};
    export const scorePop = {};
    export const buttonPulse = () => ({});
    export default { fireConfetti, withReducedMotion };
  `,
  // Audio spies: "which cue fired, how many times" without real Web Audio.
  "lib/gameAudio": `
    const rec = (name) => {
      const w = (window.__lr = window.__lr || { cues: [] });
      if (!w.cues) w.cues = [];
      w.cues.push(name);
    };
    export const playCardPlace = () => rec("playCardPlace");
    export const playCardDraw = () => rec("playCardDraw");
    export const playTurnSwitch = () => rec("playTurnSwitch");
    export const playVictory = () => rec("playVictory");
    export const playDefeat = () => rec("playDefeat");
    export const playTick = () => rec("playTick");
    export const playCountdownGo = () => rec("playCountdownGo");
    export const playCrash = () => rec("playCrash");
    export const playBuzz = () => rec("playBuzz");
    export const playGoodReveal = () => rec("playGoodReveal");
    export const playOpponentPick = () => rec("playOpponentPick");
    export const playOpponentBank = () => rec("playOpponentBank");
    export const playOpponentBust = () => rec("playOpponentBust");
    export const playSelect = () => rec("playSelect");
    export const playSafePick = () => rec("playSafePick");
    export const playBank = () => rec("playBank");
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
  entryPoints: [join(root, "qa/lane-rush-opponent-harness.jsx")],
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
      name: "lr-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "lr-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "lr-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── The app's REAL stylesheet ──────────────────────────────────────────────
// Compiled through the project's own PostCSS + Tailwind config, so the frames
// below are laid out with the shipped utilities (`animate-state-in`, the
// colours, the responsive breakpoints) — a screenshot of an unstyled DOM
// would prove nothing about how the feedback actually looks.
const compiled = await postcss([
  tailwindcss(join(root, "tailwind.config.js")),
  autoprefixer(),
]).process(readFileSync(join(root, "src/app/globals.css"), "utf8"), {
  from: join(root, "src/app/globals.css"),
});
// Drop the web-font @import: offline it is a guaranteed failed request.
const appCss = compiled.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, "");
writeFileSync(join(outDir, "app.css"), appCss);
console.log(`compiled stylesheet: ${(appCss.length / 1024).toFixed(0)}KB\n`);

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lane Rush opponent check</title>
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

// Every grouped figure in this app goes through toLocaleString(), and this
// environment's default locale groups with a narrow no-break space
// ("1 000"), not a comma. Normalise grouping before text assertions so they
// test the COPY rather than the machine's locale.
const ungroup = (value) =>
  String(value)
    .replace(/[\u00a0\u202f\u2009]/g, " ")
    .replace(/(\d) (?=(\d{3})+\b)/g, "$1,");
const bodyText = async (page) => ungroup(await page.evaluate(() => document.body.innerText));

const measureNotice = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="lane-runner-opp-notice"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(r.top + r.height / 2),
    );
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      inViewport:
        r.top >= 0 &&
        r.left >= 0 &&
        r.bottom <= window.innerHeight &&
        r.right <= window.innerWidth,
      uncovered: Boolean(top && (top === el || el.contains(top))),
    };
  });

const text = (page, sel) =>
  page.evaluate(
    (s) =>
      document
        .querySelector(s)
        ?.textContent?.replace(/\s+/g, " ")
        .trim() ?? null,
    sel,
  );
const count = (page, sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const cues = (page) => page.evaluate(() => (window.__lr.cues || []).slice());
const confetti = (page) =>
  page.evaluate(() => (window.__lr.confetti || []).slice());
// Counted structurally (the caption inside the HIGHLIGHTED side box), so it
// can't be confused by the details row or by CSS text-transform.
const highlightedWinners = (page) =>
  count(page, '[class*="border-[#f5ff3b]/60"] [class*="text-[#f5ff3b]/70"]');
const navs = (page) => page.evaluate(() => (window.__lr.nav || []).slice());

const bootPage = async (viewport, extra = {}) => {
  const page = await browser.newPage({ viewport, ...extra });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(fileUrl);
  await page.waitForFunction(() => !!window.__lr?.mount, null, { timeout: 20000 });
  return { page, consoleErrors, pageErrors };
};

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1 — desktop / normal layout, the full opponent event script
// ═══════════════════════════════════════════════════════════════════════════
const { page, consoleErrors, pageErrors } = await bootPage({
  width: 1280,
  height: 900,
});

// Mount on a match that is ALREADY in progress.
await page.evaluate(() => {
  window.__lr.set();
  window.__lr.mount();
});
await page.waitForSelector('[data-testid="lane-runner-opp-status"]', {
  timeout: 10000,
  state: "attached",
});

// 1. The load baseline: history is not news — no notice, no cue.
check(
  "mounting mid-match fires no opponent cue",
  (await cues(page)).length === 0,
  JSON.stringify(await cues(page)),
);
check(
  "mounting mid-match shows no opponent notice (history is the baseline)",
  (await count(page, '[data-testid="lane-runner-opp-notice"]')) === 0,
);
const idleStatus = (await text(page, '[data-testid="lane-runner-opp-status"]')) || "";
check(
  "the opponent slot shows their level when idle",
  idleStatus.startsWith("Level 3"),
  `status=${JSON.stringify(idleStatus)}`,
);
check(
  "…plus their live safe run, derived from the history",
  idleStatus.includes("🔥 2"),
  `status=${JSON.stringify(idleStatus)}`,
);

if (process.env.LR_DEBUG) {
  console.log(
    "      scroll debug: " +
      JSON.stringify(
        await page.evaluate(() => {
          const info = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), h: Math.round(r.height) };
          };
          const scrollers = [];
          document.querySelectorAll("*").forEach((el) => {
            if (el.scrollTop > 0) {
              scrollers.push({
                tag: el.tagName + "." + String(el.className).slice(0, 40),
                scrollTop: Math.round(el.scrollTop),
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
              });
            }
          });
          return {
            winScrollY: Math.round(window.scrollY),
            docScrollTop: Math.round(document.scrollingElement.scrollTop),
            docScrollHeight: document.scrollingElement.scrollHeight,
            innerHeight: window.innerHeight,
            bodyTop: info(document.body),
            notice: info(
              document.querySelector('[data-testid="lane-runner-opp-notice"]'),
            ),
            status: info(
              document.querySelector('[data-testid="lane-runner-opp-status"]'),
            ),
            scrollers: scrollers.slice(0, 6),
          };
        }),
      ),
  );
}

// 2. The shared board: the bot's survived tiles are legible deductions.
const intel = await text(page, '[data-testid="lane-runner-intel"]');
check(
  "the bot's different-path pick shows as a board badge",
  intel === "Opp: Risky tile 1 ✓",
  `intel=${intel}`,
);
check(
  "the bot's same-path pick shows as a dashed tile marker",
  (await count(page, "button.border-dashed")) === 1,
  `markers=${await count(page, "button.border-dashed")}`,
);
check(
  "the marker uses the shared-tower glyph",
  (await page.evaluate(
    () => document.querySelector("button.border-dashed")?.textContent?.trim() ?? null,
  )) === "◉",
);

// 3. Opponent SAFE pick on a brand-new row.
await page.evaluate(() =>
  window.__lr.pushAction(
    {
      action: "pick",
      seat: "player2",
      userId: "AI_BOT",
      path: "balanced",
      tile: 0,
      round: 2,
      lane: 2,
      safe: true,
      points: 32,
      at: window.__lr.at(0),
    },
    { oppLane: 3, oppScore: 73 },
  ),
);
await page.waitForSelector('[data-testid="lane-runner-opp-notice"]', {
  timeout: 5000,
  state: "attached",
});
check(
  "an opponent safe pick is announced",
  (await text(page, '[data-testid="lane-runner-opp-notice"]')) ===
    "Cleared level 3 · +32",
  `notice=${await text(page, '[data-testid="lane-runner-opp-notice"]')}`,
);
const safeTone = await page.evaluate(
  () =>
    getComputedStyle(
      document.querySelector('[data-testid="lane-runner-opp-notice"]'),
    ).backgroundColor,
);
check(
  "…and fires exactly one restrained cue",
  (await cues(page)).join(",") === "playOpponentPick",
  JSON.stringify(await cues(page)),
);

// …and it really paints where a player will see it. Two measurements:
//   asPainted — exactly as the app left the page (the tower keeps its LIVE
//               row in view, so on a 900px desktop window the document is
//               already scrolled down and the header sits above the fold);
//   atTop     — after scrolling the page to the top, which is what proves
//               the announcement is correctly PLACED inside the opponent's
//               card (real size, on screen, uncovered) rather than rendered
//               somewhere off-canvas.
const asPainted = await measureNotice(page);
console.log(`      notice as painted: ${JSON.stringify(asPainted)}`);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
await page.waitForTimeout(150);
const atTop = await measureNotice(page);
console.log(`      notice at page top: ${JSON.stringify(atTop)}`);
check(
  "the notice renders at a real, readable size",
  Boolean(atTop && atTop.w > 40 && atTop.h > 10),
  JSON.stringify(atTop),
);
check(
  "…placed inside the opponent card: on screen and uncovered",
  Boolean(atTop?.inViewport && atTop?.uncovered),
  JSON.stringify(atTop),
);
check(
  "…horizontally inside the viewport",
  Boolean(atTop && atTop.x >= 0 && atTop.x + atTop.w <= 1280),
  JSON.stringify(atTop),
);
// Documented, not asserted: the tower auto-scrolls to the live row (shipped
// behaviour, untouched), which on a short desktop window carries the whole
// scoreboard — and therefore this notice — above the fold.
if (asPainted && !asPainted.inViewport) {
  console.log(
    `      OBSERVATION: as painted the notice sits at y=${asPainted.y} ` +
      `(the tower scrolled the document to keep the live row in view).`,
  );
}
await page.screenshot({
  path: join(REPORTS, "lane-rush-opponent-desktop-notice.png"),
});

// 4. Opponent BANK.
await page.evaluate(() =>
  window.__lr.pushAction(
    {
      action: "hold",
      seat: "player2",
      userId: "AI_BOT",
      round: 2,
      lane: 2,
      bankedTotal: 73,
      at: window.__lr.at(1000),
    },
    { oppBanked: 73, oppBanks: 1, oppHeld: true, oppRate: 0.5 },
  ),
);
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid="lane-runner-opp-notice"]')
      ?.textContent?.includes("Banked"),
  null,
  { timeout: 5000 },
);
check(
  "an opponent bank is announced with what it locked",
  (await text(page, '[data-testid="lane-runner-opp-notice"]')) ===
    "Banked 73 · +73 locked",
  `notice=${await text(page, '[data-testid="lane-runner-opp-notice"]')}`,
);
check(
  "…and fires the distinct bank cue",
  (await cues(page)).join(",") === "playOpponentPick,playOpponentBank",
  JSON.stringify(await cues(page)),
);

// 5. A second safe pick, then the BUST (the run that was live gets wiped).
await page.evaluate(() =>
  window.__lr.pushAction(
    {
      action: "pick",
      seat: "player2",
      userId: "AI_BOT",
      path: "balanced",
      tile: 1,
      round: 3,
      lane: 3,
      safe: true,
      points: 40,
      at: window.__lr.at(2000),
    },
    { oppLane: 4, oppScore: 113 },
  ),
);
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid="lane-runner-opp-notice"]')
      ?.textContent?.includes("Cleared level 4"),
  null,
  { timeout: 5000 },
);
check(
  "a second safe pick announces the new level",
  (await text(page, '[data-testid="lane-runner-opp-notice"]')) ===
    "Cleared level 4 · +40",
  `notice=${await text(page, '[data-testid="lane-runner-opp-notice"]')}`,
);

await page.evaluate(() =>
  window.__lr.pushAction(
    {
      action: "pick",
      seat: "player2",
      userId: "AI_BOT",
      path: "balanced",
      tile: 0,
      round: 3,
      lane: 3,
      safe: false,
      at: window.__lr.at(3000),
    },
    // Their 73 stays banked (locked) — the bust only wipes the live run.
    { oppLane: 4, oppScore: 73, oppBanked: 73, oppBanks: 1 },
  ),
);
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid="lane-runner-opp-notice"]')
      ?.textContent?.includes("Busted"),
  null,
  { timeout: 5000 },
);
check(
  "an opponent bust says what the at-risk run cost",
  (await text(page, '[data-testid="lane-runner-opp-notice"]')) ===
    "Busted level 4 · −40 at risk",
  `notice=${await text(page, '[data-testid="lane-runner-opp-notice"]')}`,
);
const bustTone = await page.evaluate(
  () =>
    getComputedStyle(
      document.querySelector('[data-testid="lane-runner-opp-notice"]'),
    ).backgroundColor,
);
check(
  "a bust notice is visually distinct from a safe one",
  safeTone !== bustTone,
  `safe=${safeTone} bust=${bustTone}`,
);
// The bust must read as “their run is gone, their bank is not” at a glance:
// the at-risk figure collapses to 0 while the banked figure stays put.
const riskLines = await page.$$eval("p", (els) =>
  els
    .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
    .filter((t) => t.startsWith("At risk")),
);
check(
  "after the bust the opponent's at-risk run reads 0 with 73 still banked",
  riskLines.includes("At risk 0 · banked 73"),
  JSON.stringify(riskLines),
);
// The bust is the moment the whole board + header are worth looking at.
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
await page.waitForTimeout(150);
await page.screenshot({
  path: join(REPORTS, "lane-rush-opponent-desktop-bust.png"),
});
check(
  "…and fires the low, dull bust cue (not the player's own buzz)",
  (await cues(page)).join(",") ===
    "playOpponentPick,playOpponentBank,playOpponentPick,playOpponentBust",
  JSON.stringify(await cues(page)),
);
const bustBadge = (await text(page, '[data-testid="lane-runner-opp-bust"]')) || "";
check(
  "the board's own row marker names the same loss",
  bustBadge.includes("Opp busted") && bustBadge.includes("40"),
  `badge=${JSON.stringify(bustBadge)}`,
);

// 6. Opponent PEEK — the only public peek fact is the LEVEL.
await page.evaluate(() =>
  window.__lr.pushAction(
    {
      action: "peek",
      seat: "player2",
      userId: "AI_BOT",
      round: 4,
      lane: 4,
      at: window.__lr.at(4000),
    },
    { oppLane: 4 },
  ),
);
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid="lane-runner-opp-notice"]')
      ?.textContent?.includes("Scouted"),
  null,
  { timeout: 5000 },
);
check(
  "an opponent peek is announced as a level only",
  (await text(page, '[data-testid="lane-runner-opp-notice"]')) === "Scouted level 5",
  `notice=${await text(page, '[data-testid="lane-runner-opp-notice"]')}`,
);
check(
  "a peek fires NO cue — it is information, not a play",
  (await cues(page)).length === 4,
  JSON.stringify(await cues(page)),
);
// The identifying fact must be the LEVEL alone: the server scrubs the
// scouted tile and its answer out of an opponent peek, so naming either
// would mean the page had guessed (or leaked) private information.
check(
  "the peek line names no tile and no answer (server scrubs both)",
  !/tile|safe|bad|✕|✓/i.test(
    (await text(page, '[data-testid="lane-runner-opp-notice"]')) || "",
  ),
  `notice=${await text(page, '[data-testid="lane-runner-opp-notice"]')}`,
);

// 7. Once the notice fades, the slot keeps showing the level they are on…
await page.waitForFunction(
  () => !document.querySelector('[data-testid="lane-runner-opp-notice"]'),
  null,
  { timeout: 8000 },
);
check(
  "the slot then reads 'Scouting L5' (a peek is their newest action)",
  (await text(page, '[data-testid="lane-runner-opp-status"]')) === "Scouting L5",
  `status=${await text(page, '[data-testid="lane-runner-opp-status"]')}`,
);

// 8. Replay safety: the same snapshot re-delivered must be inert.
const before = (await cues(page)).length;
await page.evaluate(() => window.__lr.redeliver(4));
await page.waitForTimeout(600);
check(
  "re-delivering the same snapshot fires no cue and shows no notice",
  (await count(page, '[data-testid="lane-runner-opp-notice"]')) === 0 &&
    (await cues(page)).length === before,
  `cues=${JSON.stringify(await cues(page))}`,
);

// 9. A NEW action still announces exactly once, and does not stack when the
//    snapshot that carries it is repeated.
await page.evaluate(() =>
  window.__lr.pushAction(
    {
      action: "pick",
      seat: "player2",
      userId: "AI_BOT",
      path: "safe",
      tile: 2,
      round: 5,
      lane: 5,
      safe: true,
      points: 50,
      at: window.__lr.at(5000),
    },
    { oppLane: 6, oppScore: 123 },
  ),
);
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid="lane-runner-opp-notice"]')
      ?.textContent?.includes("Cleared level 6"),
  null,
  { timeout: 5000 },
);
const afterPush = (await cues(page)).length;
const noticeBefore = await text(page, '[data-testid="lane-runner-opp-notice"]');
await page.evaluate(() => window.__lr.redeliver(3));
await page.waitForTimeout(400);
check(
  "repeating the snapshot that carried a new action adds nothing",
  (await cues(page)).length === afterPush &&
    (await text(page, '[data-testid="lane-runner-opp-notice"]')) === noticeBefore,
  `cues=${JSON.stringify(await cues(page))}`,
);

// 9b. The scouting read-out is not sticky: it describes the newest resolved
//     action only, so once the bot resolves something else it is gone.
await page.waitForFunction(
  () => !document.querySelector('[data-testid="lane-runner-opp-notice"]'),
  null,
  { timeout: 8000 },
);
const afterScout = (await text(page, '[data-testid="lane-runner-opp-status"]')) || "";
check(
  "the scouting read-out clears once the bot plays something else",
  // oppLane 6 (0-based row) → level 7, and no "Scouting" chip anymore.
  afterScout.startsWith("Level 7") && !afterScout.includes("Scouting"),
  `status=${JSON.stringify(afterScout)}`,
);

// 10. Completion: the shared result screen mounts — ONCE — with the settled
//     state, the reason the race ended, and its celebration.
await page.evaluate(() => {
  window.__lr.set({
    status: "finished",
    winnerId: "user_1",
    result: "player1",
    // Settled: the winner locked 1,000 (the target) off a 1,040 score, the
    // bot stopped at 730.
    p1Points: 1040,
    p2Points: 730,
    myScore: 1040,
    myBanked: 1000,
    oppScore: 730,
    oppBanked: 730,
    myHeld: true,
    oppHeld: true,
    prizePaid: 47.5,
    endedAt: window.__lr.at(0),
  });
  window.__lr.redeliver(1);
});
await page.waitForFunction(
  () => /You banked 1[\s\u00a0\u202f]000/.test(document.body.innerText),
  null,
  { timeout: 8000 },
);
check("the finished duel mounts the shared result screen", true);
check(
  "exactly ONE result screen is mounted (no doubled overlay/celebration)",
  (await count(page, '[role="dialog"]')) === 1,
  `dialogs=${await count(page, '[role="dialog"]')}`,
);
await page.waitForFunction(
  () => (window.__lr.confetti || []).length >= 3,
  null,
  { timeout: 4000 },
);
check(
  "the win celebrates once — three bursts, none oversized",
  (await confetti(page)).length === 3 &&
    (await confetti(page)).every((n) => n > 0 && n <= 90),
  JSON.stringify(await confetti(page)),
);
check(
  "the reason the race ended is spelled out",
  (await bodyText(page)).includes("You banked 1,000 and took the pot"),
);
check(
  "exactly one side is marked as the winner",
  (await highlightedWinners(page)) === 1,
  `winners=${await highlightedWinners(page)}`,
);
check(
  "the final-race read-out shows both locked totals toward the target",
  (await count(page, '[data-testid="lane-runner-final-race"]')) === 1 &&
    /final race · first to 1,000 banked/i.test(await bodyText(page)),
);
check(
  "the winner's meter is marked as having reached the target",
  (await count(page, '[data-testid="lane-runner-final-race"] [class*="ring-amber-300/70"]')) === 1,
);
await page.screenshot({
  path: join(REPORTS, "lane-rush-result-win.png"),
});
await page.screenshot({
  path: join(REPORTS, "lane-rush-opponent-desktop-finished.png"),
});

// 11. The screenshot is worth something: the marker is really dashed and the
//     board fits the frame.
check(
  "a same-path intel tile really renders a dashed border",
  (await page.evaluate(() => {
    const el = document.querySelector("button.border-dashed");
    return el ? getComputedStyle(el).borderTopStyle : null;
  })) === "dashed",
);
const overflow = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  nodes: document.querySelectorAll("*").length,
}));
check(
  "the desktop board does not overflow horizontally",
  overflow.scrollWidth <= overflow.clientWidth + 1,
  JSON.stringify(overflow),
);
check(
  "the page actually rendered (not a blank screenshot)",
  overflow.nodes > 60,
  `nodes=${overflow.nodes}`,
);

// 12. Nothing structural blew up while all of that ran.
const fatal = consoleErrors.filter((e) =>
  /validateDOMNesting|descendant of|hydration|Hydration|Cannot read|Cannot update|is not a function|unique "key"/i.test(
    e,
  ),
);
check(
  "no React nesting / hydration / runtime console error",
  fatal.length === 0,
  fatal.join(" | "),
);
check("no uncaught page error", pageErrors.length === 0, pageErrors.join(" | "));
await page.close();

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — the creator PORTRAIT frame (real shell + real portrait branch)
// ═══════════════════════════════════════════════════════════════════════════
const portrait = await bootPage({ width: 390, height: 693 });
const ppage = portrait.page;
await ppage.evaluate(() => {
  window.__lr.setPortrait(true);
  window.__lr.set();
  window.__lr.mount();
});
await ppage.waitForSelector('[data-testid="lane-runner-opp-status"]', {
  timeout: 10000,
  state: "attached",
});
check(
  "the portrait phase renders the creator portrait layout",
  (await ppage.evaluate(() =>
    document
      .querySelector("[data-creator-layout]")
      ?.getAttribute("data-creator-layout"),
  )) === "portrait",
);
check(
  "the portrait aside (pick / bank controls) is mounted",
  (await ppage.evaluate(
    () => document.querySelector('[data-creator-part="aside"]') !== null,
  )) === true,
);
check(
  "the portrait header carries both scoreboard cards",
  (await count(ppage, '[data-testid="lane-runner-opp-status"]')) === 1,
);
await ppage.evaluate(() =>
  window.__lr.pushAction(
    {
      action: "pick",
      seat: "player2",
      userId: "AI_BOT",
      path: "balanced",
      tile: 0,
      round: 2,
      lane: 2,
      safe: true,
      points: 32,
      at: window.__lr.at(0),
    },
    { oppLane: 3, oppScore: 73 },
  ),
);
await ppage.waitForSelector('[data-testid="lane-runner-opp-notice"]', {
  timeout: 5000,
  state: "attached",
});
check(
  "the opponent notice also renders in the portrait frame",
  (await text(ppage, '[data-testid="lane-runner-opp-notice"]')) ===
    "Cleared level 3 · +32",
  `notice=${await text(ppage, '[data-testid="lane-runner-opp-notice"]')}`,
);
await ppage.screenshot({
  path: join(REPORTS, "lane-rush-opponent-portrait.png"),
});
const portraitOverflow = await ppage.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));
check(
  "the portrait frame does not overflow horizontally either",
  portraitOverflow.scrollWidth <= portraitOverflow.clientWidth + 1,
  JSON.stringify(portraitOverflow),
);
const portraitPaint = await measureNotice(ppage);
console.log(`      portrait notice: ${JSON.stringify(portraitPaint)}`);
check(
  "the notice stays readable and inside the 390px frame at phone width",
  Boolean(
    portraitPaint &&
      portraitPaint.w > 40 &&
      portraitPaint.h > 10 &&
      portraitPaint.x >= 0 &&
      portraitPaint.x + portraitPaint.w <= 390,
  ),
  JSON.stringify(portraitPaint),
);
// …and the creator phone frame gets the COMPACT result panel (the repo's
// convention for a result mounted inside the recording frame), sized to fit.
await ppage.evaluate((payload) => window.__lr.set(payload), {
  status: "finished",
  winnerId: "user_1",
  result: "player1",
  p1Points: 1040,
  p2Points: 730,
  myScore: 1040,
  myBanked: 1000,
  oppScore: 730,
  oppBanked: 730,
  myHeld: true,
  oppHeld: true,
  prizePaid: 47.5,
  endedAt: null,
});
await ppage.evaluate(() => window.__lr.redeliver(1));
await ppage.waitForSelector('[role="dialog"]', { timeout: 8000 });
const portraitPanel = await ppage.evaluate(() => {
  const panel = document.querySelector('[role="dialog"] > div');
  const r = panel?.getBoundingClientRect();
  return {
    compact: /max-w-\[22rem\]/.test(String(panel?.className)),
    w: r ? Math.round(r.width) : null,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
  };
});
check(
  "the portrait frame mounts ONE compact result panel that fits 390px",
  portraitPanel.compact && portraitPanel.dialogs === 1 && portraitPanel.w <= 390,
  JSON.stringify(portraitPanel),
);
check(
  "…with the same settled content (score + reason)",
  /You banked 1[\s\u00a0\u202f]000/.test(await ppage.evaluate(() => document.body.innerText)) &&
    (await count(ppage, '[data-testid="lane-runner-final-race"]')) === 1,
);
await ppage.screenshot({
  path: join(REPORTS, "lane-rush-result-portrait.png"),
});
const portraitFatal = portrait.consoleErrors.filter((e) =>
  /validateDOMNesting|descendant of|hydration|Cannot read|is not a function/i.test(
    e,
  ),
);
check(
  "the portrait pass raises no structural error",
  portraitFatal.length === 0 && portrait.pageErrors.length === 0,
  [...portraitFatal, ...portrait.pageErrors].join(" | "),
);
await ppage.close();

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — STATE TRANSITIONS: one-shot, retired by real state, never replayed
// ═══════════════════════════════════════════════════════════════════════════
// A fresh desktop mount, driven through the transitions this pass polishes:
// a bust that retires when the seat plays on, the bankable amount cueing
// once, a peek card narrating only its own row, and the 1,000-banked target
// cueing once then holding still — with a repeated snapshot restarting none
// of it.
const t = await bootPage({ width: 1280, height: 900 });
const tpage = t.page;
await tpage.evaluate(() => {
  window.__lr.set();
  window.__lr.mount();
});
await tpage.waitForSelector('[data-testid="lane-runner-bank-button"]', {
  timeout: 10000,
  state: "attached",
});

const pushMine = (action, overrides) =>
  tpage.evaluate(
    ([a, o]) => window.__lr.pushAction(a, o),
    [action, overrides],
  );
const mine = (fields) => ({
  seat: "player1",
  userId: "user_1",
  path: "balanced",
  ...fields,
});
// NB: the banner's heading is CSS-uppercased, so `innerText` reports
// "BUST ON LEVEL 2" — match it case-insensitively.
const bustBannerShowing = () =>
  tpage.evaluate(() => /bust on level/i.test(document.body.innerText));
const runningAnimations = (sel) =>
  tpage.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return el
      .getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => a.effect?.getTiming?.().iterations ?? null);
  }, sel);

// 1. Nothing on a LIVE board animates forever. (The detector is self-tested
//    against a deliberately infinite element first, so a pass means
//    something.)
const detected = await tpage.evaluate(() => {
  const probe = document.createElement("div");
  probe.style.animation = "stateIn 1s linear infinite";
  document.body.appendChild(probe);
  const n = document
    .getAnimations()
    .filter((a) => a.effect?.getTiming?.().iterations === Infinity).length;
  probe.remove();
  return n;
});
check(
  "the permanent-animation detector detects a permanent animation",
  detected === 1,
  `detected=${detected}`,
);
// A CSS-declared loop (a weaker guard: it only sees animations that declare
// `infinite` on one WAAPI animation).
const foreverCount = async () =>
  tpage.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming?.().iterations === Infinity).length,
  );
check(
  "no CSS animation declares an infinite loop on the live board",
  (await foreverCount()) === 0,
  `infinite=${await foreverCount()}`,
);
// …and the guard that cannot be fooled: an idle live board must be
// PIXEL-IDENTICAL 700ms later. This catches permanent motion however it is
// implemented — including framer-motion re-triggering finite keyframes,
// which declares no `infinite` iteration and sails past any inspection of
// animation objects. (Verified against the button pulse this pass removed:
// it fails on that code and passes on this one.)
// Bring the bank button (and the side column) into frame first — a motion
// check that films an empty part of the page proves nothing.
await tpage.evaluate(() => {
  document
    .querySelector('[data-testid="lane-runner-bank-button"]')
    ?.scrollIntoView({ block: "center", behavior: "instant" });
});
await tpage.waitForTimeout(800);
const idleA = await tpage.screenshot();
await tpage.waitForTimeout(700);
const idleB = await tpage.screenshot();
check(
  "an idle live board does not move at all (no permanent animation)",
  idleA.equals(idleB),
  `identical=${idleA.equals(idleB)} bytes=${idleA.length}/${idleB.length}`,
);

// 2. A bust announces itself, then retires the moment the seat's newest
//    resolved action is something else. The engine's own "latest bust" rule
//    already clears on a later pick/flag, so this pins the cases it does NOT
//    cover — a HOLD or a PEEK — which is exactly the overlap this pass
//    removes (a bust banner never shares the screen with the bank banner or
//    the peek card).
const badgeOnBoard = () =>
  tpage.evaluate(() =>
    [...document.querySelectorAll("span")].some((e) =>
      (e.textContent || "").includes("Bust · "),
    ),
  );
await pushMine(
  mine({
    action: "pick",
    round: 1,
    lane: 1,
    tile: 0,
    safe: false,
    at: "2026-09-20T10:00:00.000Z",
  }),
  { myLane: 1, myScore: 10, myBanked: 0 },
);
await tpage.waitForFunction(
  () => /bust on level/i.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
check("a bust announces itself", true);
check("the board keeps the bust as a row badge", await badgeOnBoard());
await tpage.screenshot({
  path: join(REPORTS, "lane-rush-transitions-bust.png"),
});
// …then a PEEK becomes the newest resolved action (a peek neither resolves
// the row nor touches the run, so only the new rule retires the banner).
await pushMine(
  mine({
    action: "peek",
    round: 1,
    lane: 1,
    tile: 1,
    peekResult: "safe",
    at: "2026-09-20T10:00:05.000Z",
  }),
  { myLane: 1, myScore: 10, myBanked: 0 },
);
await tpage.waitForFunction(
  () => !/bust on level/i.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
check("…and retires on an action the engine's bust rule leaves alone", true);
await tpage.waitForFunction(
  () => (window.__lr.cues || []).includes("playGoodReveal"),
  null,
  { timeout: 5000 },
);
check(
  "a private peek result is voiced (safe reveal)",
  true,
  JSON.stringify(await cues(tpage)),
);
check(
  "…without losing the row badge (the loss stays on the board)",
  await badgeOnBoard(),
);
check(
  "…and the busted row's ✕ tile is still marked",
  (await tpage.evaluate(
    () =>
      document.querySelectorAll('button[class*="from-red-600"]').length,
  )) >= 1,
);
// Retrying that row successfully is what finally clears the badge — the
// engine's existing rule (untouched), asserted here so it is on record.
await pushMine(
  mine({
    action: "pick",
    round: 1,
    lane: 1,
    tile: 2,
    safe: true,
    points: 25,
    at: "2026-09-20T10:00:06.000Z",
  }),
  { myLane: 1, myScore: 35, myBanked: 0 },
);
await tpage.waitForFunction(
  () =>
    ![...document.querySelectorAll("span")].some((e) =>
      (e.textContent || "").includes("Bust · "),
    ),
  null,
  { timeout: 5000 },
);
check(
  "retrying the row successfully is what clears the badge (engine rule)",
  true,
);

// 3. The bankable amount cues once when it changes, then the button is
//    completely still (it used to breathe forever).
await pushMine(
  mine({
    action: "pick",
    round: 2,
    lane: 2,
    tile: 2,
    safe: true,
    points: 40,
    at: "2026-09-20T10:00:10.000Z",
  }),
  { myLane: 3, myScore: 75, myBanked: 0 },
);
await tpage.waitForFunction(
  () =>
    (document.querySelector('[data-testid="lane-runner-bank-button"]')
      ?.textContent || "").includes("Bank 75"),
  null,
  { timeout: 5000 },
);
const labelNow = await runningAnimations(
  '[data-testid="lane-runner-bank-button"] span',
);
check(
  "a changed bankable amount cues once on the button",
  Array.isArray(labelNow) && labelNow.length === 1 && labelNow[0] === 1,
  JSON.stringify(labelNow),
);
await tpage.waitForTimeout(450);
check(
  "…and the button is then completely still",
  (await runningAnimations('[data-testid="lane-runner-bank-button"] span'))
    ?.length === 0,
);

// 4. A peek card narrates only the row it was spent on; the answer itself
//    stays on the board as the peeked tile's own mark.
const peekMarks = () =>
  tpage.evaluate(
    () => document.querySelectorAll('button[class*="from-orange-500"]').length,
  );
await pushMine(
  mine({
    action: "peek",
    round: 3,
    lane: 3,
    tile: 1,
    peekResult: "bad",
    at: "2026-09-20T10:00:15.000Z",
  }),
  { myLane: 3 },
);
await tpage.waitForSelector('[data-testid="lane-runner-peek-card"]', {
  timeout: 5000,
  state: "attached",
});
check(
  "a private peek result shows while the seat is on that row",
  (await peekMarks()) >= 1,
  `marks=${await peekMarks()}`,
);
// Same tile INDEX as the peek above, different row: the reveal must speak
// again. Keying the dedup on the tile alone would have swallowed this cue.
check(
  "…and a peek on the same tile index in a new row still speaks",
  (await cues(tpage)).filter((c) => c === "playBuzz").length >= 1,
  JSON.stringify(await cues(tpage)),
);
await pushMine(
  mine({
    action: "pick",
    round: 3,
    lane: 3,
    tile: 2,
    safe: true,
    points: 55,
    at: "2026-09-20T10:00:20.000Z",
  }),
  { myLane: 4, myScore: 130, myBanked: 0 },
);
await tpage.waitForFunction(
  () => !document.querySelector('[data-testid="lane-runner-peek-card"]'),
  null,
  { timeout: 5000 },
);
check("…and retires once the seat climbs past that row", true);
check(
  "…while the peeked tile keeps its own ✕ mark on the board",
  (await peekMarks()) >= 1,
  `marks=${await peekMarks()}`,
);
check(
  "no stale bust banner joined it either",
  !(await bustBannerShowing()),
);

// 5. Reaching the 1,000-banked target cues ONCE and then holds a static mark.
await pushMine(
  mine({
    action: "hold",
    round: 4,
    lane: 4,
    bankedTotal: 1000,
    at: "2026-09-20T10:00:25.000Z",
  }),
  { myLane: 5, myScore: 1000, myBanked: 1000, myHeld: true, myBanks: 1 },
);
await tpage.waitForSelector('[class*="ring-amber-300/70"]', {
  timeout: 5000,
  state: "attached",
});
const reached = await tpage.evaluate(() => {
  const el = document.querySelector('[class*="ring-amber-300/70"]');
  return {
    cls: String(el.className),
    anims: el
      .getAnimations()
      .map((a) => ({
        iterations: a.effect?.getTiming?.().iterations ?? null,
        duration: a.effect?.getTiming?.().duration ?? null,
      })),
  };
});
check(
  "hitting the 1,000-banked target cues once and holds a static mark",
  reached.cls.includes("animate-state-in") &&
    reached.anims.length >= 1 &&
    reached.anims.every((a) => a.iterations === 1),
  JSON.stringify(reached),
);
await tpage.screenshot({
  path: join(REPORTS, "lane-rush-transitions-target.png"),
});
await tpage.waitForTimeout(450);
check(
  "…and the reached mark is still there, with no animation running",
  (await count(tpage, '[class*="ring-amber-300/70"]')) === 1 &&
    (await runningAnimations('[class*="ring-amber-300/70"]'))?.length === 0,
);

// 6. Re-delivering the same snapshot restarts NOTHING: no banner returns, no
//    retired card comes back, no cue replays.
await tpage.evaluate(() => window.__lr.redeliver(4));
await tpage.waitForTimeout(600);
check(
  "a repeated snapshot resurrects no retired feedback",
  !(await bustBannerShowing()) &&
    (await count(tpage, '[data-testid="lane-runner-peek-card"]')) === 0,
);
check(
  "…and restarts no one-shot that already played",
  (await foreverCount()) === 0 &&
    (await runningAnimations('[data-testid="lane-runner-bank-button"] span'))
      ?.length === 0,
);
const transitionFatal = t.consoleErrors.filter((e) =>
  /validateDOMNesting|descendant of|hydration|Cannot read|is not a function/i.test(
    e,
  ),
);
check(
  "the transition pass raises no structural error",
  transitionFatal.length === 0 && t.pageErrors.length === 0,
  [...transitionFatal, ...t.pageErrors].join(" | "),
);
await tpage.close();

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4 — THE RESULT EXPERIENCE: win / loss / draw / resignation / bust
// ═══════════════════════════════════════════════════════════════════════════
const r = await bootPage({ width: 1280, height: 900 });
const rpage = r.page;
// Land the finished snapshot WITHOUT mounting first, so the very first thing
// on screen is the result (and its entrance is measurable).
await rpage.evaluate(
  (payload) => window.__lr.set(payload),
  {
    status: "finished",
    winnerId: "user_1",
    result: "player1",
    p1Points: 1040,
    p2Points: 730,
    myScore: 1040,
    myBanked: 1000,
    oppScore: 730,
    oppBanked: 730,
    myHeld: true,
    oppHeld: true,
    prizePaid: 47.5,
    endedAt: null,
  },
);
await rpage.evaluate(() => window.__lr.mount());
await rpage.waitForSelector('[role="dialog"]', { timeout: 10000 });

// The entrance: the panel is still moving right after it appears, and is
// completely still a beat later (no endless animation, no permanent glow).
const panelTransform = () =>
  rpage.evaluate(
    () =>
      getComputedStyle(document.querySelector('[role="dialog"] > div'))
        .transform,
  );
const enteredNonIdentity = (await panelTransform()) !== "none";
await rpage.waitForTimeout(900);
const settledOnce = (await panelTransform()) === "none";
check(
  "the result panel has a real entrance and then settles",
  enteredNonIdentity && settledOnce,
  `entering=${await panelTransform()}`,
);
await rpage.waitForTimeout(200);
const resultA = await rpage.screenshot();
await rpage.waitForTimeout(700);
const resultB = await rpage.screenshot();
check(
  "a settled result screen does not move at all (no endless animation)",
  resultA.equals(resultB),
  `identical=${resultA.equals(resultB)}`,
);
await rpage.waitForFunction(
  () => (window.__lr.confetti || []).length >= 3,
  null,
  { timeout: 4000 },
);
check(
  "a win celebrates once — three restrained bursts",
  (await confetti(rpage)).length === 3 &&
    (await confetti(rpage)).every((n) => n > 0 && n <= 90),
  JSON.stringify(await confetti(rpage)),
);
check(
  "the win reads as a win, with exactly one emphasised winner",
  /YOU WON/i.test(await rpage.evaluate(() => document.body.innerText)) &&
    (await highlightedWinners(rpage)) === 1,
  `winners=${await highlightedWinners(rpage)}`,
);
check(
  "the scores are shown, and the loser's is the muted one",
  (await count(rpage, '[class*="border-[#f5ff3b]/60"]')) === 1 &&
    (await count(rpage, '[class*="border-white/10"][class*="opacity-70"]')) >= 1,
);

// Details carry the deciding fact, not just an ID.
await rpage.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent || "").trim().startsWith("Match Details"),
  );
  btn?.click();
});
await rpage.waitForFunction(
  () => document.body.innerText.includes("Won by"),
  null,
  { timeout: 5000 },
);
check(
  "Match Details names what won it (1,000 banked)",
  (await bodyText(rpage)).includes("Won by") &&
    (await bodyText(rpage)).includes("1,000 banked"),
);

// Repeated snapshots must not re-announce or re-celebrate the same result.
await rpage.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog) dialog.__lrProbe = "kept";
  window.__lr.redeliver(4);
});
await rpage.waitForTimeout(700);
check(
  "repeating the finished snapshot neither re-mounts nor re-celebrates it",
  (await count(rpage, '[role="dialog"]')) === 1 &&
    (await confetti(rpage)).length === 3 &&
    (await rpage.evaluate(
      () => document.querySelector('[role="dialog"]')?.__lrProbe ?? null,
    )) === "kept",
);
check(
  "the result is voiced once — one victory cue, and no defeat cue on a win",
  (await cues(rpage)).filter((c) => c === "playVictory").length === 1 &&
    !(await cues(rpage)).includes("playDefeat"),
  JSON.stringify(await cues(rpage)),
);

// LOSS — same screen, no celebration, the OTHER side is the emphasised one.
await rpage.evaluate(() =>
  window.__lr.set({
    status: "finished",
    winnerId: "AI_BOT",
    result: "player2",
    p1Points: 730,
    p2Points: 1180,
    myScore: 730,
    myBanked: 730,
    oppScore: 1180,
    oppBanked: 1000,
    myHeld: true,
    oppHeld: true,
    prizePaid: 0,
    endedAt: window.__lr.at(0),
  }),
);
await rpage.evaluate(() => window.__lr.redeliver(1));
await rpage.waitForFunction(
  () => /They banked 1[\s\u00a0\u202f]000 first/.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
check(
  "a loss reads as a loss, explains itself, and is not celebrated",
  /DEFEAT/i.test(await rpage.evaluate(() => document.body.innerText)) &&
    (await confetti(rpage)).length === 3 &&
    (await count(rpage, '[role="dialog"]')) === 1,
);
check(
  "…with the opponent as the single emphasised winner",
  (await highlightedWinners(rpage)) === 1 &&
    /their locked 1,000 crossed the target first/i.test(await bodyText(rpage)),
);

// DRAW — neutral: nothing highlighted, nothing celebrated.
await rpage.evaluate(() =>
  window.__lr.set({
    status: "finished",
    winnerId: null,
    result: "draw",
    p1Points: 500,
    p2Points: 500,
    myScore: 500,
    myBanked: 500,
    oppScore: 500,
    oppBanked: 500,
    prizePaid: 0,
    endedAt: window.__lr.at(0),
  }),
);
await rpage.evaluate(() => window.__lr.redeliver(1));
await rpage.waitForFunction(
  () => /\bDRAW\b/.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
check(
  "a draw is neutral — no winner, no celebration, both stakes returned",
  (await highlightedWinners(rpage)) === 0 &&
    (await confetti(rpage)).length === 3 &&
    /both players receive their stake back/i.test(await bodyText(rpage)) &&
    /neither seat reached the target/i.test(await bodyText(rpage)),
);

// RESIGNATION — the other existing end-state, named as such.
await rpage.evaluate(() => {
  window.__lr.pushAction("resign", {
    status: "finished",
    winnerId: "user_1",
    result: "player1",
    p1Points: 240,
    p2Points: 90,
    myScore: 240,
    myBanked: 240,
    oppScore: 90,
    oppBanked: 90,
    prizePaid: 47.5,
    endedAt: window.__lr.at(0),
  });
});
await rpage.waitForFunction(
  () => document.body.innerText.includes("Opponent resigned"),
  null,
  { timeout: 5000 },
);
check(
  "a resignation is named as the reason, not as a target win",
  (await bodyText(rpage)).includes("Opponent resigned — the pot is yours") &&
    /the duel ended by resignation/i.test(await bodyText(rpage)) &&
    !(await bodyText(rpage)).includes("crossed the target first"),
);
check(
  "…and never claims a target nobody reached",
  (await count(rpage, '[class*="ring-amber-300/70"]')) === 0,
  `reached-marks=${await count(rpage, '[class*="ring-amber-300/70"]')}`,
);

// BUST immediately before the result: the run that was lost reads as zero,
// and the screen still explains the finish.
// Reset the history first: the resignation above is still in it, and a
// settled match can only have ended one way.
await rpage.evaluate(() =>
  window.__lr.set({
    status: "finished",
    winnerId: "AI_BOT",
    result: "player2",
    p1Points: 0,
    p2Points: 1000,
    myScore: 0,
    myBanked: 0,
    oppScore: 1000,
    oppBanked: 1000,
    prizePaid: 0,
    endedAt: window.__lr.at(0),
  }),
);
await rpage.evaluate(() =>
  window.__lr.pushAction(
    {
      action: "pick",
      seat: "player1",
      userId: "user_1",
      path: "balanced",
      tile: 0,
      round: 4,
      lane: 4,
      safe: false,
      at: "2026-09-20T11:00:00.000Z",
    },
    {
      status: "finished",
      winnerId: "AI_BOT",
      result: "player2",
      p1Points: 0,
      p2Points: 1000,
      myScore: 0,
      myBanked: 0,
      oppScore: 1000,
      oppBanked: 1000,
      prizePaid: 0,
      endedAt: window.__lr.at(0),
    },
  ),
);
await rpage.waitForFunction(
  () => /They banked 1[\s\u00a0\u202f]000 first/.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
check(
  "a bust right before the result does not confuse it (0 banked, still explained)",
  /0 banked/i.test(await bodyText(rpage)) &&
    (await count(rpage, '[data-testid="lane-runner-final-race"]')) === 1,
);

// The CTA is obvious AND wired to the existing flow (rematch logic untouched).
const ctas = await rpage.evaluate(() =>
  [...document.querySelectorAll("button")]
    .map((b) => (b.textContent || "").trim())
    .filter((t) => /run it back|return to lobby/i.test(t)),
);
check(
  "the continue/rematch actions are present and unambiguous",
  ctas.length === 2 &&
    /run it back/i.test(ctas.join("|")) &&
    /return to lobby/i.test(ctas.join("|")),
  JSON.stringify(ctas),
);
await rpage.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    /run it back/i.test(b.textContent || ""),
  );
  btn?.click();
});
await rpage.waitForTimeout(200);
check(
  "…and the primary CTA runs the existing Lane Rush flow",
  (await navs(rpage)).includes("/casino/lane-runner"),
  JSON.stringify(await navs(rpage)),
);
const resultFatal = r.consoleErrors.filter((e) =>
  /validateDOMNesting|descendant of|hydration|Cannot read|is not a function/i.test(
    e,
  ),
);
check(
  "the result pass raises no structural error",
  resultFatal.length === 0 && r.pageErrors.length === 0,
  [...resultFatal, ...r.pageErrors].join(" | "),
);
await rpage.close();

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — REDUCED MOTION: the same result, with no movement at all
// ═══════════════════════════════════════════════════════════════════════════
const rm = await bootPage({ width: 1280, height: 900 }, { reducedMotion: "reduce" });
const rmpage = rm.page;
await rmpage.evaluate(
  (payload) => window.__lr.set(payload),
  {
    status: "finished",
    winnerId: "user_1",
    result: "player1",
    p1Points: 1040,
    p2Points: 730,
    myScore: 1040,
    myBanked: 1000,
    oppScore: 730,
    oppBanked: 730,
    myHeld: true,
    oppHeld: true,
    prizePaid: 47.5,
    endedAt: null,
  },
);
await rmpage.evaluate(() => window.__lr.mount());
await rmpage.waitForSelector('[role="dialog"]', { timeout: 10000 });
const rmPanel = await rmpage.evaluate(() => ({
  transform: getComputedStyle(document.querySelector('[role="dialog"] > div'))
    .transform,
  dialogs: document.querySelectorAll('[role="dialog"]').length,
}));
check(
  "reduced motion: the result appears in place, with no entrance animation",
  rmPanel.transform === "none" && rmPanel.dialogs === 1,
  JSON.stringify(rmPanel),
);
await rmpage.waitForTimeout(500);
check(
  "reduced motion: no confetti is fired at all",
  (await confetti(rmpage)).length === 0,
  JSON.stringify(await confetti(rmpage)),
);
check(
  "reduced motion: the win is still fully readable (score, reason, target)",
  /YOU WON/i.test(await rmpage.evaluate(() => document.body.innerText)) &&
    /You banked 1[\s\u00a0\u202f]000/.test(
      await rmpage.evaluate(() => document.body.innerText),
    ) &&
    (await count(rmpage, '[data-testid="lane-runner-final-race"]')) === 1,
);
check(
  "reduced motion: nothing moves while the screen is idle",
  (await rmpage.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running").length,
  )) === 0,
);
const rmFatal = rm.consoleErrors.filter((e) =>
  /validateDOMNesting|descendant of|hydration|Cannot read|is not a function/i.test(
    e,
  ),
);
check(
  "the reduced-motion pass raises no structural error",
  rmFatal.length === 0 && rm.pageErrors.length === 0,
  [...rmFatal, ...rm.pageErrors].join(" | "),
);

// …and the same result screen, in place, for a LOSS and a DRAW: neither
// may fall back to movement or to confetti just because it is a different
// outcome, and both must stay readable.
const rmOutcome = async (label, payload, expect) => {
  // A fresh mount per outcome: `set()` only swaps the payload the stubbed
  // fetch returns, so the previous component instance has to go first.
  await rmpage.evaluate(() => window.__lr.unmount());
  await rmpage.evaluate((p) => window.__lr.set(p), payload);
  await rmpage.evaluate(() => window.__lr.mount());
  await rmpage.waitForSelector('[role="dialog"]', { timeout: 10000 });
  await rmpage.waitForTimeout(500);
  const state = await rmpage.evaluate(() => ({
    transform: getComputedStyle(document.querySelector('[role="dialog"] > div'))
      .transform,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    text: document.body.innerText,
  }));
  const shots = await rmpage.screenshot();
  await rmpage.waitForTimeout(700);
  const later = await rmpage.screenshot();
  check(
    `reduced motion: the ${label} appears in place, once, with no confetti`,
    state.transform === "none" &&
      state.dialogs === 1 &&
      (await confetti(rmpage)).length === 0 &&
      shots.equals(later),
    JSON.stringify({
      transform: state.transform,
      dialogs: state.dialogs,
      confetti: (await confetti(rmpage)).length,
      still: shots.equals(later),
    }),
  );
  check(
    `reduced motion: the ${label} is still fully readable`,
    expect.test(state.text),
    state.text.replace(/\s+/g, " ").slice(0, 90),
  );
};
await rmOutcome(
  "loss",
  {
    status: "finished",
    winnerId: "AI_BOT",
    result: "player2",
    p1Points: 730,
    p2Points: 1040,
    myScore: 730,
    myBanked: 730,
    oppScore: 1040,
    oppBanked: 1000,
    myHeld: true,
    oppHeld: true,
    prizePaid: 0,
    endedAt: null,
  },
  /YOU LOST|YOU LOSE/i,
);
await rmOutcome(
  "draw",
  {
    status: "finished",
    winnerId: null,
    result: "draw",
    p1Points: 500,
    p2Points: 500,
    myScore: 500,
    myBanked: 500,
    oppScore: 500,
    oppBanked: 500,
    myHeld: true,
    oppHeld: true,
    prizePaid: 0,
    endedAt: null,
  },
  /DRAW/i,
);
await rmpage.close();

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6 — AUDIO: one gesture, one cue, and nothing replays it
// ═══════════════════════════════════════════════════════════════════════════
// Audio is stubbed with spies (`window.__lr.cues`), so "which cue fired and
// exactly how many times" is assertable without Web Audio. The hierarchy the
// cues mirror is the visual one: the PRESS is voiced at the finger and claims
// nothing, the OUTCOME is voiced from the authoritative history only, and a
// poll / socket re-push / reload stays silent.
const au = await bootPage({ width: 1280, height: 900 });
const apage = au.page;
await apage.evaluate(() => {
  window.__lr.set();
  window.__lr.mount();
});
await apage.waitForSelector('[data-testid="lane-runner-bank-button"]', {
  timeout: 10000,
  state: "attached",
});
await apage.waitForTimeout(400);

const cuesNow = () => cues(apage);
const resetCues = () => apage.evaluate(() => {
  window.__lr.cues = [];
});
const waitForCue = async (name, timeout = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await cuesNow()).includes(name)) return true;
    await apage.waitForTimeout(40);
  }
  return false;
};
const pushMineA = (action, overrides) =>
  apage.evaluate(([x, o]) => window.__lr.pushAction(x, o), [action, overrides]);
const mineA = (fields) => ({
  seat: "player1",
  userId: "user_1",
  path: "balanced",
  ...fields,
});
// Tiles carry an aria-label naming their level and index and are `disabled`
// when they cannot be picked — so "the live, pickable tile" is selectable.
const liveTile = (tileNo) =>
  `button[aria-label^="Level 2 tile ${tileNo}"]`;

// 1. The press is voiced at the gesture, exactly once — and the POST can
//    never claim the outcome, so nothing else speaks for a tap.
await resetCues();
await apage.click(liveTile(2));
await waitForCue("playSelect");
await apage.waitForTimeout(500);
check(
  "a tile tap is voiced once (the press cue), with no outcome claimed",
  (await cuesNow()).join(",") === "playSelect",
  JSON.stringify(await cuesNow()),
);
// A second, rapid tap is a second gesture — and still only a press cue.
await apage.click(liveTile(3));
await apage.waitForTimeout(600);
check(
  "rapid re-taps stay one press cue each, never stacking or rattling",
  (await cuesNow()).join(",") === "playSelect,playSelect",
  JSON.stringify(await cuesNow()),
);

// 2. A safe pick is voiced from the AUTHORITATIVE history: once, and never
//    again for the same action however many snapshots re-deliver it.
await resetCues();
await pushMineA(
  mineA({
    action: "pick",
    round: 1,
    lane: 1,
    tile: 2,
    safe: true,
    points: 30,
    at: "2026-09-20T10:01:00.000Z",
  }),
  { myLane: 2, myScore: 40, myBanked: 0 },
);
const safeVoiced = await waitForCue("playSafePick");
check(
  "a survived pick confirms with its own cue, exactly once",
  safeVoiced && (await cuesNow()).join(",") === "playSafePick",
  JSON.stringify(await cuesNow()),
);
await apage.evaluate(() => window.__lr.redeliver(3));
await apage.waitForTimeout(700);
check(
  "…and repeating the snapshot (poll / socket re-push) replays nothing",
  (await cuesNow()).join(",") === "playSafePick",
  JSON.stringify(await cuesNow()),
);

// 3. Banking gets its own lock cue — once.
await resetCues();
await pushMineA(
  mineA({
    action: "hold",
    round: 1,
    lane: 1,
    bankedTotal: 40,
    at: "2026-09-20T10:02:00.000Z",
  }),
  { myLane: 2, myScore: 40, myBanked: 40, myHeld: true, myBanks: 1 },
);
const bankVoiced = await waitForCue("playBank");
check(
  "a bank locks in with its own cue, exactly once",
  bankVoiced && (await cuesNow()).join(",") === "playBank",
  JSON.stringify(await cuesNow()),
);
await apage.evaluate(() => window.__lr.redeliver(3));
await apage.waitForTimeout(700);
check(
  "…and the repeated snapshot replays neither the bank nor the safe cue",
  (await cuesNow()).join(",") === "playBank",
  JSON.stringify(await cuesNow()),
);

// 4. A bust keeps its own keyed buzz — never the safe rise — and says it once.
await resetCues();
await pushMineA(
  mineA({
    action: "pick",
    round: 1,
    lane: 1,
    tile: 0,
    safe: false,
    at: "2026-09-20T10:03:00.000Z",
  }),
  { myLane: 2, myScore: 40, myBanked: 40 },
);
const bustVoiced = await waitForCue("playBuzz");
const bustCues = await cuesNow();
check(
  "a bust buzzes once and never borrows the safe/bank cue",
  bustVoiced &&
    bustCues.filter((c) => c === "playBuzz").length === 1 &&
    !bustCues.includes("playSafePick") &&
    !bustCues.includes("playBank"),
  JSON.stringify(bustCues),
);
await apage.evaluate(() => window.__lr.redeliver(3));
await apage.waitForTimeout(700);
check(
  "…and the repeated snapshot never replays the bust",
  (await cuesNow()).filter((c) => c === "playBuzz").length === 1,
  JSON.stringify(await cuesNow()),
);
// The tile the seat just busted is not pickable, so tapping it is silent
// rather than firing a press cue for an action the game would refuse.
await resetCues();
await apage.click(liveTile(1), { force: true });
await apage.waitForTimeout(400);
check(
  "a tap on the already-busted tile stays silent (nothing to acknowledge)",
  (await cuesNow()).length === 0,
  JSON.stringify(await cuesNow()),
);

// 5. A peek speaks for its RESULT only (a reveal chime / buzz) — it is
//    information, not a play, so it never takes the safe or bank cue.
await resetCues();
await pushMineA(
  mineA({
    action: "peek",
    round: 1,
    lane: 1,
    tile: 3,
    peekResult: "safe",
    at: "2026-09-20T10:04:00.000Z",
  }),
  { myLane: 2, myScore: 40, myBanked: 40 },
);
const peekVoiced = await waitForCue("playGoodReveal");
const peekCues = await cuesNow();
check(
  "a safe peek reveals with its own chime, not a pick/bank cue",
  peekVoiced &&
    peekCues.join(",") === "playGoodReveal" &&
    !peekCues.includes("playSafePick"),
  JSON.stringify(peekCues),
);
await resetCues();
await pushMineA(
  mineA({
    action: "peek",
    round: 1,
    lane: 1,
    tile: 2,
    peekResult: "bad",
    at: "2026-09-20T10:05:00.000Z",
  }),
  { myLane: 2, myScore: 40, myBanked: 40 },
);
const badPeekVoiced = await waitForCue("playBuzz");
check(
  "a bad peek warns with the buzz — one cue, once",
  badPeekVoiced &&
    (await cuesNow()).join(",") === "playBuzz",
  JSON.stringify(await cuesNow()),
);

// 6. Reload / reconnect is a BASELINE, never news: the very same history,
//    delivered to a fresh mount, must be completely silent.
await resetCues();
await apage.evaluate(() => window.__lr.unmount());
await apage.evaluate(() => window.__lr.mount());
await apage.waitForSelector('[data-testid="lane-runner-bank-button"]', {
  timeout: 10000,
  state: "attached",
});
await apage.waitForTimeout(900);
check(
  "a reload/reconnect replays no cue from history it already voiced",
  (await cuesNow()).length === 0,
  JSON.stringify(await cuesNow()),
);

const auFatal = au.consoleErrors.filter((e) =>
  /Cannot read|is not a function|validateDOMNesting|hydration/i.test(e),
);
check(
  "the audio pass raises no runtime error",
  auFatal.length === 0 && au.pageErrors.length === 0,
  [...auFatal, ...au.pageErrors].join(" | "),
);
await apage.close();

// ── Mute probe ────────────────────────────────────────────────
// The page's cues are stubbed above (so "which cue, how often" is
// assertable), which means the STUB can't prove the mute gate — so this
// probe bundles the REAL `gameAudio` + `audioSettings` with no stubs at
// all, swaps in a counting AudioContext, and asserts the shipped gate
// itself: muted, the cue is silent and no context is even created;
// unmuted, the very same cue really does play.
await esbuild.build({
  stdin: {
    contents: `
      import * as audio from "./src/lib/gameAudio";
      import * as audioSettings from "./src/lib/audioSettings";
      window.__audio = audio;
      window.__audioSettings = audioSettings;
    `,
    resolveDir: root,
    loader: "js",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: join(outDir, "audio-probe.js"),
  logLevel: "error",
  absWorkingDir: root,
});
writeFileSync(
  join(outDir, "audio-probe.html"),
  `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="./audio-probe.js"></script></body></html>`,
);
const probe = await browser.newPage();
await probe.goto(pathToFileURL(join(outDir, "audio-probe.html")).href);
await probe.waitForFunction(() => !!window.__audio?.playSafePick);
const muteProbe = await probe.evaluate(() => {
  const rec = { osc: 0, ctx: 0 };
  const chain = () => ({ connect: () => chain() });
  class FakeCtx {
    constructor() {
      rec.ctx += 1;
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
    }
    resume() {}
    createOscillator() {
      rec.osc += 1;
      return {
        type: "",
        frequency: { value: 0 },
        connect: () => chain(),
        start() {},
        stop() {},
      };
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: () => chain(),
      };
    }
    createMediaStreamDestination() {
      return { stream: { getTracks: () => [] } };
    }
  }
  window.AudioContext = FakeCtx;
  window.webkitAudioContext = undefined;
  const { setAudioMuted } = window.__audioSettings;
  const audio = window.__audio;
  setAudioMuted(true);
  audio.playSelect();
  audio.playSafePick();
  audio.playBank();
  const whileMuted = { ...rec };
  setAudioMuted(false);
  audio.playSelect();
  audio.playSafePick();
  audio.playBank();
  return { whileMuted, afterUnmute: { ...rec } };
});
check(
  "muted: every Lane Rush cue is silent, with no audio context even built",
  muteProbe.whileMuted.osc === 0 && muteProbe.whileMuted.ctx === 0,
  JSON.stringify(muteProbe.whileMuted),
);
check(
  "unmuted: the very same cues really play (the probe has teeth)",
  muteProbe.afterUnmute.osc >= 3 && muteProbe.afterUnmute.ctx === 1,
  JSON.stringify(muteProbe.afterUnmute),
);
await probe.close();

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7 — REDUCED MOTION + ACCESSIBILITY (measured, not eyeballed)
// ═══════════════════════════════════════════════════════════════════════════
// The global CSS rule collapses CSS animation/transition, but Lane Rush's
// biggest movements are framer-motion (JS-driven). This phase pins both
// halves: with the media query ON nothing moves, and with it OFF the very
// same probes DO see movement (so the checks have teeth). Everything the
// state means must survive either way — colour, glyph, copy, aria.

const liveTileSel = 'button[aria-label^="Level 2 tile 1"]';
const transformOf = (pg, sel) =>
  pg.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return "MISSING";
    return getComputedStyle(el).transform;
  }, sel);
// The tile's own ROW (the level block), resolved from the tile in-page — the
// row is what carries the one-shot arrival.
const transformOfRow = (pg, sel) =>
  pg.evaluate((s) => {
    const el = document.querySelector(s);
    const row = el?.closest('div[class*="min-h-[84px]"]');
    if (!row) return "MISSING";
    return getComputedStyle(row).transform;
  }, sel);
const settle = (pg) => pg.waitForTimeout(400);

// ── Negative control: the SAME probe under normal motion DOES move ────────
const nm = await bootPage({ width: 1280, height: 900 });
await nm.page.evaluate(() => {
  window.__lr.set();
  window.__lr.mount();
});
await nm.page.waitForSelector(liveTileSel, { timeout: 10000 });
await nm.page.hover(liveTileSel);
await nm.page.waitForTimeout(350);
const normalHover = await transformOf(nm.page, liveTileSel);
check(
  "control: with motion on, a tile press/hover really does move (grown)",
  normalHover !== "none" && normalHover !== "MISSING",
  `transform=${normalHover}`,
);
const normalRowAnims = await nm.page.evaluate(() =>
  document
    .getAnimations()
    .filter((a) => a.playState === "running").length,
);
check(
  "control: the unfiltered page is not already animation-free",
  normalRowAnims >= 1 || normalHover !== "none",
  `running=${normalRowAnims}`,
);
await nm.page.close();

// ── Reduced motion: nothing moves, everything still reads ────────────────
const rm2 = await bootPage({ width: 1280, height: 900 }, { reducedMotion: "reduce" });
const rpage2 = rm2.page;
await rpage2.evaluate(() => {
  window.__lr.set();
  window.__lr.mount();
});
await rpage2.waitForSelector(liveTileSel, { timeout: 10000 });
await settle(rpage2);
check(
  "reduced motion: a tile does not scale on press/hover",
  (await transformOf(rpage2, liveTileSel)) === "none",
  `transform=${await transformOf(rpage2, liveTileSel)}`,
);
check(
  "reduced motion: the live row does not rise or sweep in",
  (await transformOfRow(rpage2, liveTileSel)) === "none",
  `transform=${await transformOfRow(rpage2, liveTileSel)}`,
);
// …yet the live row is still unmistakable: its own cyan border/wash is
// plain state, not motion.
const liveRowStyle = await rpage2.evaluate((s) => {
  const row = document.querySelector(s)?.closest('div[class*="min-h-[84px]"]');
  if (!row) return null;
  const cs = getComputedStyle(row);
  return { border: cs.borderTopColor, bg: cs.backgroundColor };
}, liveTileSel);
check(
  "reduced motion: the live row is still marked (its colour is state, not motion)",
  Boolean(liveRowStyle) &&
    liveRowStyle.border !== "rgba(0, 0, 0, 0)" &&
    liveRowStyle.bg !== "rgba(0, 0, 0, 0)",
  JSON.stringify(liveRowStyle),
);
await rpage2.waitForTimeout(800);
const rmA = await rpage2.screenshot();
await rpage2.waitForTimeout(700);
const rmB = await rpage2.screenshot();
check(
  "reduced motion: an idle board is pixel-identical (nothing loops)",
  rmA.equals(rmB),
  `identical=${rmA.equals(rmB)}`,
);

// A bust under reduced motion: no pop, but the tile AND the banner still
// state the whole story (what was lost, and that banked points were safe).
await rpage2.evaluate((action) => window.__lr.pushAction(action, {
  myLane: 2,
  myScore: 40,
  myBanked: 40,
}), {
  seat: "player1",
  userId: "user_1",
  path: "balanced",
  action: "pick",
  round: 1,
  lane: 1,
  tile: 0,
  safe: false,
  at: "2026-09-20T12:00:00.000Z",
});
await rpage2.waitForFunction(
  () => /bust on level/i.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
await settle(rpage2);
const rmBust = await rpage2.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    (b.getAttribute("aria-label") || "").includes("tile 1") &&
    (b.getAttribute("aria-label") || "").includes("busted"),
  );
  const banner = [...document.querySelectorAll('[role="status"]')].find((n) =>
    /bust on level/i.test(n.textContent || ""),
  );
  return {
    label: btn?.getAttribute("aria-label") || null,
    transform: btn ? getComputedStyle(btn).transform : "MISSING",
    glyph: (btn?.textContent || "").includes("✕"),
    figure: /−\s?\d/.test(btn?.textContent || ""),
    bannerText: (banner?.textContent || "").replace(/\s+/g, " ").trim(),
  };
});
check(
  "reduced motion: the bust tile still shows ✕ and what it cost (no pop needed)",
  rmBust.glyph && rmBust.figure && rmBust.transform === "none",
  JSON.stringify(rmBust),
);
check(
  "reduced motion: the bust is named in a live region, colour never alone",
  rmBust.bannerText.includes("Bust on level") &&
    /unbanked/.test(rmBust.bannerText) &&
    rmBust.bannerText.includes("is safe"),
  rmBust.bannerText,
);
check(
  "reduced motion: the bust tile's accessible name states loss + safety",
  Boolean(rmBust.label) &&
    rmBust.label.includes("busted") &&
    rmBust.label.includes("banked points are safe"),
  String(rmBust.label),
);

// A bank under reduced motion: the strip is simply there (no slide), with
// the moved/protected numbers readable. The bank strip is armed only from a
// REAL hold (it is the acknowledgement of your own action, not of a
// snapshot), so this drives the actual button: the authoritative history
// carries the hold the resync will resolve against.
await rpage2.evaluate((action) => window.__lr.pushAction(action, {
  myLane: 2,
  myScore: 40,
  myBanked: 40,
  myHeld: true,
  myBanks: 1,
}), {
  seat: "player1",
  userId: "user_1",
  path: "balanced",
  action: "hold",
  round: 1,
  lane: 1,
  bankedTotal: 40,
  at: "2026-09-20T12:01:00.000Z",
});
await rpage2.click('[data-testid="lane-runner-bank-button"]');
await rpage2.waitForFunction(
  () => /moved from at risk/i.test(document.body.innerText),
  null,
  { timeout: 8000 },
);
await settle(rpage2);
const rmBank = await rpage2.evaluate(() => {
  const strip = [...document.querySelectorAll('[role="status"]')].find((n) =>
    /moved from at risk/i.test(n.textContent || ""),
  );
  return {
    text: (strip?.textContent || "").replace(/\s+/g, " ").trim(),
    transform: strip ? getComputedStyle(strip).transform : "MISSING",
    opacity: strip ? getComputedStyle(strip).opacity : "0",
  };
});
check(
  "reduced motion: the bank strip is fully present without sliding in",
  rmBank.transform === "none" &&
    rmBank.opacity === "1" &&
    /moved from at risk/.test(rmBank.text) &&
    /banked and bust-proof/.test(rmBank.text),
  JSON.stringify(rmBank),
);

// A safe pick under reduced motion. Two distinct layers, both from real
// state: (a) the RESOLVED tile — history-derived ✓ + emerald fill, which is
// permanent board state and must survive motion being off; (b) the transient
// CONFIRM RING your own accepted pick earns, which is armed only by a real
// action (never by a snapshot) — so this drives the actual button.
await rpage2.evaluate((action) => window.__lr.pushAction(action, {
  myLane: 3,
  myScore: 70,
  myBanked: 40,
}), {
  seat: "player1",
  userId: "user_1",
  path: "balanced",
  action: "pick",
  round: 2,
  lane: 2,
  tile: 1,
  safe: true,
  points: 30,
  at: "2026-09-20T12:02:00.000Z",
});
await rpage2.waitForTimeout(300);
const rmSafe = await rpage2.evaluate(() => {
  const btn = document.querySelector('button[aria-label^="Level 3 tile 2"]');
  return {
    label: btn?.getAttribute("aria-label") || null,
    glyph: (btn?.textContent || "").includes("✓"),
    emerald: Boolean(btn && /from-emerald-500 to-green-700/.test(btn.className)),
    transform: btn ? getComputedStyle(btn).transform : "MISSING",
  };
});
check(
  "reduced motion: a resolved safe tile keeps ✓ + its emerald fill (no pop needed)",
  rmSafe.glyph && rmSafe.emerald && rmSafe.transform === "none",
  JSON.stringify(rmSafe),
);
check(
  "reduced motion: and its accessible name reports the safe resolution",
  /safe/i.test(String(rmSafe.label)),
  String(rmSafe.label),
);
// (b) the confirm ring: a real tap on that row, whose authoritative history
// already carries the matching safe pick.
await rpage2.evaluate((action) => window.__lr.pushAction(action, {
  myLane: 3,
  myScore: 70,
  myBanked: 40,
}), {
  seat: "player1",
  userId: "user_1",
  path: "balanced",
  action: "pick",
  round: 3,
  lane: 3,
  tile: 2,
  safe: true,
  points: 30,
  at: "2026-09-20T12:02:30.000Z",
});
await rpage2.click('button[aria-label^="Level 4 tile 3"]');
const ringSeen = await rpage2
  .waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((b) =>
        /ring-emerald-200\/90/.test(b.className),
      ),
    null,
    { timeout: 8000, polling: 30 },
  )
  .then(() => true)
  .catch(() => false);
const rmConfirm = await rpage2.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    /ring-emerald-200\/90/.test(b.className),
  );
  return {
    label: btn?.getAttribute("aria-label") || null,
    transform: btn ? getComputedStyle(btn).transform : "MISSING",
  };
});
check(
  "reduced motion: a confirmed pick shows the ring in place, with no scale pop",
  ringSeen && rmConfirm.transform === "none",
  JSON.stringify(rmConfirm),
);
// The opponent read-out still says what happened (its CSS cue is collapsed
// to its end state, the text remains).
await rpage2.evaluate((action) => window.__lr.pushAction(action, {}), {
  seat: "player2",
  userId: "AI_BOT",
  path: "risky",
  action: "pick",
  round: 2,
  lane: 2,
  tile: 0,
  safe: true,
  points: 20,
  at: "2026-09-20T12:03:00.000Z",
});
const rmOpp = await rpage2.waitForFunction(
  () => /Cleared level/i.test(document.body.innerText),
  null,
  { timeout: 5000 },
).then(() => true).catch(() => false);
check("reduced motion: an opponent action is still announced in words", rmOpp);
await rpage2.screenshot({ path: join(REPORTS, "lane-rush-reduced-motion.png") });
const rmFatal2 = rm2.consoleErrors.filter((e) =>
  /Cannot read|is not a function|validateDOMNesting|hydration/i.test(e),
);
check(
  "the reduced-motion pass raises no runtime error",
  rmFatal2.length === 0 && rm2.pageErrors.length === 0,
  [...rmFatal2, ...rm2.pageErrors].join(" | "),
);
await rpage2.close();

// ── Mobile + reduced motion: still playable at phone width ──────────────
const rmm = await bootPage(
  { width: 390, height: 693 },
  { reducedMotion: "reduce", isMobile: true, hasTouch: true },
);
const mpage = rmm.page;
await mpage.evaluate(() => {
  window.__lr.set();
  window.__lr.mount();
});
await mpage.waitForSelector(liveTileSel, { timeout: 10000 });
await mpage.waitForTimeout(500);
const rmmState = await mpage.evaluate((sel) => {
  const tile = document.querySelector(sel);
  const bank = document.querySelector('[data-testid="lane-runner-bank-button"]');
  const r = tile?.getBoundingClientRect();
  const b = bank?.getBoundingClientRect();
  return {
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    tile: r
      ? {
          inFrame: r.top >= 0 && r.bottom <= 693 && r.left >= 0 && r.right <= 390,
          h: Math.round(r.height),
          transform: getComputedStyle(tile).transform,
        }
      : "MISSING",
    bankInFrame: b ? b.top >= 0 && b.bottom <= 693 && b.right <= 390 : "MISSING",
  };
}, liveTileSel);
check(
  "mobile + reduced motion: no horizontal overflow, and the live tile is on screen",
  rmmState.overflow <= 1 &&
    rmmState.tile !== "MISSING" &&
    rmmState.tile.inFrame &&
    rmmState.tile.h >= 44 &&
    rmmState.tile.transform === "none",
  JSON.stringify(rmmState),
);
// The bank control sits below the tower on a phone, so "reachable" means
// scrollable into view with a real hitbox — not co-visible with the board.
const rmmBank = await mpage.evaluate(() => {
  const bank = document.querySelector('[data-testid="lane-runner-bank-button"]');
  if (!bank) return null;
  bank.scrollIntoView({ block: "center", behavior: "instant" });
  const b = bank.getBoundingClientRect();
  return {
    inFrame: b.top >= 0 && b.bottom <= 693 && b.left >= 0 && b.right <= 390,
    h: Math.round(b.height),
    overflow:
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
check(
  "mobile + reduced motion: the bank control scrolls into view with a ≥44px target",
  Boolean(rmmBank) && rmmBank.inFrame && rmmBank.h >= 44 && rmmBank.overflow <= 1,
  JSON.stringify(rmmBank),
);
await mpage.waitForTimeout(700);
const mmA = await mpage.screenshot();
await mpage.waitForTimeout(700);
const mmB = await mpage.screenshot();
check(
  "mobile + reduced motion: the phone board is pixel-identical while idle",
  mmA.equals(mmB),
  `identical=${mmA.equals(mmB)}`,
);
await mpage.close();

// ── Keyboard + focus + tap targets (normal page) ────────────────────────
const kb = await bootPage({ width: 1280, height: 900 });
const kpage = kb.page;
await kpage.evaluate(() => {
  window.__lr.set();
  window.__lr.mount();
});
await kpage.waitForSelector(liveTileSel, { timeout: 10000 });
await kpage.waitForTimeout(300);
// Tab through the page and record what a keyboard-only player can reach.
const stops = [];
for (let i = 0; i < 30; i += 1) {
  await kpage.keyboard.press("Tab");
  await kpage.waitForTimeout(30);
  const stop = await kpage.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return {
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute("aria-label") || "",
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
      focusVisible: el.matches(":focus-visible"),
    };
  });
  if (stop) stops.push(stop);
}
const tileStops = stops.filter((s) => /^Level \d+ tile \d+/.test(s.label));
const bankStop = stops.find((s) => s.text.startsWith("Bank"));
const chipStops = stops.filter((s) => /% safe/.test(s.text));
check(
  "keyboard: every tile is a focusable button with an accessible name",
  tileStops.length > 0 && tileStops.every((s) => s.label.length > 0),
  `tiles=${tileStops.length}`,
);
check(
  "keyboard: the bank button and the odds chips are reachable too",
  Boolean(bankStop) && chipStops.length >= 3,
  `bank=${Boolean(bankStop)} chips=${chipStops.length}`,
);
// A focus ring has to be VISIBLE, and computed box-shadow strings are a
// trap: Tailwind composes several layers, so a fully transparent shadow
// still reads as "not none". So this proves it the only way that cannot be
// faked — tab to the control, screenshot its box framed with a few px of
// margin (a ring is drawn OUTSIDE the border), blur, screenshot again, and
// require the pixels to differ.
const focusIndicatorDiff = async (pg, matcher) => {
  await pg.evaluate(() => document.activeElement?.blur?.());
  let box = null;
  for (let i = 0; i < 40; i += 1) {
    await pg.keyboard.press("Tab");
    await pg.waitForTimeout(20);
    box = await pg.evaluate((m) => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const label = el.getAttribute("aria-label") || "";
      const text = (el.textContent || "").trim();
      const ok =
        m.kind === "tile" ? /^Level \d+ tile \d+/.test(label) : text.startsWith(m.text);
      if (!ok) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        focusVisible: el.matches(":focus-visible"),
      };
    }, matcher);
    if (box) break;
  }
  if (!box) return { reached: false };
  const clip = {
    x: Math.max(0, Math.round(box.x) - 6),
    y: Math.max(0, Math.round(box.y) - 6),
    width: Math.round(box.w) + 12,
    height: Math.round(box.h) + 12,
  };
  await pg.waitForTimeout(300); // let the ring's own transition finish
  const settled = await pg.evaluate((m) => {
    const el = document.activeElement;
    if (!el) return null;
    const label = el.getAttribute("aria-label") || "";
    const text = (el.textContent || "").trim();
    const ok =
      m.kind === "tile" ? /^Level \d+ tile \d+/.test(label) : text.startsWith(m.text);
    if (!ok) return null;
    const cs = getComputedStyle(el);
    const alpha = (colour) => {
      const mm = String(colour).match(/rgba?\(([^)]*)\)/i);
      if (!mm) return /^(?:transparent)$/i.test(String(colour).trim()) ? 0 : 1;
      const parts = mm[1].split(",").map((p) => parseFloat(p.trim()));
      return parts.length === 4 ? parts[3] : 1;
    };
    // The DEFAULT outline is off when it is "none" or fully transparent
    // (Tailwind v3 spells `outline-none` as a transparent 2px outline, so
    // checking only outlineStyle would be wrong).
    const outlineVisible =
      cs.outlineStyle !== "none" && alpha(cs.outlineColor) > 0.05;
    // A Tailwind ring is several shadow layers, and a fully transparent
    // layer still reads as "not none" — so require a layer that is BOTH
    // non-transparent AND actually draws (a non-zero px radius).
    const shadowDrawn = (cs.boxShadow || "")
      .split(/,(?=\s*(?:rgba?\(|inset|var\())/i)
      .some((layer) => {
        const mm = layer.match(/rgba?\(([^)]*)\)/i);
        if (!mm) return false;
        const parts = mm[1].split(",").map((p) => parseFloat(p.trim()));
        if (!((parts.length === 4 ? parts[3] : 1) > 0.05)) return false;
        return [...layer.matchAll(/(-?\d+(?:\.\d+)?)px/g)].some(
          (x) => Math.abs(parseFloat(x[1])) > 0,
        );
      });
    return { outlineVisible, shadowDrawn, boxShadow: cs.boxShadow };
  }, matcher);
  const focused = await pg.screenshot({ clip });
  await pg.evaluate(() => document.activeElement?.blur?.());
  await pg.waitForTimeout(300);
  const blurred = await pg.screenshot({ clip });
  return {
    reached: true,
    focusVisible: box.focusVisible,
    // The pixels must actually change…
    changed: !focused.equals(blurred),
    // …the visible mark must be OURS (the default outline is off)…
    outlineSuppressed: settled ? !settled.outlineVisible : false,
    // …and it must be a drawn, non-transparent ring layer that changes them.
    shadowDrawn: Boolean(settled?.shadowDrawn),
  };
};
const focusIsVisible = (r) =>
  r.reached &&
  r.focusVisible &&
  r.changed &&
  r.outlineSuppressed &&
  r.shadowDrawn;
const tileFocus = await focusIndicatorDiff(kpage, { kind: "tile" });
check(
  "keyboard: a focused tile draws OUR visible ring (pixels change, UA outline off)",
  focusIsVisible(tileFocus),
  JSON.stringify(tileFocus),
);
const bankFocus = await focusIndicatorDiff(kpage, { kind: "text", text: "Bank" });
check(
  "keyboard: the bank button draws the same visible ring",
  focusIsVisible(bankFocus),
  JSON.stringify(bankFocus),
);
check(
  "keyboard: the tab order only contains real controls (no bare divs)",
  stops.length > 0 && stops.every((s) => s.tag === "button" || s.tag === "a"),
  JSON.stringify([...new Set(stops.map((s) => s.tag))]),
);
check(
  "keyboard: every stop exposes the keyboard focus state",
  stops.length > 0 && stops.every((s) => s.focusVisible),
  `focus-visible=${stops.filter((s) => s.focusVisible).length}/${stops.length}`,
);
// Tap targets: WCAG 2.5.8 (AA) is 24×24 CSS px; the board's tiles keep their
// larger hitbox on top of that.
const targets = await kpage.$$eval("button", (els) =>
  els.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      label: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || "",
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }),
);
const tooSmall = targets.filter((t) => t.w < 24 || t.h < 24);
check(
  "tap targets: no control is below the 24px minimum",
  tooSmall.length === 0,
  JSON.stringify(tooSmall),
);
const tiles = targets.filter((t) => /^Level \d+ tile \d+/.test(t.label));
check(
  "tap targets: every tile keeps a ≥44px hitbox",
  tiles.length > 0 && tiles.every((t) => t.w >= 44 && t.h >= 44),
  `tiles=${tiles.length} min=${Math.min(...tiles.map((t) => t.h))}px`,
);
await kpage.close();

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8 — RESPONSIVE / MOBILE: measured at real device widths
// ═══════════════════════════════════════════════════════════════════════════
// Everything here is measured from the real component + the real stylesheet.
// The tile hitbox stays the one Prompt 5 shipped (48px min / 56px desktop);
// nothing below depends on a hard-coded pixel position, because the board is
// a fluid `repeat(n, minmax(0,1fr))` grid and every feedback effect lives on
// its own element in normal flow (the page contains no absolutely-positioned
// overlay at all).
const scanWidth = async (w, h, opts = {}) => {
  const sp = await bootPage({ width: w, height: h }, opts);
  await sp.page.evaluate(() => {
    window.__lr.set();
    window.__lr.mount();
  });
  await sp.page.waitForSelector('button[aria-label^="Level 2 tile "]', {
    timeout: 10000,
  });
  await sp.page.waitForTimeout(400);
  const data = await sp.page.evaluate(() => {
    const de = document.documentElement;
    const r = (el) => el.getBoundingClientRect();
    const vh = window.innerHeight;
    const clipped = [...document.querySelectorAll("p,span,b")]
      .filter((el) => el.children.length === 0 && el.textContent.trim())
      .filter((el) => {
        const cs = getComputedStyle(el);
        return (
          el.scrollHeight > el.clientHeight + 1 ||
          (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1)
        );
      })
      .map((el) => ({
        text: el.textContent.trim().slice(0, 30),
        cls: String(el.className).slice(0, 60),
        intentional: String(el.className).includes("truncate"),
      }));
    const tiles = [...document.querySelectorAll('button[aria-label^="Level 2 tile "]')];
    const controls = [...document.querySelectorAll("button")].filter(
      (b) => !b.getAttribute("aria-label")?.startsWith("Level "),
    );
    const size = (el) => ({ w: Math.round(r(el).width), h: Math.round(r(el).height) });
    const byText = (needle) =>
      controls.find((b) => (b.textContent || "").includes(needle));
    const peek = byText("Peek (") || byText("Peek mode");
    const flag = byText("Flag mode") || byText("No flags");
    const chips = controls.filter((b) => / safe ·/.test(b.textContent || ""));
    const grid = document.querySelector("[class*='grid-cols-2']");
    const atRisk = [...document.querySelectorAll("p")].find((p) =>
      p.textContent.includes("At risk"),
    );
    return {
      vw: de.clientWidth,
      overflowX: de.scrollWidth - de.clientWidth,
      offenders: [...document.querySelectorAll("*")]
        .filter((el) => r(el).right > de.clientWidth + 1 || r(el).left < -1)
        .slice(0, 4)
        .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
      leakedComment: document.body.innerText
        .split("\n")
        .filter((l) => l.includes("//"))
        .slice(0, 2),
      clipped,
      tiles: tiles.length ? size(tiles[0]) : null,
      tilesInView: tiles.length
        ? tiles.every((b) => r(b).top >= 0 && r(b).bottom <= vh)
        : null,
      minControl: controls.length
        ? controls.reduce((m, b) => Math.min(m, size(b).w, size(b).h), 1e9)
        : null,
      under24: controls.filter((b) => size(b).w < 24 || size(b).h < 24).length,
      peek: peek ? size(peek) : null,
      flag: flag ? size(flag) : null,
      chip: chips.length ? size(chips[0]) : null,
      chipText: chips.length ? chips[0].textContent.trim().slice(0, 26) : null,
      bank: (() => {
        const b = document.querySelector('[data-testid="lane-runner-bank-button"]');
        return b ? size(b) : null;
      })(),
      atRiskH: atRisk ? Math.round(r(atRisk).height) : null,
      cards: grid
        ? [...grid.children].map((c) => size(c))
        : null,
      docH: de.scrollHeight,
    };
  });
  await sp.page.close();
  return { data, errors: [...sp.consoleErrors, ...sp.pageErrors] };
};

for (const [w, h, label, opts] of [
  [320, 568, "320px phone"],
  [360, 640, "360px phone"],
  [375, 667, "375px phone"],
  [390, 844, "390px phone"],
  [414, 896, "414px phone"],
  [430, 932, "430px phone"],
  [480, 800, "480px phablet"],
  [768, 1024, "768px tablet", { hasTouch: true }],
  [1024, 768, "1024px small desktop"],
  [1280, 900, "1280px desktop"],
  [1440, 900, "1440px desktop"],
  [844, 390, "844x390 landscape", { hasTouch: true }],
  [740, 360, "740x360 landscape", { hasTouch: true }],
]) {
  const { data: d, errors } = await scanWidth(w, h, opts);
  check(
    `${label}: no horizontal overflow and no element escapes the viewport`,
    d.overflowX <= 1 && d.offenders.length === 0,
    `overflow=${d.overflowX} ${JSON.stringify(d.offenders)}`,
  );
  check(
    `${label}: no clipped or ellipsised text (except an intentionally truncated name)`,
    d.clipped.every((c) => c.intentional),
    JSON.stringify(d.clipped.slice(0, 3)),
  );
  check(
    `${label}: no JS comment leaked into the rendered page`,
    d.leakedComment.length === 0,
    JSON.stringify(d.leakedComment),
  );
  check(
    `${label}: the live tiles are fully on screen and keep a ≥44px hitbox`,
    d.tiles && d.tilesInView && d.tiles.h >= 44 && d.tiles.w >= 44,
    JSON.stringify({ tiles: d.tiles, inView: d.tilesInView }),
  );
  check(
    `${label}: no control is below 24px, and the two mode chips are ≥36px`,
    d.under24 === 0 &&
      d.minControl >= 24 &&
      d.peek &&
      d.peek.h >= 36 &&
      d.flag &&
      d.flag.h >= 36,
    JSON.stringify({ under24: d.under24, min: d.minControl, peek: d.peek, flag: d.flag }),
  );
  check(
    `${label}: the odds chips stay tappable and show a rounded percentage`,
    d.chip &&
      d.chip.h >= 44 &&
      /^\d+% safe/.test(d.chipText || "") &&
      !/\d\.\d/.test(d.chipText || ""),
    JSON.stringify({ chip: d.chip, text: d.chipText }),
  );
  check(
    `${label}: the bank control is a full-width ≥44px target`,
    d.bank && d.bank.h >= 44,
    JSON.stringify(d.bank),
  );
  check(
    `${label}: the scoreboard's at-risk/banked line is a single 10px line`,
    d.atRiskH !== null && d.atRiskH <= 34,
    `h=${d.atRiskH}`,
  );
  check(
    `${label}: both score cards are laid out side by side`,
    d.cards && d.cards.length === 2 && d.cards.every((c) => c.w >= 120),
    JSON.stringify(d.cards),
  );
  check(
    `${label}: no runtime error at this width`,
    errors.filter((e) => /Cannot read|is not a function|hydration/i.test(e)).length === 0,
    errors.slice(0, 2).join(" | "),
  );
}

// ── The feedback itself on the narrowest screen: bust / bank / notice ──────
for (const [w, h, label] of [
  [320, 568, "320px phone"],
  [844, 390, "844x390 landscape"],
]) {
  const sp = await bootPage({ width: w, height: h }, { hasTouch: true });
  await sp.page.evaluate(() => {
    window.__lr.set();
    window.__lr.mount();
  });
  await sp.page.waitForSelector('button[aria-label^="Level 2 tile "]', {
    timeout: 10000,
  });
  await sp.page.evaluate(
    (a) => window.__lr.pushAction(a, {}),
    {
      seat: "player2",
      userId: "AI_BOT",
      path: "risky",
      action: "pick",
      round: 1,
      lane: 1,
      tile: 0,
      safe: false,
      at: "2026-09-20T15:00:00.000Z",
    },
  );
  await sp.page.waitForTimeout(400);
  const notice = await sp.page.evaluate(() => {
    const el = document.querySelector('[data-testid="lane-runner-opp-notice"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      text: el.textContent.trim(),
      ellipsised: cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1,
      fullyVisible: el.scrollHeight <= el.clientHeight + 1,
    };
  });
  check(
    `${label}: the opponent's action is not cut off (it wraps instead of ellipsising)`,
    Boolean(notice) &&
      !notice.ellipsised &&
      notice.fullyVisible &&
      /at risk/.test(notice.text),
    JSON.stringify(notice),
  );
  await sp.page.evaluate(
    (a) => window.__lr.pushAction(a, { myLane: 2, myScore: 40, myBanked: 0 }),
    {
      seat: "player1",
      userId: "user_1",
      path: "balanced",
      action: "pick",
      round: 1,
      lane: 1,
      tile: 1,
      safe: false,
      at: "2026-09-20T15:01:00.000Z",
    },
  );
  await sp.page.waitForTimeout(600);
  await sp.page.click('[data-testid="lane-runner-bank-button"]');
  await sp.page.waitForTimeout(900);
  const sv = await sp.page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const tiles = [...document.querySelectorAll('button[aria-label^="Level 2 tile "]')];
    const busted = tiles[1];
    const notices = [...document.querySelectorAll('[role="status"]')].map((n) => ({
      text: n.textContent.trim().replace(/\s+/g, " ").slice(0, 40),
      h: Math.round(r(n).height),
      cut: n.scrollHeight > n.clientHeight + 1,
      w: Math.round(r(n).width),
    }));
    return {
      tileCount: tiles.length,
      // The ✕ and the cost must be on the tile that was hit, and ONLY there.
      bustOnRightTile: /✕/.test(busted?.textContent || "") && /−10/.test(busted?.textContent || ""),
      bustOnOthers: tiles
        .filter((_, i) => i !== 1)
        .filter((b) => /✕/.test(b.textContent || "")).length,
      rowBadge: [...document.querySelectorAll("span")].some((e) =>
        /Bust · −10 unbanked/.test(e.textContent || ""),
      ),
      notices,
      noticesFitViewport: notices.every((n) => n.w <= window.innerWidth),
      overflowX:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check(
    `${label}: bust feedback stays anchored to the tile that was hit`,
    sv.bustOnRightTile && sv.bustOnOthers === 0 && sv.tileCount === 3,
    JSON.stringify(sv),
  );
  check(
    `${label}: bust + bank feedback is not clipped and stays inside the screen`,
    sv.rowBadge &&
      sv.notices.length >= 1 &&
      sv.notices.every((n) => !n.cut) &&
      sv.noticesFitViewport &&
      sv.overflowX <= 1,
    JSON.stringify({ badge: sv.rowBadge, notices: sv.notices, overflowX: sv.overflowX }),
  );
  await sp.page.close();
}

await browser.close();

// 13. The screenshots themselves must contain a rendered page, not a blank
//     frame — a uniform/empty capture compresses to a few hundred bytes.
const shots = [
  "lane-rush-opponent-desktop-notice.png",
  "lane-rush-opponent-desktop-bust.png",
  "lane-rush-opponent-desktop-finished.png",
  "lane-rush-opponent-portrait.png",
  "lane-rush-transitions-bust.png",
  "lane-rush-transitions-target.png",
  "lane-rush-result-win.png",
  "lane-rush-result-portrait.png",
];
const shotSizes = shots.map((f) => {
  const { size } = statSync(join(REPORTS, f));
  return `${f}=${(size / 1024).toFixed(1)}KB`;
});
check(
  "every screenshot captured real content",
  shots.every((f) => statSync(join(REPORTS, f)).size > 20_000),
  shotSizes.join(" "),
);
console.log(
  `\nScreenshots: qa/reports/lane-rush-opponent-{desktop-notice,desktop-bust,desktop-finished,portrait}.png` +
    ` + lane-rush-transitions-{bust,target}.png`,
);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
