// qa/hex-duel-turn-check.mjs
//
// Drives qa/hex-duel-turn-harness.jsx — the REAL Hex Duel page playing a real
// for-fun (vs AI) match, plus a controlled mount of the real HexBoard — and
// reports what actually happens to the layout and to the troop numbers when a
// turn ends and when the board changes:
//
//   1. the board does not move when a turn ends. A per-frame recorder watches
//      the board's viewport position across an End Turn click, the AI's think
//      pause AND its move, and the turn coming back — so even a single-frame
//      jump is caught, and so is a jump that only shows up later in the turn.
//   2. the End Turn button keeps its box while it is unavailable (it is
//      `visibility: hidden`, not unmounted), which is what makes (1) true.
//   3. the troop numbers ROLL: a tile whose count changes shows intermediate
//      values, monotonic in one direction, and settles on the authoritative
//      value — driven both by the AI's real move and by controlled prop
//      changes.
//   4. a re-render that changes nothing replays nothing.
//   5. two changes in quick succession continue from the number on screen.
//   6. reduced motion settles immediately (no intermediate frame).
//   7. no React/runtime error surfaces anywhere.
//
// Run: npm run verify:hex-turn
//      node qa/hex-duel-turn-check.mjs
//
// Fully offline: Clerk, the router, analytics, the socket, the nav bar, the
// lobby modals, the emotes/presence/recording hooks and the audio module are
// stubbed by the esbuild step. For-fun Hex Duel runs entirely on the local
// engine, so this is a real match — no auth, no database, no dev server.

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
const outDir = mkdtempSync(join(tmpdir(), "hex-duel-turn-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// ── Stubs (everything noisy around the match page) ─────────────────────────
const STUBS = {
  "next/navigation": `
    export const useRouter = () => ({ push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} });
    export const usePathname = () => "/casino/hex-duel";
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
  // The page only ever needs presence-ish behaviour from the socket, so a
  // listener bag is enough — nothing in a for-fun match relays through it.
  "context/SocketProvider": `
    export const useSocket = () => ({ socket: window.__hex.socket });
    export const SocketProvider = ({ children }) => children;
    export default { useSocket, SocketProvider };
  `,
  "components/navigation-bar": `export default function Nav() { return null; }`,
  "components/Footer": `export default function Footer() { return null; }`,
  "components/lobby/MatchWaiting": `
    import React from "react";
    export default function MatchWaiting() { return React.createElement("div", { "data-testid": "waiting" }); }
  `,
  // The rules modal never opens in this harness (first-visit is forced off),
  // and PvpLobby drags the whole lobby in with it.
  "components/lobby/PvpLobby": `
    export const useFirstVisitRules = () => false;
    export const RulesModal = () => null;
    export default { RulesModal, useFirstVisitRules };
  `,
  "components/game/EmotePicker": `
    import React from "react";
    export const EmoteBubble = () => null;
    export default function EmotePicker() { return React.createElement("div", { "data-testid": "emote-picker" }); }
  `,
  "components/ReportModal": `
    import React from "react";
    export default function ReportModal() { return null; }
  `,
  // Audio spies: "which cue fired, how many times" without real Web Audio.
  "lib/hexAudio": `
    const rec = (name) => {
      const w = (window.__hex = window.__hex || { cues: [] });
      if (!w.cues) w.cues = [];
      w.cues.push(name);
    };
    export function useHexAudio() {
      return {
        enabled: true,
        setEnabled: () => {},
        playSelect: () => rec("playSelect"),
        playMove: () => rec("playMove"),
        playCapture: () => rec("playCapture"),
        playPush: () => rec("playPush"),
        playPowerNode: () => rec("playPowerNode"),
        playTurnSwitch: () => rec("playTurnSwitch"),
        playVictory: () => rec("playVictory"),
        playDefeat: () => rec("playDefeat"),
      };
    }
  `,
  "hooks/useGameEmotes": `
    export const useGameEmotes = () => ({ incomingEmote: null, myEmote: null, sendEmote: () => {} });
    export default () => ({ incomingEmote: null, myEmote: null, sendEmote: () => {} });
  `,
  "hooks/useActiveGamePresence": `
    export const useActiveGamePresence = () => {};
    export default () => {};
  `,
  "hooks/useRecordPlayedGame": `
    export const useRecordPlayedGame = () => {};
    export default () => {};
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
  entryPoints: [join(root, "qa/hex-duel-turn-harness.jsx")],
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
      name: "hex-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "hex-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "hex-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── The app's REAL stylesheet (so the frames are laid out with the shipped
//    utilities and breakpoints; unstyled DOM would prove nothing) ──────────
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
<title>Hex Duel turn check</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><div id="board"></div>
<script src="./harness.js"></script></body></html>`,
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

// ── Mutation recorder ──────────────────────────────────────────────────────
// The DIGITS are read straight off the DOM's text mutations, not off a
// sampling loop: every value the counter passes through is captured with its
// own timestamp, so "did it roll or snap" and "how long did it take" are exact
// rather than dependent on how often this machine happened to paint.
const startMutationLog = (page) =>
  page.evaluate(() => {
    const w = (window.__hex = window.__hex || {});
    w.mutations = [];
    if (w.observer) w.observer.disconnect();
    w.observer = new MutationObserver((records) => {
      for (const r of records) {
        const node = r.target.nodeType === 3 ? r.target.parentElement : r.target;
        const span = node && node.closest ? node.closest("[data-troop-count]") : null;
        if (!span) continue;
        const tile = span.closest("[data-tile-key]");
        w.mutations.push({
          key: tile ? tile.getAttribute("data-tile-key") : null,
          shown: Number(span.textContent.trim()),
          t: Math.round(performance.now() * 10) / 10,
        });
      }
    });
    w.observer.observe(document.body, { subtree: true, characterData: true, childList: true });
  });

const readMutations = (page, key) =>
  page.evaluate((k) => (window.__hex.mutations || []).filter((m) => m.key === k), key);

// ── Per-frame recorder ─────────────────────────────────────────────────────
// Sampled every animation frame so a jump that lasts a single frame — or one
// that only appears once the AI's own move lands — is still caught.
const startRecording = (page, ms) =>
  page.evaluate((duration) => {
    const w = (window.__hex = window.__hex || {});
    w.rec = [];
    const sample = () => {
      const board = document.querySelector("[data-hex-board]");
      const status = document.querySelector("[data-hex-status]");
      const band = document.querySelector("[data-hex-turn-band]");
      const aiPanel = document.querySelector("[data-hex-ai-panel]");
      // The status bar's End Turn button specifically — the action panel has
      // one too, and it is the status bar's that moves the board.
      const btn = document.querySelector("[data-hex-status] button");
      const tiles = {};
      for (const tile of document.querySelectorAll("[data-tile-key]")) {
        const span = tile.querySelector("[data-troop-count]");
        if (!span) continue;
        const cs = getComputedStyle(span);
        tiles[tile.getAttribute("data-tile-key")] = {
          shown: Number(span.textContent.trim()),
          target: Number(span.dataset.troopCount),
          // The roll's emphasis: `matrix(a, b, c, d, e, f)` — `a` is the scale
          // and `f` the vertical translation, which is what carries the
          // direction (a climb lifts and grows, a fall dips and shrinks).
          tf: cs.transform,
          fl: cs.filter,
        };
      }
      const rect = (el) => (el ? el.getBoundingClientRect() : null);
      const b = rect(board);
      const s = rect(status);
      const g = rect(band);
      const a = rect(aiPanel);
      const k = rect(btn);
      return {
        t: Math.round(performance.now()),
        top: b ? Math.round(b.top * 10) / 10 : null,
        boardH: b ? Math.round(b.height) : null,
        statusH: s ? Math.round(s.height * 10) / 10 : null,
        bandH: g ? Math.round(g.height * 10) / 10 : null,
        aiPanelH: a ? Math.round(a.height * 10) / 10 : 0,
        btnH: k ? Math.round(k.height * 10) / 10 : null,
        btnTop: k ? Math.round(k.top * 10) / 10 : null,
        btnHidden: btn ? getComputedStyle(btn).visibility === "hidden" : null,
        btnDisabled: btn ? btn.disabled : null,
        btnTabIndex: btn ? btn.tabIndex : null,
        tiles,
      };
    };
    const t0 = performance.now();
    const tick = () => {
      w.rec.push(sample());
      if (performance.now() - t0 < duration) requestAnimationFrame(tick);
      else w.recDone = true;
    };
    requestAnimationFrame(tick);
  }, ms);

const readRecording = (page) => page.evaluate(() => window.__hex.rec || []);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collapse a per-frame series of numbers into the distinct values it held. */
const distinct = (values) => [...new Set(values)];

/**
 * How many animation frames the displayed number spent getting from its old
 * value to its new one. A snap lands in a single frame; a roll takes ~10. This
 * is the honest measure for a ±1 change, where there is no value in between to
 * observe — only the time the change took.
 */
const transitionFrames = (series) => {
  const first = series[0];
  const last = series[series.length - 1];
  if (first === last) return 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < series.length; i++) {
    if (start < 0 && series[i] !== first) start = i;
    if (series[i] !== last) end = i;
  }
  return Math.max(1, end - start + 1);
};

// ══════════════════════════════════════════════════════════════════════════
//  PHASE 1 — a turn end must not move the board (real for-fun match)
// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 1 — turn end keeps the board still ===\n");

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(fileUrl);
await page.waitForSelector('[role="switch"]');
await page.getByRole("switch").click(); // Play for Fun
if (process.env.HEX_DEBUG) {
  console.log(
    "buttons after toggle:",
    await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => ({
        text: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
        role: b.getAttribute("role"),
        disabled: b.disabled,
        visible: getComputedStyle(b).visibility,
      })),
    ),
  );
}
await page.getByRole("button", { name: /free play vs ai/i }).click({ timeout: 5000 });
await page.waitForSelector("[data-hex-board]", { timeout: 8000 });
await sleep(300);

const mounted = await page.evaluate(() => ({
  board: Boolean(document.querySelector("[data-hex-board]")),
  status: Boolean(document.querySelector("[data-hex-status]")),
  turn: (document.querySelector("[data-hex-status]")?.innerText || "").split("\n")[1] || "",
  endTurn: Boolean(document.querySelector("[data-hex-status] button")),
}));
check("a for-fun match starts and renders the real board", mounted.board && mounted.status);
check("the End Turn button exists on the player's turn", mounted.endTurn);

const before = await page.evaluate(() => {
  const board = document.querySelector("[data-hex-board]");
  const btn = document.querySelector("[data-hex-status] button");
  const b = board.getBoundingClientRect();
  const k = btn.getBoundingClientRect();
  return {
    top: Math.round(b.top * 10) / 10,
    btnTop: Math.round(k.top * 10) / 10,
    btnVisible: getComputedStyle(btn).visibility,
  };
});
check("the End Turn button is visible while it is the local player's move", before.btnVisible === "visible", before.btnVisible);

// Record across: the click, the AI's 200ms think pause, its move, and the
// turn coming back to the player.
await startMutationLog(page);
await startRecording(page, 2600);
await page.locator("[data-hex-status] button").click();
await sleep(2900);
const rec = await readRecording(page);

const tops = distinct(rec.map((r) => r.top));
const aiPanelHeights = distinct(rec.map((r) => r.aiPanelH));
console.log(`   board tops=${JSON.stringify(tops)} aiPanelH=${JSON.stringify(aiPanelHeights)} statusH=${JSON.stringify(distinct(rec.map((r) => r.statusH)))}`);
const statusHeights = distinct(rec.map((r) => r.statusH));
const boardHeights = distinct(rec.map((r) => r.boardH));
const btnTops = distinct(rec.map((r) => r.btnTop));
const btnHeights = distinct(rec.map((r) => r.btnH));

check(
  "the board never moves across the whole turn (per-frame, includes the AI's reply)",
  tops.length === 1,
  `tops=${JSON.stringify(tops)}`,
);
check(
  "the status bar keeps its height the whole time",
  statusHeights.length === 1,
  `statusH=${JSON.stringify(statusHeights)}`,
);
check(
  "the board keeps its own size",
  boardHeights.length === 1,
  `boardH=${JSON.stringify(boardHeights)}`,
);
check(
  "the End Turn button keeps its box while it is unavailable",
  btnTops.length === 1 && btnHeights.length === 1,
  `btnTop=${JSON.stringify(btnTops)} btnH=${JSON.stringify(btnHeights)}`,
);
const hiddenSeen = rec.some((r) => r.btnHidden === true);
check(
  "the button really did go unavailable (it was hidden, not merely ignored)",
  hiddenSeen,
);
const visibleSeen = rec.some((r) => r.btnHidden === false);
check("the button came back on the player's next turn", visibleSeen);

// ══════════════════════════════════════════════════════════════════════════
//  PHASE 2 — the troop numbers roll (the AI's real move)
// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 2 — troop numbers roll to their new value ===\n");

/** Every sampled frame for one tile (the tile exists in all of them). */
const tileFrames = (frames, key) => frames.map((f) => f.tiles[key]).filter(Boolean);

/** The `matrix()` parts of a computed transform, or null at rest. */
const matrixOf = (tf) => {
  if (!tf || tf === "none") return null;
  const m = /matrix\(([^)]+)\)/.exec(tf);
  if (!m) return null;
  const [a, , , , , f] = m[1].split(",").map(Number);
  return { scale: a, ty: f };
};

const allKeys = [...new Set(rec.flatMap((f) => Object.keys(f.tiles)))];
const shownSeries = Object.fromEntries(allKeys.map((k) => [k, tileFrames(rec, k).map((t) => t.shown)]));
/** Tiles whose value actually changed during the recording. */
const changedKeys = allKeys.filter((k) => distinct(shownSeries[k]).length > 1);
check(
  "the AI's move changed at least one tile's troop count",
  changedKeys.length > 0,
  `changed=${changedKeys.length}`,
);

let counted = 0;
let settled = 0;
let monotonic = 0;
let directed = 0;
let reported = null;
for (const key of changedKeys) {
  const seen = distinct(shownSeries[key]);
  const first = seen[0];
  const last = seen[seen.length - 1];
  const direction = last > first ? 1 : -1;
  const distance = Math.abs(last - first);
  // A roll passes through the values in between: on a change of N it produces
  // roughly N text mutations. A snap produces exactly ONE, whatever N is — so
  // requiring a few mutations on a multi-step change is what separates them
  // (the exact count depends on the machine's frame rate, hence `min`).
  const mutations = await readMutations(page, key);
  const countedThrough = mutations.length >= Math.min(distance, 3);
  // ...never moves against the change (a stutter would)...
  let backSteps = 0;
  for (let i = 1; i < seen.length; i++) {
    if (direction > 0 ? seen[i] < seen[i - 1] : seen[i] > seen[i - 1]) backSteps++;
  }
  // ...and carries the direction in how it MOVES: a climb lifts the digits and
  // grows them, a fall dips them and shrinks them (a snap would do neither).
  const moves = tileFrames(rec, key).map((t) => matrixOf(t.tf)).filter(Boolean);
  const movesRight = moves.some((m) => m.ty * direction < -0.2 && (m.scale - 1) * direction > 0.01);
  const final = tileFrames(rec, key);
  const target = final[final.length - 1].target;
  if (countedThrough) counted++;
  if (last === target) settled++;
  if (backSteps === 0) monotonic++;
  if (movesRight) directed++;
  if (!reported) {
    reported = { key, seen, target, mutations: mutations.length, distance, distanceDir: direction };
  }
}
check(
  "every changed tile COUNTED through the values in between (not a snap)",
  counted === changedKeys.length,
  `${counted}/${changedKeys.length}`,
);
check("every changed tile moved in one direction only", monotonic === changedKeys.length, `${monotonic}/${changedKeys.length}`);
check("every changed tile settled on the authoritative value", settled === changedKeys.length, `${settled}/${changedKeys.length}`);
check(
  "every changed tile moved the way it changed (up = lift+grow, down = dip+shrink)",
  directed === changedKeys.length,
  `${directed}/${changedKeys.length}`,
);
if (reported) {
  console.log(
    `   e.g. tile ${reported.key}: ${reported.seen.join(" → ")} (target ${reported.target}) — ` +
      `${reported.mutations} text mutations for a distance of ${reported.distance}`,
  );
}

const atRest = rec[rec.length - 1];
const restingMismatches = Object.entries(atRest.tiles).filter(([, v]) => v.shown !== v.target);
check(
  "at rest the displayed number equals the authoritative one on every tile",
  restingMismatches.length === 0,
  JSON.stringify(restingMismatches),
);

check("no React/runtime error surfaced", (await page.evaluate(() => window.__hex.errors.length)) === 0, JSON.stringify(await page.evaluate(() => window.__hex.errors)));

await page.screenshot({ path: join(REPORTS, "hex-duel-turn-still.png") });

// ══════════════════════════════════════════════════════════════════════════
//  PHASE 3 — controlled board: roll direction, no replay, no snap
// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== PHASE 3 — controlled board behaviour ===\n");

const board = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await board.goto(fileUrl);
await board.evaluate(() => {
  document.getElementById("root").style.display = "none";
  window.__hex.mountControlledBoard("board");
});
await board.waitForSelector("#board [data-tile-key]");
await sleep(200);

/** Patch one tile's troops and report WHEN the change was made, so the roll's
 *  own timing can be judged rather than guessed at. */
const patchTile = (page, key, troops) =>
  page.evaluate(
    ({ k, t }) => {
      window.__hex.patchAt = performance.now();
      window.__hex.setTile(k, { troops: t });
      return window.__hex.patchAt;
    },
    { k: key, t: troops },
  );

/** The transform values a tile's digits carried while a scenario ran. */
const transformsOf = async (key) =>
  tileFrames(await readRecording(board), key)
    .map((t) => t.tf)
    .filter((tf) => tf && tf !== "none");

// ── a big climb: it must COUNT through the values, not jump to the target
await startMutationLog(board);
await startRecording(board, 900);
await patchTile(board, "0,0", 12);
await sleep(1100);
const upSteps = (await readMutations(board, "0,0")).map((m) => m.shown);
const upTf = await transformsOf("0,0");
const upRising = upSteps.every((v, i) => i === 0 || v > upSteps[i - 1]);
check(
  "a rising count rolls upward through the values in between",
  upSteps.length >= 4 && upRising && upSteps[upSteps.length - 1] === 12,
  `5 → ${upSteps.join(" → ")}`,
);
check(
  "...and the digits visibly moved while it counted (lift + grow)",
  distinct(upTf).length >= 2 &&
    upTf.some((tf) => {
      const m = matrixOf(tf);
      return m && m.ty < -0.2 && m.scale > 1.01;
    }),
  `${distinct(upTf).length} distinct transforms`,
);

// ── a big fall
await startMutationLog(board);
await startRecording(board, 900);
await patchTile(board, "0,0", 4);
await sleep(1100);
const downSteps = (await readMutations(board, "0,0")).map((m) => m.shown);
const downTf = await transformsOf("0,0");
const downFalling = downSteps.every((v, i) => i === 0 || v < downSteps[i - 1]);
check(
  "a falling count rolls downward through the values in between",
  downSteps.length >= 4 && downFalling && downSteps[downSteps.length - 1] === 4,
  `12 → ${downSteps.join(" → ")}`,
);
check(
  "...and the digits visibly moved while it counted (dip + shrink)",
  distinct(downTf).length >= 2 &&
    downTf.some((tf) => {
      const m = matrixOf(tf);
      return m && m.ty > 0.2 && m.scale < 0.99;
    }),
  `${distinct(downTf).length} distinct transforms`,
);

// ── a ONE-step change: the digit can only change once, so the animation has to
//    be in the movement — a snap would flip it on the very next frame.
await startMutationLog(board);
await startRecording(board, 800);
const stepAt = await patchTile(board, "0,0", 5);
await sleep(1000);
const stepMuts = await readMutations(board, "0,0");
const stepTf = await transformsOf("0,0");
const stepFlipDelay = stepMuts.length ? stepMuts[0].t - stepAt : 0;
check(
  "a one-step change still animates (the digits move, then it flips)",
  stepMuts.length === 1 &&
    stepMuts[0].shown === 5 &&
    stepFlipDelay >= 30 &&
    distinct(stepTf).length >= 2,
  `flipped ${stepFlipDelay.toFixed(0)}ms after the change, ${distinct(stepTf).length} distinct transforms`,
);

// ── identical re-render (a poll / socket re-delivery / Strict-Mode rerender)
await startMutationLog(board);
await startRecording(board, 800);
await patchTile(board, "0,0", 5); // the same value again
await sleep(1000);
const replayMuts = await readMutations(board, "0,0");
const replayTf = await transformsOf("0,0");
check(
  "re-rendering with the same value replays nothing",
  replayMuts.length === 0 && replayTf.length === 0,
  `${replayMuts.length} text mutations, ${replayTf.length} moving frames`,
);

// ── two changes in quick succession
await startMutationLog(board);
await startRecording(board, 1600);
await patchTile(board, "1,0", 9);
await sleep(120);
await patchTile(board, "1,0", 15);
await sleep(1700);
const burstSteps = (await readMutations(board, "1,0")).map((m) => m.shown);
let burstBack = 0;
for (let i = 1; i < burstSteps.length; i++) if (burstSteps[i] < burstSteps[i - 1]) burstBack++;
check(
  "two quick changes keep climbing instead of snapping back",
  burstSteps.length >= 5 && burstBack === 0 && burstSteps[burstSteps.length - 1] === 15,
  `5 → ${burstSteps.join(" → ")}`,
);

// ── reduced motion
const rm = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
await rm.goto(fileUrl);
await rm.evaluate(() => {
  document.getElementById("root").style.display = "none";
  window.__hex.mountControlledBoard("board");
});
await rm.waitForSelector("#board [data-tile-key]");
await sleep(200);
await rm.evaluate(() => window.__hex.setTile("0,0", { troops: 21 }));
await sleep(200);
const rmShown = await rm.evaluate(
  () => document.querySelector('#board [data-tile-key="0,0"] [data-troop-count]').textContent.trim(),
);
check("reduced motion settles immediately (no roll)", rmShown === "21", `shown=${rmShown}`);

// ── the hidden End Turn button is not reachable by keyboard either. Read from
//    the recording so it is judged WHILE it is hidden, not after the turn came
//    back (when it is legitimately actionable again).
const hiddenFrames = rec.filter((r) => r.btnHidden === true);
const reachableWhileHidden = hiddenFrames.filter((r) => !r.btnDisabled || r.btnTabIndex >= 0);
check(
  "the reserved button space cannot be focused or activated while hidden",
  hiddenFrames.length > 0 && reachableWhileHidden.length === 0,
  `${hiddenFrames.length} hidden frames, ${reachableWhileHidden.length} reachable`,
);

await browser.close();

console.log(`\n${pass} passed / ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
