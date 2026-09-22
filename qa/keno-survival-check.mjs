// qa/keno-survival-check.mjs
//
// Drives qa/keno-survival-harness.jsx — the REAL Keno PvP match page with a
// scripted SURVIVAL run — and reports what the page actually renders and sends:
//
//   1. the board renders all 40 tiles, and only the LIVE tile is tappable;
//   2. the live tile's window is read from the server clock (seconds + bar);
//   3. tapping the live tile posts { tile } to /catch and the board advances
//      to the new tile the server lit;
//   4. tapping any other tile sends nothing;
//   5. the scoreboard shows BOTH seats' lives and claimed tiles;
//   6. an opponent claim is announced ("… claimed tile N first — you lost a
//      life") and paints the tile gold;
//   7. a both-miss is announced and paints the tile red;
//   8. a claim that eliminates the opponent finishes the match exactly once,
//      with the shared result screen mounted;
//   9. the creator PORTRAIT frame (real shell + real portrait branch) renders
//      the same board at phone width with no horizontal overflow;
//  10. reduced motion renders a fully usable board (no lost state);
//  11. no React nesting / hydration / runtime error surfaces anywhere.
//
// Run: node qa/keno-survival-check.mjs
//
// Fully offline: Clerk, the socket, the router, analytics, nav/footer, the
// waiting takeover and the creator-mode HOST are stubbed by the esbuild step;
// the match payload comes from a stubbed `fetch`, so this is a MOCKED match —
// no auth, no database, no dev server.

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
const outDir = mkdtempSync(join(tmpdir(), "keno-survival-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// ── Stubs (everything noisy around the match page) ─────────────────────────
// `components/creator-mode/CreatorModeLayout` is deliberately NOT stubbed —
// the real shell primitives and the real <CreatorView> portrait branch are
// what the portrait phase checks. Only the HOST (recording chrome) and the
// creator-mode PROVIDER (which selects the frame dimensions) are.
const STUBS = {
  "next/navigation": `
    const record = (href) => { (window.__ks = window.__ks || {}).nav = ((window.__ks && window.__ks.nav) || []).concat([href]); };
    // Next returns a STABLE router object (it is memoised in the app router),
    // so the stub must too: a fresh identity per render would re-run every
    // effect that lists the router in its deps.
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
  `,
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: window.__ks.socket });
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
  "lib/creator-mode/CreatorModeProvider": `
    import React from "react";
    const noop = () => {};
    export const useCreatorMode = () => {
      const portrait = Boolean(window.__ks?.portrait);
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
  "lib/animations": `
    const staticMotion = { initial: false, animate: {}, exit: {}, transition: { duration: 0 } };
    export const withReducedMotion = (reduce, variant) => (reduce ? staticMotion : variant);
    export const fireConfetti = (opts) => {
      const w = (window.__ks = window.__ks || {});
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
  "lib/gameAudio": `
    const rec = (name) => {
      const w = (window.__ks = window.__ks || { cues: [] });
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
  "lib/creator-mode/audioTap": `
    export const getSharedAudioContext = () => null;
    export const getSharedOutputNode = () => null;
    export const primeAudio = () => {};
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
  entryPoints: [join(root, "qa/keno-survival-harness.jsx")],
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
      name: "keno-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "keno-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "keno-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── The app's REAL stylesheet (shipped Tailwind utilities) ─────────────────
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
<title>Keno survival check</title>
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

const text = (page, sel) =>
  page.evaluate(
    (s) =>
      document.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    sel,
  );
const count = (page, sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const disabledFlags = (page, sel) =>
  page.$$eval(sel, (els) => els.map((e) => e.disabled)).catch(() => []);

const bootPage = async (viewport, contextOpts = {}) => {
  const context = await browser.newContext({ viewport, ...contextOpts });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(fileUrl);
  await page.waitForFunction(() => !!window.__ks?.mount, null, { timeout: 20000 });
  return { context, page, consoleErrors, pageErrors };
};

const structuralErrors = (errors) =>
  errors.filter((e) =>
    /validateDOMNesting|descendant of|hydration|Hydration|Cannot read|Cannot update|is not a function|unique "key"/i.test(
      e,
    ),
  );

const liveTile = (page) => page.evaluate(() => window.__ks.current.liveTile);

// ═══════════════════════════════════════════════════════════════════════════
// DESKTOP — the board, the live tile, claims, the feed
// ═══════════════════════════════════════════════════════════════════════════
const { page, consoleErrors, pageErrors } = await bootPage({
  width: 1280,
  height: 1000,
});

// Every board control is either "Tile N" (untouched / claimed / missed) or
// "Live tile N — tap to claim" — together they are the full 1–40 board.
const BOARD_TILES = 'button[aria-label^="Tile "], button[aria-label^="Live tile "]';
const boardTiles = (target = page) => count(target, BOARD_TILES);

await page.evaluate(() => window.__ks.mount());
await page.waitForSelector('[role="status"]', { timeout: 10000 });
try {
  await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length === 40,
    BOARD_TILES,
    { timeout: 10000 },
  );
} catch (err) {
  console.error("[diag] board never rendered");
  console.error("[diag] pageErrors:", pageErrors);
  console.error("[diag] consoleErrors:", consoleErrors.slice(0, 5));
  console.error("[diag] body:", (await text(page, "body"))?.slice(0, 200));
  console.error(
    "[diag] labels:",
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .map((b) => b.getAttribute("aria-label"))
          .filter(Boolean)
          .slice(0, 8),
      ),
    ),
  );
  console.error(
    "[diag] counts:",
    JSON.stringify(
      await page.evaluate(() => ({
        tile: document.querySelectorAll('button[aria-label^="Tile "]').length,
        live: document.querySelectorAll('button[aria-label^="Live tile"]').length,
        status: document.querySelectorAll('[role="status"]').length,
      })),
    ),
  );
  throw err;
}

// 1. The board renders every tile; only the live one is tappable.
check(
  "the board renders all 40 tiles",
  (await boardTiles()) === 40,
  `tiles=${await boardTiles()}`,
);
const live = await liveTile(page);
const liveTiles = await count(page, 'button[aria-label^="Live tile"]');
check(
  "exactly one tile is the live, tappable tile",
  liveTiles === 1,
  `live=${liveTiles}`,
);
check(
  "the live tile is the tile the server lit",
  (await count(page, `button[aria-label="Live tile ${live} — tap to claim"]`)) === 1,
  `liveTile=${live}`,
);
const liveDisabled = await disabledFlags(page, 'button[aria-label^="Live tile"]');
const othersDisabled = await disabledFlags(
  page,
  'button[aria-label^="Tile "]:not([aria-label^="Live tile"])',
);
check(
  "the live tile is enabled and every other tile is disabled",
  liveDisabled.every((d) => d === false) && othersDisabled.every((d) => d === true),
  `live=${JSON.stringify(liveDisabled)} others=${othersDisabled.filter((d) => !d).length} enabled`,
);

// 2. The window comes from the server clock.
const clock = await text(page, '[role="status"]');
check(
  "the window countdown renders real seconds",
  /\d+\.\d+s/.test(clock || ""),
  `clock=${JSON.stringify(clock)}`,
);
check(
  "the clock names the tile + the current window length",
  new RegExp(`Tile\\s*${live}\\b`).test(clock || "") && /window\s*1\.6s/.test(clock || ""),
  `clock=${JSON.stringify(clock)}`,
);

// 3. The scoreboard shows BOTH seats.
const seatText = await text(page, "body");
check(
  "both seats are shown with their lives + tiles claimed",
  /Tester \(you\)/.test(seatText || "") &&
    /Rival/.test(seatText || "") &&
    /3 lives · 0 claimed/.test(seatText || ""),
  `lives line present=${/3 lives · 0 claimed/.test(seatText || "")}`,
);

// 4. Tapping the live tile posts the claim and the board advances.
const before = await page.evaluate(() => ({
  tile: window.__ks.current.liveTile,
  p1Tiles: window.__ks.current.p1Tiles,
  p2Lives: window.__ks.current.p2Lives,
}));
await page.click(`button[aria-label="Live tile ${before.tile} — tap to claim"]`);
await page.waitForFunction(
  () => (window.__ks.posts || []).some((p) => p.url.includes("/catch")),
  null,
  { timeout: 5000 },
);
const claimPost = await page.evaluate(
  () => window.__ks.posts.find((p) => p.url.includes("/catch"))?.body,
);
check(
  "tapping the live tile posts { tile } to /catch",
  claimPost?.tile === before.tile && !("ball" in (claimPost || {})),
  JSON.stringify(claimPost),
);
await page.waitForFunction(
  (tile) => window.__ks.current.liveTile !== tile,
  before.tile,
  { timeout: 5000 },
);
const advanced = await page.evaluate(() => ({
  tile: window.__ks.current.liveTile,
  p1Tiles: window.__ks.current.p1Tiles,
  p2Lives: window.__ks.current.p2Lives,
  windowMs: window.__ks.current.windowMs,
}));
check(
  "the claim is credited and the opponent loses a life",
  advanced.p1Tiles === before.p1Tiles + 1 && advanced.p2Lives === before.p2Lives - 1,
  JSON.stringify(advanced),
);
check(
  "a new tile is lit and the window has tightened",
  advanced.tile !== before.tile && advanced.windowMs === 1500,
  `tile=${advanced.tile} windowMs=${advanced.windowMs}`,
);
await page.waitForFunction(
  () => document.querySelectorAll('button[aria-label^="Live tile"]').length === 1,
  null,
  { timeout: 5000 },
);
check(
  "the board repaints the new live tile",
  (await count(page, `button[aria-label="Live tile ${advanced.tile} — tap to claim"]`)) === 1,
  `liveTile=${advanced.tile}`,
);
check(
  "the tile just claimed is marked as yours",
  (await count(page, `button[aria-label="Tile ${before.tile} claimed by you"]`)) === 1,
);

// 5. Tapping a NON-live tile sends nothing.
const postsBefore = await page.evaluate(() => window.__ks.posts.length);
const nonLive = await page.evaluate(
  () =>
    Number(
      [...document.querySelectorAll('button[aria-label^="Tile "]')]
        .find((b) => /^Tile \d+$/.test(b.getAttribute("aria-label") || ""))
        ?.getAttribute("aria-label")
        ?.match(/\d+/)?.[0],
    ),
);
await page.evaluate((label) => {
  // The button is disabled, so force the click through the DOM to prove the
  // handler itself refuses a non-live tile.
  const btn = document.querySelector(`button[aria-label="${label}"]`);
  btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}, `Tile ${nonLive}`);
await page.waitForTimeout(250);
check(
  "a tap on any other tile sends no request at all",
  (await page.evaluate(() => window.__ks.posts.length)) === postsBefore,
  `posts=${postsBefore} → ${await page.evaluate(() => window.__ks.posts.length)}`,
);

// 6. The opponent claims a tile → announced + painted gold.
await page.evaluate((tile) => {
  const payload = window.__ks.current;
  window.__ks.pushLog(
    {
      tile,
      outcome: "player2",
      at: new Date().toISOString(),
      p1Lives: payload.p1Lives - 1,
      p2Lives: payload.p2Lives,
      windowMs: payload.windowMs,
      reactionMs: 300,
    },
    { p1Lives: payload.p1Lives - 1, opponentClaimed: [...payload.opponentClaimed, tile] },
  );
}, 31);
await page.waitForFunction(
  () => /claimed tile 31 first — you lost a life/.test(document.body.textContent || ""),
  null,
  { timeout: 5000 },
);
check(
  "an opponent claim is announced by name",
  /Rival claimed tile 31 first — you lost a life/.test(await text(page, "body")),
);
check(
  "…and the tile is painted as theirs",
  (await count(page, 'button[aria-label="Tile 31 claimed by your opponent"]')) === 1,
);

// 7. A both-miss → announced + painted red.
await page.evaluate((tile) => {
  const payload = window.__ks.current;
  window.__ks.pushLog(
    {
      tile,
      outcome: "both_miss",
      at: new Date().toISOString(),
      p1Lives: payload.p1Lives - 1,
      p2Lives: payload.p2Lives - 1,
      windowMs: payload.windowMs,
      reactionMs: null,
    },
    {
      p1Lives: payload.p1Lives - 1,
      p2Lives: payload.p2Lives - 1,
    },
  );
}, 33);
await page.waitForFunction(
  () => /Nobody claimed tile 33/.test(document.body.textContent || ""),
  null,
  { timeout: 5000 },
);
check(
  "a both-miss is announced for both players",
  /Nobody claimed tile 33 — both lost a life/.test(await text(page, "body")),
);
check(
  "…and the unclaimed tile is painted as missed",
  (await count(page, 'button[aria-label="Tile 33 went unclaimed"]')) === 1,
);

// 8. Finish the match: three more claims take the opponent's last life.
for (let i = 0; i < 6; i += 1) {
  const finished = await page.evaluate(() => window.__ks.current.status === "finished");
  if (finished) break;
  const tile = await liveTile(page);
  await page
    .click(`button[aria-label="Live tile ${tile} — tap to claim"]`, { timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(180);
}
await page.waitForFunction(
  () => window.__ks.current.status === "finished",
  null,
  { timeout: 8000 },
);
await page.waitForSelector('[role="dialog"], [data-testid*="result"]', { timeout: 8000 }).catch(() => {});
const resultText = await text(page, "body");
check(
  "the winner's own life bar is untouched while the loser's is empty",
  await page.evaluate(
    () => window.__ks.current.p2Lives === 0 && window.__ks.current.p1Lives > 0,
  ),
  JSON.stringify(await page.evaluate(() => ({
    p1: window.__ks.current.p1Lives,
    p2: window.__ks.current.p2Lives,
    result: window.__ks.current.result,
  }))),
);
check(
  "the result screen reports the tiles each player claimed",
  /\d+ – \d+ tiles claimed/.test(resultText || ""),
  `result=${JSON.stringify((resultText || "").match(/\d+ – \d+ tiles claimed/)?.[0])}`,
);
check(
  "no live tile is claimable once the match is over",
  (await count(page, 'button[aria-label^="Live tile"]')) === 0,
);

// Redeliver the finished snapshot: the result screen must not stack.
await page.evaluate(() => window.__ks.redeliver());
await page.waitForTimeout(400);
check(
  "re-sent snapshots never mount a second result screen",
  (await count(page, '[role="dialog"]')) <= 1,
  `dialogs=${await count(page, '[role="dialog"]')}`,
);

await page.screenshot({ path: join(REPORTS, "keno-survival-result.png") });

check(
  "no React/runtime structural errors on the desktop run",
  structuralErrors(pageErrors).length === 0,
  JSON.stringify(structuralErrors(pageErrors).slice(0, 3)),
);
// The offline harness serves the page from file://, so the app's own fetch of
// unrelated global endpoints (the emote catalogue, user stats) cannot resolve.
// Those "URL scheme \"file\" is not supported" messages are harness artifacts,
// not app errors — everything else must be clean.
const realConsoleErrors = consoleErrors.filter(
  (line) => !/URL scheme "file" is not supported|ERR_FILE_NOT_FOUND/.test(line),
);
check(
  "no console errors on the desktop run",
  realConsoleErrors.length === 0,
  JSON.stringify(realConsoleErrors.slice(0, 3)),
);

// ═══════════════════════════════════════════════════════════════════════════
// AI MATCH — the bot must actually take its turn
// ═══════════════════════════════════════════════════════════════════════════
// The bot's claims are graded SERVER-side inside the live tile's window, so
// the client has to keep asking while that window is open. This phase proves
// the page drives that without the human touching anything — the regression
// where the AI sat still for a whole match.
{
  const { context: actx, page: apage, pageErrors: aErr } = await bootPage({
    width: 1200,
    height: 900,
  });
  await apage.evaluate(() => {
    window.__ks.setAi(1);
    window.__ks.mount();
  });
  await apage.waitForFunction(
    () => (window.__ks.posts || []).some((p) => p.url.includes("/ai-turn")),
    null,
    { timeout: 8000 },
  );
  check("a free AI match asks the server to run the bot's turn", true);

  await apage.waitForFunction(
    () =>
      document.querySelector('button[aria-label*="claimed by your opponent"]') !==
      null,
    null,
    { timeout: 8000 },
  );
  const humanTaps = await apage.evaluate(
    () =>
      (window.__ks.posts || []).filter((p) => p.url.includes("/catch")).length,
  );
  check(
    "…and the bot's claim is painted without the human tapping anything",
    humanTaps === 0,
    `humanTaps=${humanTaps}`,
  );

  // The bot is still subject to the rules: its claim costs the human a life.
  const livesLabels = await apage.evaluate(() =>
    [...document.querySelectorAll('[aria-label$="lives left"]')].map((el) =>
      el.getAttribute("aria-label"),
    ),
  );
  check(
    "…and it costs the human a life like any other claim",
    livesLabels.includes("2 of 3 lives left") &&
      livesLabels.includes("3 of 3 lives left"),
    JSON.stringify(livesLabels),
  );
  check(
    "the AI phase raises no runtime errors",
    aErr.length === 0,
    JSON.stringify(aErr.slice(0, 3)),
  );
  await apage.screenshot({ path: join(REPORTS, "keno-survival-ai-turn.png") });
  await actx.close();
}

// PORTRAIT (creator frame, real shell) + reduced motion
// ═══════════════════════════════════════════════════════════════════════════
{
  const {
    context: pctx,
    page: pportrait,
    consoleErrors: pErr,
    pageErrors: pPageErr,
  } = await bootPage({ width: 430, height: 900 });
  // Fresh desktop-sized payload so the portrait frame starts from a live run.
  await pctx.addInitScript(() => {});
  await pportrait.evaluate(() => {
    window.__ks.setPortrait(true);
    window.__ks.set({ status: "round_1", liveTile: 12, liveDeadline: window.__ks.at(1500) });
    // A fresh run: one tile already claimed by each side.
    window.__ks.current = {
      ...window.__ks.current,
      liveTile: 12,
      liveTileIndex: 2,
      myClaimed: [3],
      opponentClaimed: [7],
    };
    window.__ks.mount();
  });
  await pportrait.waitForFunction(
    (sel) => document.querySelectorAll(sel).length === 40,
    BOARD_TILES,
    { timeout: 10000 },
  );
  const overflow = await pportrait.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(
    "the creator portrait frame renders the full board with no overflow",
    (await boardTiles(pportrait)) === 40 && overflow <= 2,
    `overflow=${overflow}`,
  );
  check(
    "the portrait frame keeps the lives scoreboard on screen",
    /lives ·/.test(await text(pportrait, "body")),
  );
  await pportrait.screenshot({ path: join(REPORTS, "keno-survival-portrait.png") });
  check(
    "no runtime errors in the portrait frame",
    structuralErrors(pPageErr).length === 0 &&
      pErr.filter((line) => !/URL scheme "file" is not supported|ERR_FILE_NOT_FOUND/.test(line))
        .length === 0,
    JSON.stringify([...structuralErrors(pPageErr), ...pErr].slice(0, 3)),
  );
  await pctx.close();
}

{
  const { context: rctx, page: rpage, pageErrors: rErr } = await bootPage(
    { width: 1200, height: 900 },
    { reducedMotion: "reduce" },
  );
  await rpage.evaluate(() => window.__ks.mount());
  await rpage.waitForFunction(
    (sel) => document.querySelectorAll(sel).length === 40,
    BOARD_TILES,
    { timeout: 10000 },
  );
  const liveReduced = await count(rpage, 'button[aria-label^="Live tile"]');
  const seconds = await text(rpage, '[role="status"]');
  check(
    "reduced motion keeps the board + the live tile + the countdown",
    liveReduced === 1 && /\d+\.\d+s/.test(seconds || ""),
    `live=${liveReduced} clock=${JSON.stringify(seconds)}`,
  );
  check(
    "reduced motion surfaces no runtime errors",
    rErr.length === 0,
    JSON.stringify(rErr.slice(0, 3)),
  );
  await rctx.close();
}

await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`screenshots → qa/reports/keno-survival-*.png`);
if (fail > 0) process.exitCode = 1;
