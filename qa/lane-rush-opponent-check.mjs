// qa/lane-rush-opponent-check.mjs
//
// Drives qa/lane-rush-opponent-harness.jsx — the REAL Lane Rush match page
// with a scripted SHARED BRIDGE match — and reports what the page actually
// renders and sends:
//
//   1. the bridge renders 10 rows, with the difficulty's tile count per row;
//   2. YOUR TURN is unmistakable (banner + pick hint), the 15s timer shows,
//      and only YOUR current row's tiles are selectable;
//   3. tapping a valid tile posts the authoritative jump (actionId + row +
//      tile), and no other row is selectable;
//   4. OPPONENT'S TURN disables your tiles and keeps showing their movement;
//   5. a SAFE result keeps the same player's turn, advances their row and
//      keeps the window running;
//   6. a BAD tile / a TIMEOUT resets that player to Row 1 and hands the turn
//      over, and the broken tile stays visibly broken for the match;
//   7. memory flags are visible to BOTH players;
//   8. the creator PORTRAIT frame (real shell + real portrait branch) renders
//      the same bridge at phone width;
//   9. the shared result screen mounts exactly once when the match finishes;
//  10. reduced-motion leaves no permanent animation on the board;
//  11. no React nesting / hydration / runtime error surfaces anywhere.
//
// Run: npm run verify:lane-rush-opponent
//      node qa/lane-rush-opponent-check.mjs
//
// Fully offline: Clerk, the socket, the router, analytics, nav/footer, the
// waiting takeover and the creator-mode HOST are stubbed by the esbuild step;
// the match payload comes from a stubbed `fetch`, so this is a MOCKED bridge
// match — no auth, no database, no dev server.

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
const outDir = mkdtempSync(join(tmpdir(), "lane-rush-bridge-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// ── Stubs (everything noisy around the match page) ─────────────────────────
// NOTE: `components/creator-mode/CreatorModeLayout` is deliberately NOT
// stubbed — the real shell primitives and the real <CreatorView> portrait
// branch are what the portrait phase checks. Only the HOST (recording chrome)
// and the creator-mode PROVIDER (which selects the frame dimensions) are.
const STUBS = {
  "next/navigation": `
    const record = (href) => { (window.__lr = window.__lr || {}).nav = ((window.__lr && window.__lr.nav) || []).concat([href]); };
    export const useRouter = () => ({ push: record, replace: record, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino/lane-runner/4242";
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
  // `lib/lane-rush-duel/constants.js` imports node's crypto at module scope.
  crypto: `
    const zeros = (n) => "0".repeat(n);
    const createHash = () => { const h = { update: () => h, digest: (enc) => (enc === "hex" ? zeros(64) : zeros(32)) }; return h; };
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
    export const playGlassBreak = () => rec("playGlassBreak");
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

// ── The app's REAL stylesheet (shipped Tailwind utilities) ─────────────────
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
<title>Lane Rush bridge check</title>
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
const count = (page, sel) =>
  page.$$eval(sel, (els) => els.length).catch(() => 0);
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
  await page.waitForFunction(() => !!window.__lr?.mount, null, { timeout: 20000 });
  return { context, page, consoleErrors, pageErrors };
};

const structuralErrors = (errors) =>
  errors.filter((e) =>
    /validateDOMNesting|descendant of|hydration|Hydration|Cannot read|Cannot update|is not a function|unique "key"/i.test(
      e,
    ),
  );

// ═══════════════════════════════════════════════════════════════════════════
// DESKTOP — the bridge, my turn, opponent turn, results
// ═══════════════════════════════════════════════════════════════════════════
const { page, consoleErrors, pageErrors } = await bootPage({
  width: 1280,
  height: 1000,
});

await page.evaluate(() => {
  window.__lr.set({ isViewerTurn: true, currentTurnUserId: "user_1", myRow: 3, oppRow: 1 });
  window.__lr.mount();
});
await page.waitForSelector('[role="status"]', { timeout: 10000 });
// The countdown is measured on the server clock from a 250ms local tick, so
// give the ring one tick to mount before asserting it.
await page.waitForSelector('[title="Your choice window"]', { timeout: 5000 });

// 1. The bridge renders 10 rows with the difficulty's tile count.
check(
  "the bridge renders 10 labelled rows",
  (await count(page, '[title^="Row "]')) === 10,
  `rows=${await count(page, '[title^="Row "]')}`,
);
check(
  "each row has the difficulty's tile count (medium = 3)",
  (await count(page, 'button[aria-label^="Row 1 tile"]')) === 3 &&
    (await count(page, 'button[aria-label^="Row 10 tile"]')) === 3,
  `row1=${await count(page, 'button[aria-label^="Row 1 tile"]')} row10=${await count(page, 'button[aria-label^="Row 10 tile"]')}`,
);
// The bridge is drawn top-first (row 10 at the top), so the goal emphasis must
// land on row 10 — highlighting row 1 would point the player at the start.
const summit = await page.evaluate(() => {
  const label = document.querySelector('[title*="the top of the bridge"]');
  if (!label) return null;
  // Stable hook — the row is no longer identified by a rounded-* class (tiles
  // and rows are sharp-edged now).
  const row = label.closest('[data-lane-row]');
  return {
    rowLabel: label.textContent?.trim() ?? null,
    amber:
      row?.getAttribute("data-goal") === "true" &&
      Boolean(row?.className.includes("amber")),
  };
});
check(
  "the summit (goal) row is row 10, not row 1",
  summit?.rowLabel === "10" && summit?.amber === true,
  JSON.stringify(summit),
);

check(
  "the whole board is 10 x 3 tiles",
  (await count(page, 'button[aria-label^="Row "]')) === 30,
  `tiles=${await count(page, 'button[aria-label^="Row "]')}`,
);

// 2. YOUR TURN — unmistakable banner, pick hint, timer.
const myTurnBanner = await text(page, '[role="status"]');
check(
  "your turn is announced",
  (myTurnBanner || "").toUpperCase().includes("YOUR TURN"),
  `banner=${JSON.stringify(myTurnBanner)}`,
);
check(
  "…with the row you should pick on",
  /pick a tile on row 4/i.test(myTurnBanner || ""),
  `banner=${JSON.stringify(myTurnBanner)}`,
);
check(
  "the 15s window is shown on the server clock (your window)",
  (await count(page, '[title="Your choice window"]')) === 1,
  `ring=${await count(page, '[title="Your choice window"]')}`,
);
check(
  "the countdown renders a real number",
  /\d+/.test((await text(page, '[title="Your choice window"]')) || ""),
  `ring=${JSON.stringify(await text(page, '[title="Your choice window"]'))}`,
);

// 3. Only MY current row is selectable.
const myRowTiles = await disabledFlags(page, 'button[aria-label^="Row 4 tile"]');
const otherRowTiles = await disabledFlags(page, 'button[aria-label^="Row 6 tile"]');
check(
  "my current row's tiles are selectable",
  myRowTiles.length === 3 && myRowTiles.every((d) => d === false),
  JSON.stringify(myRowTiles),
);
check(
  "tiles on other rows are disabled",
  otherRowTiles.length === 3 && otherRowTiles.every((d) => d === true),
  JSON.stringify(otherRowTiles),
);

// 4. Tapping a valid tile posts the authoritative jump.
await page.click('button[aria-label="Row 4 tile 1"]');
await page.waitForFunction(() => (window.__lr.posts || []).length > 0, null, {
  timeout: 5000,
});
const jumpPost = await page.evaluate(() => window.__lr.posts[0]);
check(
  "a tile tap posts a jump with actionId + row + tile",
  jumpPost?.body?.action === "jump" &&
    jumpPost?.body?.row === 3 &&
    jumpPost?.body?.tile === 0 &&
    typeof jumpPost?.body?.actionId === "string",
  JSON.stringify(jumpPost?.body),
);

// 4b. The memory-flag system.
check(
  "the HUD shows the remaining flags",
  /\d\/\d+ left/.test((await text(page, '[data-testid="lane-runner-flags-left"]')) || ""),
  `hud=${JSON.stringify(await text(page, '[data-testid="lane-runner-flags-left"]'))}`,
);
check(
  "the flag prompt offers to mark the tile just landed on",
  (await count(page, '[data-testid="lane-runner-flag-prompt"]')) === 1,
);
check(
  "…and names that row",
  /row 3/i.test((await text(page, '[data-testid="lane-runner-flag-prompt"]')) || ""),
  `prompt=${JSON.stringify(await text(page, '[data-testid="lane-runner-flag-prompt"]'))}`,
);
// The prompt's own button places the flag for the landed tile.
await page.click('[data-testid="lane-runner-flag-place"]');
await page.waitForFunction(
  () => (window.__lr.posts || []).some((p) => p.body?.action === "flag"),
  null,
  { timeout: 5000 },
);
const promptFlagPost = await page.evaluate(
  () => window.__lr.posts.filter((p) => p.body?.action === "flag").slice(-1)[0],
);
check(
  "the flag prompt posts action:flag for the landed tile",
  promptFlagPost?.body?.row === 2 && promptFlagPost?.body?.tile === 0,
  JSON.stringify(promptFlagPost?.body),
);
// Flag mode must refuse a tile this player never landed on…
await page.click('[data-testid="lane-runner-flag-toggle"]');
const postsBeforeUntested = await page.evaluate(() => window.__lr.posts.length);
await page.evaluate(() =>
  document.querySelector('button[aria-label="Row 6 tile 1"]')?.click(),
);
await page.waitForTimeout(150);
check(
  "flag mode refuses an untested tile",
  (await page.evaluate(() => window.__lr.posts.length)) === postsBeforeUntested,
  `posts=${await page.evaluate(() => window.__lr.posts.length)}`,
);
// …but accepts a tile this player did land on safely.
await page.click('button[aria-label="Row 2 tile 1"]');
await page.waitForFunction(
  () =>
    (window.__lr.posts || []).filter((p) => p.body?.action === "flag").length >= 2,
  null,
  { timeout: 5000 },
);
const modeFlagPost = await page.evaluate(
  () => window.__lr.posts.filter((p) => p.body?.action === "flag").slice(-1)[0],
);
check(
  "a tile you landed on can be flagged from flag mode",
  modeFlagPost?.body?.row === 1 && modeFlagPost?.body?.tile === 0,
  JSON.stringify(modeFlagPost?.body),
);
// A flag must be clearly visible on the board — a large flag icon centred on
// the tile — while the tile number stays readable underneath it.
const flaggedTile = await page.evaluate(() => {
  const el = document.querySelector('button[aria-label*="your flag"]');
  return {
    text: el?.textContent?.trim() ?? "",
    icons: el?.querySelectorAll("svg").length ?? 0,
  };
});
check(
  "a flagged tile shows a visible flag icon and keeps the tile number readable",
  /\d/.test(flaggedTile.text) && flaggedTile.icons >= 1,
  JSON.stringify(flaggedTile),
);

// 5. Broken tiles are visibly broken, and flags are PUBLIC to both players.
check(
  "the broken tile is rendered as broken",
  (await count(page, 'button[aria-label*="broken"]')) >= 1,
  `broken=${await count(page, 'button[aria-label*="broken"]')}`,
);
check(
  "both players' flags are drawn on the shared board",
  (await count(page, 'button[aria-label*="your flag"]')) >= 1 &&
    (await count(page, 'button[aria-label*="opponent flag"]')) >= 1,
  `mine=${await count(page, 'button[aria-label*="your flag"]')} opp=${await count(page, 'button[aria-label*="opponent flag"]')}`,
);

// 6. Difficulty keeps its tile count (hard = 2).
await page.evaluate(() => {
  window.__lr.set({ tileCount: 2, difficulty: "hard", isViewerTurn: true });
  window.__lr.redeliver(1);
});
await page.waitForFunction(
  () => document.querySelectorAll('button[aria-label^="Row 1 tile"]').length === 2,
  null,
  { timeout: 5000 },
);
check(
  "hard difficulty renders 2 tiles per row",
  (await count(page, 'button[aria-label^="Row 1 tile"]')) === 2,
);

// Restore the medium mid-match state.
await page.evaluate(() => {
  window.__lr.set({ isViewerTurn: true, currentTurnUserId: "user_1", myRow: 3, oppRow: 1 });
  window.__lr.redeliver(1);
});
await page.waitForSelector('[title="Your choice window"]', { timeout: 5000 });

// 7. OPPONENT'S TURN — banner, disabled tiles, their movement.
await page.evaluate(() =>
  window.__lr.pushAction(
    { action: "jump", seat: "player2", userId: "user_2", row: 1, tile: 1, outcome: "safe", at: window.__lr.at(0) },
    { isViewerTurn: false, currentTurnUserId: "user_2", oppRow: 2 },
  ),
);
await page.waitForFunction(
  () => /opponent's turn/i.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
const oppTurnBanner = await text(page, '[role="status"]');
check(
  "opponent's turn is announced",
  (oppTurnBanner || "").toUpperCase().includes("OPPONENT'S TURN"),
  `banner=${JSON.stringify(oppTurnBanner)}`,
);
check(
  "…and the opponent's movement is shown",
  /Rival crossed to row 2/i.test(await page.evaluate(() => document.body.innerText)),
);
check(
  "the opponent's progress row updates (2/10)",
  /2\/10/.test(await page.evaluate(() => document.body.innerText)),
);
check(
  "every tile selection is disabled on the opponent's turn",
  (await disabledFlags(page, 'button[aria-label^="Row "]')).every((d) => d === true),
);
await page.screenshot({ path: join(REPORTS, "lane-rush-bridge-desktop-oppturn.png"), fullPage: true });

// 8. A SAFE result keeps the same player's turn and advances their row, and
//    plays the arc jump animation (driven by the server's resolved action).
await page.evaluate(() =>
  window.__lr.pushAction(
    { action: "jump", seat: "player1", userId: "user_1", row: 3, tile: 0, outcome: "safe", at: window.__lr.at(0) },
    { isViewerTurn: true, currentTurnUserId: "user_1", myRow: 4, roundDeadline: window.__lr.at(12000) },
  ),
);
await page.waitForSelector(
  '[data-testid="lane-runner-jump"][data-jump-seat="player1"][data-jump-outcome="safe"]',
  { timeout: 4000 },
);
check("a safe jump plays the arc jump animation", true);
await page.waitForFunction(
  () => /YOUR TURN/i.test(document.body.innerText) &&
    /pick a tile on row 5/i.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
check(
  "a safe jump keeps your turn and advances your row",
  /4\/10/.test(await page.evaluate(() => document.body.innerText)) &&
    /pick a tile on row 5/i.test(await page.evaluate(() => document.body.innerText)),
);
check(
  "…and the fresh 15s window is still shown",
  (await count(page, '[title="Your choice window"]')) === 1,
);
const safeTiles = await disabledFlags(page, 'button[aria-label^="Row 5 tile"]');
check(
  "…with the new row selectable",
  safeTiles.length === 3 && safeTiles.every((d) => d === false),
  JSON.stringify(safeTiles),
);

// 9. A BAD tile resets you to Row 1 and hands the turn over, and plays the
//    leap → fall-through + glass shatter animation.
const brokenBefore = await count(page, 'button[aria-label*="broken"]');
await page.evaluate(() =>
  window.__lr.pushAction(
    { action: "jump", seat: "player1", userId: "user_1", row: 4, tile: 2, outcome: "fell", at: window.__lr.at(0) },
    {
      isViewerTurn: false,
      currentTurnUserId: "user_2",
      myRow: 0,
      broken: [{ row: 1, tile: 2 }, { row: 4, tile: 2 }],
    },
  ),
);
await page.waitForSelector(
  '[data-testid="lane-runner-jump"][data-jump-seat="player1"][data-jump-outcome="fell"]',
  { timeout: 4000 },
);
check("a bad jump plays the fall-through animation", true);
check(
  "…with a glass shatter on the broken tile",
  (await count(page, '[data-testid="lane-runner-jump"] [data-testid="lane-runner-shard"]')) >=
    1 &&
    (await count(page, '[data-testid="lane-runner-jump"] [data-testid="lane-runner-crack"]')) >=
      1,
  `shards=${await count(page, '[data-testid="lane-runner-jump"] [data-testid="lane-runner-shard"]')} cracks=${await count(page, '[data-testid="lane-runner-jump"] [data-testid="lane-runner-crack"]')}`,
);
await page.waitForFunction(
  () => /hit a broken tile — back to row 1/i.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
check(
  "a bad tile announces the reset to Row 1",
  /You hit a broken tile — back to row 1/i.test(await page.evaluate(() => document.body.innerText)),
);
check(
  "…the seat shows 0/10",
  /0\/10/.test(await page.evaluate(() => document.body.innerText)),
);
check(
  "…the turn is handed to the opponent",
  (await text(page, '[role="status"]'))?.toUpperCase().includes("OPPONENT'S TURN"),
);
check(
  "…and the tile stays broken for the match",
  (await count(page, 'button[aria-label*="broken"]')) === brokenBefore + 1,
  `before=${brokenBefore} after=${await count(page, 'button[aria-label*="broken"]')}`,
);
await page.waitForSelector('[data-testid="lane-runner-jump"]', {
  state: "detached",
  timeout: 5000,
});
check(
  "the jump animation retires and never lingers over the board",
  (await count(page, '[data-testid="lane-runner-jump"]')) === 0,
);
await page.screenshot({ path: join(REPORTS, "lane-rush-bridge-desktop-broken.png"), fullPage: true });

// 10. A TIMEOUT resets the opponent and gives the turn back.
await page.evaluate(() =>
  window.__lr.pushAction(
    { action: "timeout", seat: "player2", userId: "user_2", row: 2, outcome: "timed_out", at: window.__lr.at(0) },
    { isViewerTurn: true, currentTurnUserId: "user_1", oppRow: 0, roundDeadline: window.__lr.at(12000) },
  ),
);
await page.waitForFunction(
  () => /ran out of time — back to row 1/i.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
check(
  "a timeout resets the opponent to Row 1",
  /Rival ran out of time — back to row 1/i.test(await page.evaluate(() => document.body.innerText)),
);
check(
  "…and the turn comes back to you",
  (await text(page, '[role="status"]'))?.toUpperCase().includes("YOUR TURN"),
);
await page.screenshot({ path: join(REPORTS, "lane-rush-bridge-desktop-myturn.png"), fullPage: true });

// 11. The board never overflows horizontally on desktop.
const overflow = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  nodes: document.querySelectorAll("*").length,
}));
check(
  "the desktop bridge does not overflow horizontally",
  overflow.scrollWidth <= overflow.clientWidth + 1,
  JSON.stringify(overflow),
);
check("the page actually rendered", overflow.nodes > 60, `nodes=${overflow.nodes}`);

// 12. Re-delivering the same snapshot changes nothing structural.
await page.evaluate(() => window.__lr.redeliver(4));
await page.waitForTimeout(500);
check(
  "re-delivering the same snapshot keeps the board stable",
  (await count(page, 'button[aria-label^="Row "]')) === 30 &&
    (await count(page, '[role="status"]')) === 1,
);

// 13. The result screen mounts exactly once when the match finishes.
await page.evaluate(() => {
  window.__lr.set({
    status: "finished",
    winnerId: "user_1",
    result: "player1",
    myRow: 10,
    oppRow: 4,
    isViewerTurn: false,
    currentTurnUserId: null,
    roundDeadline: null,
    prizePaid: 47.5,
    endedAt: window.__lr.at(0),
  });
  window.__lr.redeliver(1);
});
await page.waitForSelector('[role="dialog"]', { timeout: 8000 });
check(
  "exactly ONE result screen is mounted",
  (await count(page, '[role="dialog"]')) === 1,
  `dialogs=${await count(page, '[role="dialog"]')}`,
);
check(
  "the result names the win",
  /you crossed the bridge|victory|win/i.test(await page.evaluate(() => document.body.innerText)),
);
await page.screenshot({ path: join(REPORTS, "lane-rush-bridge-result.png"), fullPage: true });

// 14. Nothing structural blew up.
const fatal = structuralErrors(consoleErrors);
check("no React nesting / hydration / runtime console error", fatal.length === 0, fatal.join(" | "));
check("no uncaught page error", pageErrors.length === 0, pageErrors.join(" | "));

// ═══════════════════════════════════════════════════════════════════════════
// PORTRAIT — the creator phone frame
// ═══════════════════════════════════════════════════════════════════════════
const portrait = await bootPage({ width: 390, height: 800 });
const ppage = portrait.page;
await ppage.evaluate(() => {
  window.__lr.setPortrait(true);
  window.__lr.set({ isViewerTurn: true, currentTurnUserId: "user_1", myRow: 3, oppRow: 1 });
  window.__lr.mount();
});
await ppage.waitForSelector('[role="status"]', { timeout: 10000 });
check(
  "the portrait phase renders the creator portrait layout",
  (await ppage.evaluate(() =>
    document.querySelector("[data-creator-layout]")?.getAttribute("data-creator-layout"),
  )) === "portrait",
);
check(
  "the turn banner renders in the portrait frame",
  (await text(ppage, '[role="status"]'))?.toUpperCase().includes("YOUR TURN"),
);
check(
  "the portrait bridge renders 10 rows",
  (await count(ppage, '[title^="Row "]')) === 10,
);
const portraitOverflow = await ppage.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));
check(
  "the portrait frame does not overflow horizontally",
  portraitOverflow.scrollWidth <= portraitOverflow.clientWidth + 1,
  JSON.stringify(portraitOverflow),
);
await ppage.screenshot({ path: join(REPORTS, "lane-rush-bridge-portrait.png"), fullPage: true });
const portraitFatal = structuralErrors(portrait.consoleErrors);
check(
  "the portrait pass raises no structural error",
  portraitFatal.length === 0 && portrait.pageErrors.length === 0,
  [...portraitFatal, ...portrait.pageErrors].join(" | "),
);

// ═══════════════════════════════════════════════════════════════════════════
// THE READY WINDOW — the opening 15s turn waits for the board to be up
// ═══════════════════════════════════════════════════════════════════════════
// A joiner lands in `ready` (no turn owner, no countdown) for 3s, so neither
// player can lose the opening turn to a timeout they never saw. Only when the
// server flips it to `active` does the first player's full 15s window open.
const rdy = await bootPage({ width: 1280, height: 1000 });
const dpage = rdy.page;
await dpage.evaluate(() => {
  window.__lr.set({
    status: "ready",
    currentTurnUserId: null,
    isViewerTurn: false,
    roundDeadline: null,
    myRow: 0,
    oppRow: 0,
    actions: [],
    broken: [],
  });
  window.__lr.mount();
});
await dpage.waitForFunction(
  () => /get ready/i.test(document.body.innerText),
  null,
  { timeout: 10000 },
);
check(
  "the ready window shows the match-found banner",
  /Opponent found/i.test(await dpage.evaluate(() => document.body.innerText)),
);
check(
  "…with no tile selectable while the window is closed",
  (await count(dpage, 'button[aria-label^="Row "]')) === 0,
);
check(
  "…and no phantom countdown before the turn exists",
  (await count(dpage, '[title="Your choice window"]')) === 0 &&
    !/pick a tile on row/i.test(await dpage.evaluate(() => document.body.innerText)),
);
// The server then opens the real window: a full 15s for the coin-flipped seat.
await dpage.evaluate(() => {
  window.__lr.set({
    status: "active",
    currentTurnUserId: "user_1",
    isViewerTurn: true,
    myRow: 0,
    oppRow: 0,
    roundDeadline: window.__lr.at(15000),
    actions: [],
    broken: [],
  });
  window.__lr.redeliver(1);
});
await dpage.waitForSelector('[role="status"]', { timeout: 5000 });
// The countdown only renders once the local clock ticks (250ms), so wait for a
// real number rather than reading the ring the instant the board mounts.
await dpage.waitForFunction(
  () => {
    const el = document.querySelector('[title="Your choice window"]');
    return !!el && Number((el.textContent || "").replace(/\D+/g, "")) >= 14;
  },
  null,
  { timeout: 5000 },
);
const openingLeft = Number(
  (await text(dpage, '[title="Your choice window"]'))?.replace(/\D+/g, "") || 0,
);
check(
  "the opening turn then gets a full 15s window",
  (await text(dpage, '[role="status"]'))?.toUpperCase().includes("YOUR TURN") &&
    openingLeft >= 14,
  `ring=${openingLeft}`,
);
await dpage.screenshot({ path: join(REPORTS, "lane-rush-bridge-ready-window.png"), fullPage: true });
const rdyFatal = structuralErrors(rdy.consoleErrors);
check(
  "the ready-window pass raises no structural error",
  rdyFatal.length === 0 && rdy.pageErrors.length === 0,
  [...rdyFatal, ...rdy.pageErrors].join(" | "),
);

// ═══════════════════════════════════════════════════════════════════════════
// REDUCED MOTION — nothing loops forever on the board
// ═══════════════════════════════════════════════════════════════════════════
const rm = await bootPage({ width: 1280, height: 1000 }, { reducedMotion: "reduce" });
const rpage = rm.page;
await rpage.evaluate(() => {
  window.__lr.set({ isViewerTurn: true, currentTurnUserId: "user_1", myRow: 3, oppRow: 1 });
  window.__lr.mount();
});
await rpage.waitForSelector('[role="status"]', { timeout: 10000 });
await rpage.waitForTimeout(700);
check(
  "reduced motion leaves no permanent animation on the board",
  (await rpage.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming?.().iterations === Infinity).length,
  )) === 0,
);
check(
  "the board is still fully rendered under reduced motion",
  (await count(rpage, 'button[aria-label^="Row "]')) === 30 &&
    (await text(rpage, '[role="status"]'))?.toUpperCase().includes("YOUR TURN"),
);
// A safe jump resolves with the same server state — but reduced motion skips
// the decorative animation entirely.
await rpage.evaluate(() =>
  window.__lr.pushAction(
    { action: "jump", seat: "player1", userId: "user_1", row: 3, tile: 0, outcome: "safe", at: window.__lr.at(0) },
    { isViewerTurn: true, currentTurnUserId: "user_1", myRow: 4, roundDeadline: window.__lr.at(12000) },
  ),
);
await rpage.waitForFunction(
  () => /pick a tile on row 5/i.test(document.body.innerText),
  null,
  { timeout: 5000 },
);
check(
  "reduced motion skips the jump animation but keeps the server state",
  (await count(rpage, '[data-testid="lane-runner-jump"]')) === 0 &&
    /4\/10/.test(await rpage.evaluate(() => document.body.innerText)),
);
await rpage.screenshot({ path: join(REPORTS, "lane-rush-bridge-reduced-motion.png"), fullPage: true });
const rmFatal = structuralErrors(rm.consoleErrors);
check(
  "the reduced-motion pass raises no structural error",
  rmFatal.length === 0 && rm.pageErrors.length === 0,
  [...rmFatal, ...rm.pageErrors].join(" | "),
);

await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
