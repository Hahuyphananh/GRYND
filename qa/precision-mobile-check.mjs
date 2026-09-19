// qa/precision-mobile-check.mjs
//
// Phone-presentation check for the Precision rocket-race surfaces. It mounts
// the REAL components (qa/precision-race-harness.jsx) together with the
// project's REAL Tailwind CSS (generated from tailwind.config.js +
// src/app/globals.css), because everything asserted here is responsive layout —
// a stubbed stylesheet would make every assertion vacuous.
//
//  1. Nothing scrolls sideways at 360 / 320 px, and the board fits the gutter.
//  2. Two lanes really are side by side with usable width, each lane's label
//     sits over its OWN lane and is not truncated away.
//  3. The centre elapsed timer fits its column (the `10.00s` overflow class of
//     bug) and never runs into the opponent's lane.
//  4. Both rockets stay inside the board — including the flying rocket pins at
//     the axis ceiling and the parked rocket's stop pill under it.
//  5. The seconds axis ticks are fully visible (the gutter was the tightest
//     thing on a 320 px screen) and the target threshold line + its label are
//     readable.
//  6. The board keeps a phone-friendly height clamp so the STOP controls can
//     never be pushed off the fold.
//  7. The per-round result overlay fits the viewport, scrolls internally, and
//     its embedded (compact) board reports the SAME per-seat stops as the
//     numeric rows below it — the spatial view can never disagree.
//  8. The end-of-match popup renders the frozen last-round board and does not
//     overflow sideways.
//  9. Desktop (1280 px) is untouched: the taller board and the wide centre
//     column are still applied.
//
// Screenshots (full page + a crop of the board) land in
// qa/reports/precision-mobile/.
//
// The Google-Fonts @import at the top of globals.css is stripped before the
// stylesheet is injected: a headless run has no network, and a blocking
// @import would only stall the page without affecting any asserted layout.
//
// Run: node qa/precision-mobile-check.mjs

import esbuild from "esbuild";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "tailwindcss";
import postcss from "postcss";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(root, "qa/reports/precision-mobile");
mkdirSync(SHOTS, { recursive: true });

// ── 1. Bundle the real components (same stub set as the roulette checks) ────
const shell = (extra) => `import { createElement, Fragment } from "react";
const Passthrough = (p) => createElement(Fragment, null, p ? p.children : null);
const Null = () => null;
${extra}`;

const NEXT_STUBS = {
  "next/navigation": shell(`export const useRouter = () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} });
export const useParams = () => ({ matchId: "1" });
export const usePathname = () => "/casino/precision/game/1";
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

const APP_STUBS = new Map([
  // The language context is stubbed so the REAL `useTranslation()` / REAL
  // `appTextTranslations` copy is used (matching production text), without
  // pulling in the provider's cookie/localStorage machinery.
  [
    "context/LanguageContext",
    shell(
      `export const useLanguage = () => ({ language: "en", setLanguage() {} });\nexport const LanguageProvider = Passthrough;\nexport default { useLanguage, LanguageProvider };`,
    ),
  ],
  // Creator Mode is OFF in these runs (the popup only uses the flag to pick
  // its `compact` sizing), so the whole recorder provider chain is skipped.
  [
    "lib/creator-mode/CreatorModeProvider",
    shell(
      `export const useCreatorMode = () => ({ isCreatorMode: false, isRecording: false, toggle() {}, start() {}, stop() {} });\nexport default Passthrough;`,
    ),
  ],
]);

const outDir = mkdtempSync(join(tmpdir(), "precision-mobile-"));
await esbuild.build({
  entryPoints: [join(root, "qa/precision-race-harness.jsx")],
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
          const js = (contents) => ({ contents, loader: "js", resolveDir: root });
          if (NEXT_STUBS[args.path]) return js(NEXT_STUBS[args.path]);
          if (args.path.startsWith("@clerk/")) return js(`export const useUser = () => ({ isLoaded: true, isSignedIn: true, user: { id: "user_1", username: "Tester" } });\nexport const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" });\nexport const useClerk = () => ({ signOut() {} });\n${shell("")}`);
          if (args.path.startsWith("posthog-js/"))
            return js(`export const usePostHog = () => null;\nexport default {};`);
          return js(shell(`export default Null;`));
        });
        for (const tail of APP_STUBS.keys()) {
          const escaped = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          build.onResolve({ filter: new RegExp(`${escaped}$`) }, () => ({
            path: tail,
            namespace: "qa-app",
          }));
        }
        build.onLoad({ filter: /.*/, namespace: "qa-app" }, (args) => ({
          contents: APP_STUBS.get(args.path),
          loader: "js",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── 2. Real Tailwind CSS from the project config + globals ──────────────────
const globals = readFileSync(join(root, "src/app/globals.css"), "utf8").replace(
  /@import url\([^)]*\);\s*/g,
  "",
);
const generated = await postcss([tailwind(join(root, "tailwind.config.js"))]).process(
  globals,
  { from: join(root, "src/app/globals.css") },
);
writeFileSync(join(outDir, "tw.css"), generated.css);
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

// ── 3. Scenarios (server-stamped values, as the match page builds them) ─────
const TARGET = 4_320;
const SELF_STOP = 2_310;
const BOT_STOP = 4_180;
const NAMES = { seat1Name: "PlayerOne", seat2Name: "GRYND AI", localSeat: 1 };const SCENARIOS = {
  // Nobody has stopped yet: both lanes fly and the centre ticks the live clock.
  flying: { ...NAMES, phase: "active", roundKey: "r3", targetMs: TARGET, liveElapsedMs: 2_050, seat1Frozen: null, seat2Frozen: null },
  // You stopped, the bot is still flying — the live round's money shot.
  live: { ...NAMES, phase: "active", roundKey: "r3", targetMs: TARGET, liveElapsedMs: 6_200, seat1Frozen: SELF_STOP, seat2Frozen: null },
  // Both parked (the bot's published stop landed).
  stopped: { ...NAMES, phase: "active", roundKey: "r3", targetMs: TARGET, liveElapsedMs: 6_200, seat1Frozen: SELF_STOP, seat2Frozen: BOT_STOP },
  // Arming recap of the round that just ended, countdown in the centre.
  arming: { ...NAMES, phase: "arming", roundKey: "r4", targetMs: TARGET, liveElapsedMs: 0, countdownMs: 3_200, seat1Frozen: SELF_STOP, seat2Frozen: BOT_STOP },
  // A long (but legal) username: the name must ellipsise, never push the YOU
  // chip or the neighbouring lane around.
  longname: { ...NAMES, seat1Name: "PlayerOneTwo3", phase: "active", roundKey: "r3", targetMs: TARGET, liveElapsedMs: 2_050, seat1Frozen: null, seat2Frozen: null },
};

// Digits only — `toLocaleString()` renders 2310 as "2,310" or "2 310"
// depending on the host's locale, so the assertion must not depend on the
// separator.
const digits = (text) => String(text ?? "").replace(/[^0-9]/g, "");

const ROUND_RESULT = {
  targetMs: TARGET,
  seat1Name: NAMES.seat1Name,
  seat1ElapsedMs: SELF_STOP,
  seat1DiffMs: Math.abs(SELF_STOP - TARGET),
  seat2Name: NAMES.seat2Name,
  seat2ElapsedMs: BOT_STOP,
  seat2DiffMs: Math.abs(BOT_STOP - TARGET),
  roundWinnerSeat: 2,
  localSeat: 1,
};

const POPUP = {
  targetMs: TARGET,
  ...NAMES,
  seat1Frozen: SELF_STOP,
  seat2Frozen: BOT_STOP,
  popup: {
    result: "loss",
    reason: "completed",
    payout: 0,
    wager: 100,
    opponentName: NAMES.seat2Name,
    winnerName: NAMES.seat2Name,
    finalScore: { seat1: 1, seat2: 3 },
    prizeMultiplier: 1.9,
  },
};

const VIEWPORTS = [
  { label: "360", width: 360, height: 640, dpr: 2, minLane: 80, minLaneCompact: 110, maxBoardH: 360, phone: true },
  { label: "320", width: 320, height: 568, dpr: 2, minLane: 68, minLaneCompact: 90, maxBoardH: 360, phone: true },
  { label: "390", width: 390, height: 844, dpr: 3, minLane: 84, minLaneCompact: 125, maxBoardH: 360, phone: true },
  { label: "1280", width: 1280, height: 900, dpr: 1, minLane: 280, minLaneCompact: 180, maxBoardH: 432, phone: false },
];

// ── 4. DOM snapshot (one collector; every field is optional) ────────────────
const snapshot = (names) =>
  page.evaluate(([n1, n2]) => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    };
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const board = document.querySelector('[data-testid="precision-rocket-race"]');
    if (!board) {
      return {
        vw: window.innerWidth,
        vh: window.innerHeight,
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
        board: null,
      };
    }
    const boardBox = board.getBoundingClientRect();
    // Board-relative box (so a child can be tested against the board itself).
    const boardP = (el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top - boardBox.top,
        bottom: r.bottom - boardBox.top,
        left: r.left - boardBox.left,
        right: r.right - boardBox.left,
        w: r.width,
        h: r.height,
      };
    };
    const labelFor = (name) =>
      [...board.querySelectorAll("p")].find((p) => txt(p)?.startsWith(name)) ?? null;
    const centre = document.querySelector('[data-testid="precision-race-center"]');
    const thresholdWrap = document.querySelector('[data-testid="precision-race-threshold"]');
    const thresholdLabel = thresholdWrap?.querySelector("span") ?? null;
    const fixedHost = [...document.querySelectorAll("div")].find(
      (d) =>
        getComputedStyle(d).position === "fixed" &&
        d.contains(board) &&
        d !== board,
    );
    // The overlay has a full-screen BACKDROP (`fixed inset-0`, overflow
    // visible) wrapping the actual card that carries `max-h-[92vh] overflow-y-auto`.
    const backdrop = document.querySelector('[data-testid="precision-round-result-panel"]');
    const panel = backdrop?.firstElementChild ?? null;
    // The board's own scrolling ancestor inside the popup/panel.
    const scroller = fixedHost;
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      body: rect(document.body),
      board: {
        box: boardP(board),
        // Viewport coordinates — needed to test the page gutter / popup width.
        abs: rect(board),
        w: boardBox.width,
        h: boardBox.height,
        scrollWidth: board.scrollWidth,
        clientWidth: board.clientWidth,
      },
      lanes: [1, 2].map((seat) => {
        const lane = document.querySelector(`[data-testid="precision-race-lane-${seat}"]`);
        if (!lane) return null;
        const name = seat === 1 ? n1 : n2;
        const label = labelFor(name);
        const nameEl = document.querySelector(`[data-testid="precision-race-name-${seat}"]`);
        const youEl = document.querySelector(`[data-testid="precision-race-you-${seat}"]`);
        const rocket = lane.querySelector("svg");
        const stop = document.querySelector(`[data-testid="precision-race-stop-${seat}"]`);
        const clipped = (el) =>
          el ? el.scrollWidth > el.clientWidth + 1 || el.scrollWidth > el.offsetWidth + 1 : null;
        return {
          seat,
          box: boardP(lane),
          labelText: txt(label),
          labelBox: label ? boardP(label) : null,
          nameText: txt(nameEl),
          nameBox: nameEl ? boardP(nameEl) : null,
          nameClipped: clipped(nameEl),
          youBox: youEl ? boardP(youEl) : null,
          youClipped: clipped(youEl),
          rocketBox: rocket ? boardP(rocket) : null,
          stopText: txt(stop),
          stopBox: stop ? boardP(stop) : null,
        };
      }),
      centre: centre
        ? {
            text: txt(centre),
            box: boardP(centre),
            scrollWidth: centre.scrollWidth,
            clientWidth: centre.clientWidth,
          }
        : null,
      threshold: thresholdWrap
        ? { box: boardP(thresholdWrap), labelText: txt(thresholdLabel), labelBox: boardP(thresholdLabel) }
        : null,
      // Only the axis gutter's numeric labels count as ticks (the lanes carry
      // screen-reader spans and the gutter has a caption of its own).
      ticks: [...board.querySelectorAll("span")]
        .filter((s) => /^\d+(\.\d)?s$/.test(txt(s) ?? ""))
        .map((s) => ({ text: txt(s), box: boardP(s) })),
      panel: panel
        ? {
            box: rect(panel),
            maxHeight: getComputedStyle(panel).maxHeight,
            scrollHeight: panel.scrollHeight,
            clientHeight: panel.clientHeight,
            overflowY: getComputedStyle(panel).overflowY,
          }
        : null,
      backdrop: backdrop ? { box: rect(backdrop) } : null,
      host: fixedHost
        ? {
            box: rect(fixedHost),
            scrollHeight: fixedHost.scrollHeight,
            clientHeight: fixedHost.clientHeight,
            overflowY: getComputedStyle(fixedHost).overflowY,
            scrollTop: fixedHost.scrollTop,
          }
        : null,
      resultRows: [1, 2].map((seat) => {
        const row = document.querySelector(`[data-testid="precision-round-result-row-${seat}"]`);
        if (!row) return null;
        // The big numbered value in the row (the same number the lane's stop
        // pill must agree with).
        const big = [...row.querySelectorAll("span")].find((sp) =>
          /text-3xl/.test(sp.className),
        );
        return {
          seat,
          text: txt(row),
          elapsedText: txt(big),
          rankText: txt(row.querySelector(`[data-testid="precision-round-result-rank-${seat}"]`)),
        };
      }),
      popupCaption: txt(
        [...document.querySelectorAll("p")].find((p) => txt(p) === "Last round") ?? null,
      ),
    };
  }, [names.seat1Name, names.seat2Name]);

// ── 5. Assertions ───────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};
const px = (v) => (v == null ? "?" : `${Math.round(v * 10) / 10}px`);
const inside = (box, host, tol = 1.5) =>
  !!box &&
  !!host &&
  box.top >= host.top - tol &&
  box.bottom <= host.bottom + tol &&
  box.left >= host.left - tol &&
  box.right <= host.right + tol;

const raceChecks = (label, s, opts) => {
  const board = s.board;
  const lanes = s.lanes ?? [];
  const lane = (seat) => lanes.find((l) => l?.seat === seat);
  const laneWidths = lanes.map((l) => l?.box?.w ?? 0);
  const minLane = Math.min(...laneWidths);

  check(
    `${label}: the page never scrolls sideways`,
    s.docScrollWidth <= s.docClientWidth + 1,
    `scrollWidth ${s.docScrollWidth} vs ${s.docClientWidth}`,
  );
  check(
    `${label}: the board sits inside the page gutter`,
    board.abs.left >= -1 && board.abs.right <= s.vw + 1,
    `board ${px(board.abs.left)}..${px(board.abs.right)} of ${px(s.vw)}`,
  );
  check(
    `${label}: two lanes really are side by side, both usable`,
    lanes.length === 2 && !!lanes[0] && !!lanes[1] && minLane >= opts.minLane,
    `lane widths ${laneWidths.map((w) => px(w)).join(" / ")} (min ${opts.minLane})`,
  );
  check(
    `${label}: each lane's label sits over its own lane`,
    [1, 2].every((seat) => {
      const l = lane(seat);
      if (!l?.labelBox) return false;
      const centreX = (l.labelBox.left + l.labelBox.right) / 2;
      return centreX >= l.box.left - 1 && centreX <= l.box.right + 1;
    }),
    lanes.map((l) => `${l?.labelText}@${px((l?.labelBox?.left + l?.labelBox?.right) / 2)}`).join(", "),
  );
  check(
    `${label}: each lane's label stays inside its own lane (never spills onto the neighbour)`,
    lanes.every(
      (l) =>
        l?.labelBox &&
        l.labelBox.left >= l.box.left - 1.5 &&
        l.labelBox.right <= l.box.right + 1.5,
    ),
    lanes
      .map((l) => `lane${l?.seat} label ${px(l?.labelBox?.left)}..${px(l?.labelBox?.right)} in ${px(l?.box?.left)}..${px(l?.box?.right)}`)
      .join(", "),
  );
  check(
    `${label}: the YOU chip is never the part that gets cut off`,
    lanes.every((l) => (l?.seat === 1 ? l.youClipped === false : l.youBox === null)),
    lanes.map((l) => `lane${l?.seat} you=${l?.youBox ? `clipped ${l.youClipped}` : "none"}`).join(", "),
  );
  check(
    `${label}: the player's name keeps real room (not squeezed to nothing)`,
    lanes.every((l) => (l?.nameBox?.w ?? 0) >= 26),
    lanes.map((l) => `${l?.nameText}: ${px(l?.nameBox?.w)}`).join(", "),
  );
  check(
    `${label}: the seconds axis + its caption are visible (ticks not clipped off the board)`,
    (s.ticks ?? []).length >= 2 &&
      (s.ticks ?? []).some((t) => /^\d+(\.\d)?s$/.test(t.text ?? "")) &&
      (s.ticks ?? []).every((t) => t.box.left >= -2 && t.box.right <= s.board.w + 2),
    `${(s.ticks ?? []).length} ticks: ${(s.ticks ?? []).map((t) => t.text).join(", ")}`,
  );
  check(
    `${label}: the target threshold line + label are readable inside the board`,
    !!s.threshold &&
      s.threshold.box.top >= -1 &&
      s.threshold.box.bottom <= s.board.h + 1 &&
      inside(s.threshold.labelBox, {
        top: 0,
        bottom: s.board.h,
        left: 0,
        right: s.board.w,
      }),
    s.threshold
      ? `line at ${px(s.threshold.box.top)}, label "${s.threshold.labelText}"`
      : "no threshold",
  );
  check(
    `${label}: both rockets exist, one per lane`,
    !!lane(1)?.rocketBox && !!lane(2)?.rocketBox,
    lanes.map((l) => `lane${l?.seat} rocket ${l?.rocketBox ? "yes" : "MISSING"}`).join(", "),
  );
  check(
    `${label}: the rockets never overlap (each stays in its own lane)`,
    !lane(1)?.rocketBox ||
      !lane(2)?.rocketBox ||
      lane(1).rocketBox.right <= lane(2).rocketBox.left + 1,
    lane(1)?.rocketBox && lane(2)?.rocketBox
      ? `rocket1 right ${px(lane(1).rocketBox.right)} vs rocket2 left ${px(lane(2).rocketBox.left)}`
      : "missing",
  );
  check(
    `${label}: every rocket stays inside the board (incl. the one pinned at the axis ceiling)`,
    lanes.every((l) => inside(l?.rocketBox, { top: 0, bottom: s.board.h, left: 0, right: s.board.w })),
    lanes.map((l) => `lane${l?.seat} ${l?.rocketBox ? `${px(l.rocketBox.top)}..${px(l.rocketBox.bottom)}` : "?"}`).join(", "),
  );
  check(
    `${label}: the parked rocket's stop pill stays inside the board`,
    lanes
      .filter((l) => l?.stopBox)
      .every((l) => inside(l.stopBox, { top: 0, bottom: s.board.h, left: 0, right: s.board.w })),
    lanes
      .map((l) => `lane${l?.seat} ${l?.stopText ?? "-"} ${l?.stopBox ? `${px(l.stopBox.left)}..${px(l.stopBox.right)}` : ""}`)
      .join(", "),
  );
  if (s.centre) {
    check(
      `${label}: the centre timer fits its column (no overflow)`,
      s.centre.scrollWidth <= s.centre.clientWidth + 1,
      `"${s.centre.text}" ${s.centre.scrollWidth} vs ${s.centre.clientWidth}`,
    );
    check(
      `${label}: the centre timer never runs into the opponent's lane`,
      s.centre.box.right <= lane(2).box.left + 1 && s.centre.box.left >= lane(1).box.right - 1,
      `centre ${px(s.centre.box.left)}..${px(s.centre.box.right)}, lanes ${px(lane(1).box.right)} / ${px(lane(2).box.left)}`,
    );
  }
  check(
    `${label}: the board keeps a phone-friendly height (STOP controls stay on the fold)`,
    board.h > 140 && board.h <= opts.maxBoardH + 1,
    `board ${px(board.h)} tall (cap ${opts.maxBoardH})`,
  );
};

let browser = null;
let page = null;
const consoleErrors = [];
const shot = [];

const mount = async (vp) => {
  const p = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    hasTouch: vp.dpr > 1,
  });
  p.on("pageerror", (err) => consoleErrors.push(`pageerror(${vp.label}): ${err.message}`));
  p.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Asset/font fetches fail on a file:// page with no network — not layout.
    // The real PvpResultScreen also probes its own progression endpoints; on
    // file:// those reject with an unsupported-scheme error and the screen is
    // designed to swallow that (it never blocks the result).
    if (
      /Failed to load resource|fonts\.googleapis|net::ERR|URL scheme "file" is not supported|api\/(user\/stats|leaderboard)/.test(
        text,
      )
    )
      return;
    consoleErrors.push(`console(${vp.label}): ${text}`);
  });
  await p.goto("file://" + join(outDir, "index.html").replace(/\\/g, "/"));
  await p.addStyleTag({ path: join(outDir, "tw.css") });
  await p.waitForFunction(() => typeof window.renderRace === "function", null, { timeout: 20000 });
  return p;
};

const render = async (kind, payload, waitFor) => {
  await page.evaluate(
    ([k, pl]) => {
      if (["flying", "live", "stopped", "arming", "longname"].includes(k)) window.renderRace(pl);
      else if (k === "roundResult") window.renderRoundResult(pl);
      else if (k === "popup") window.renderPopup(pl);
      else throw new Error(`unknown scenario ${k}`);
    },
    [kind, payload],
  );
  await page.waitForFunction(
    (sel) => !!document.querySelector(sel),
    waitFor,
    { timeout: 15000 },
  );
  // Let framer-motion's entrance springs settle before measuring/screenshotting.
  await page.waitForTimeout(1100);
};

const capture = async (name) => {
  const file = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  shot.push(file);
  const board = await page.locator('[data-testid="precision-rocket-race"]').count();
  if (board) {
    const crop = join(SHOTS, `${name}-board.png`);
    await page.locator('[data-testid="precision-rocket-race"]').screenshot({ path: crop });
    shot.push(crop);
  }
  return file;
};

try {
  browser = await chromium.launch();

  for (const vp of VIEWPORTS) {
    page = await mount(vp);
    console.log(`\n── ${vp.label} × ${vp.height} (dpr ${vp.dpr}) ─────────────────────────`);

    // ── Live round: you parked, the bot still flying ────────────────────────
    await render("flying", SCENARIOS.flying, '[data-testid="precision-race-center"]');
    let s = await snapshot(NAMES);
    raceChecks(`${vp.label} flying`, s, {
      minLane: vp.minLane,
      maxBoardH: vp.maxBoardH,
    });
    check(
      `${vp.label} flying: no lane is parked, and the centre ticks the live clock`,
      s.lanes.every((l) => l.stopBox == null) && s.centre?.text === "2.05s",
      `pills ${s.lanes.map((l) => l.stopText ?? "none").join("/")}, centre ${s.centre?.text}`,
    );
    check(
      `${vp.label} flying: both rockets are level while both lanes fly`,
      Math.abs(s.lanes[0].rocketBox.bottom - s.lanes[1].rocketBox.bottom) <= 1,
      `you ${px(s.lanes[0].rocketBox.bottom)}, opponent ${px(s.lanes[1].rocketBox.bottom)}`,
    );
    await capture(`${vp.label}-flying`);

    // ── Live round: you parked, the bot still flying ────────────────────────
    await render("live", SCENARIOS.live, '[data-testid="precision-race-stop-1"]');
    s = await snapshot(NAMES);
    raceChecks(`${vp.label} live`, s, {
      minLane: vp.minLane,
      maxBoardH: vp.maxBoardH,
    });
    check(
      `${vp.label} live: the flying opponent has climbed past the parked rocket`,
      s.lanes[1].rocketBox.bottom < s.lanes[0].rocketBox.bottom,
      `opponent ${px(s.lanes[1].rocketBox.bottom)} vs you ${px(s.lanes[0].rocketBox.bottom)} (smaller = higher)`,
    );
    check(
      `${vp.label} live: only the parked lane shows a stop pill`,
      s.lanes[0].stopBox != null &&
        s.lanes[1].stopBox == null &&
        s.lanes[0].stopText === "2.31s",
      `you ${s.lanes[0].stopText ?? "none"}, opponent ${s.lanes[1].stopText ?? "none"}`,
    );
    check(
      `${vp.label} live: the centre freezes on YOUR stop the moment you click (not the live clock)`,
      !!s.centre && s.centre.text === "2.31s",
      s.centre?.text ?? "missing",
    );
    await capture(`${vp.label}-live`);

    // ── Both parked ────────────────────────────────────────────────────────
    await render("stopped", SCENARIOS.stopped, '[data-testid="precision-race-stop-2"]');
    s = await snapshot(NAMES);
    check(
      `${vp.label} stopped: both lanes pin their server-stamped stop`,
      s.lanes[0].stopText === "2.31s" && s.lanes[1].stopText === "4.18s",
      `${s.lanes[0].stopText} / ${s.lanes[1].stopText}`,
    );
    check(
      `${vp.label} stopped: the opponent's rocket sits higher on the time axis`,
      s.lanes[1].rocketBox.bottom < s.lanes[0].rocketBox.bottom,
      `opponent ${px(s.lanes[1].rocketBox.bottom)} vs you ${px(s.lanes[0].rocketBox.bottom)}`,
    );
    await capture(`${vp.label}-stopped`);

    // ── Arming recap: countdown in the centre, both rockets frozen ─────────
    await render("arming", SCENARIOS.arming, '[data-testid="precision-race-center"]');
    s = await snapshot(NAMES);
    raceChecks(`${vp.label} arming`, s, { minLane: vp.minLane, maxBoardH: vp.maxBoardH });
    check(
      `${vp.label} arming: the centre slot hosts the countdown, both rockets recap the last round`,
      s.centre.text === "4" &&
        s.lanes[0].stopText === "2.31s" &&
        s.lanes[1].stopText === "4.18s",
      `centre "${s.centre.text}", ${s.lanes[0].stopText} / ${s.lanes[1].stopText}`,
    );
    await capture(`${vp.label}-arming`);
    // Baseline for the compact board's wider-lane assertion below.
    const fullLaneW = Math.min(...s.lanes.map((l) => l.box.w));

    // ── A long username must degrade to an ellipsis, not a broken lane ─────
    if (vp.phone) {
      const LONG = { seat1Name: "PlayerOneTwo3", seat2Name: NAMES.seat2Name };
      await render("longname", SCENARIOS.longname, '[data-testid="precision-race-name-1"]');
      const l = await snapshot(LONG);
      check(
        `${vp.label} long name: the name ellipsises but never pushes the lane around`,
        l.lanes[0].nameClipped === true &&
          l.lanes[0].labelBox.right <= l.lanes[0].box.right + 1.5 &&
          l.lanes[0].labelBox.left >= l.lanes[0].box.left - 1.5 &&
          l.lanes[1].labelBox.left >= l.lanes[1].box.left - 1.5,
        `name ${px(l.lanes[0].nameBox.w)} in a ${px(l.lanes[0].box.w)} lane (clipped ${l.lanes[0].nameClipped})`,
      );
      check(
        `${vp.label} long name: the YOU chip and the opponent's label are untouched`,
        l.lanes[0].youClipped === false &&
          l.lanes[1].labelText.startsWith(NAMES.seat2Name) &&
          l.lanes[1].nameClipped === false,
        `you clipped ${l.lanes[0].youClipped}, opponent "${l.lanes[1].labelText}" clipped ${l.lanes[1].nameClipped}`,
      );
      await capture(`${vp.label}-longname`);
    }

    // ── Per-round result overlay (compact board embedded) ──────────────────
    await render("roundResult", ROUND_RESULT, '[data-testid="precision-round-result-race"]');
    s = await snapshot(NAMES);
    const cBoard = s.board;
    const cLane = (seat) => s.lanes.find((l) => l?.seat === seat);
    check(
      `${vp.label} round-result: the card fits the viewport (header, board and rows reachable)`,
      s.panel.box.top >= -1 &&
        s.panel.box.bottom <= s.vh + 1 &&
        s.panel.maxHeight !== "none" &&
        s.panel.box.h <= s.vh + 1,
      `card ${px(s.panel.box.top)}..${px(s.panel.box.bottom)} of ${px(s.vh)}, max-h ${s.panel.maxHeight}`,
    );
    check(
      `${vp.label} round-result: the card scrolls internally instead of spilling off the screen`,
      s.panel.overflowY === "auto",
      `overflow-y ${s.panel.overflowY} (content ${s.panel.scrollHeight} vs box ${s.panel.clientHeight})`,
    );
    check(
      `${vp.label} round-result: the embedded board fits the card width, no sideways scroll`,
      s.docScrollWidth <= s.docClientWidth + 1 &&
        s.board.abs.left >= -1 &&
        s.board.abs.right <= s.panel.box.right + 1,
      `board ${px(s.board.abs.left)}..${px(s.board.abs.right)}, card ${px(s.panel.box.left)}..${px(s.panel.box.right)}`,
    );
    // The compact board drops the centre column. On a phone the result card is
    // roughly as wide as the page, so the lanes must come out WIDER than the
    // live round's; on desktop the card is `max-w-lg`, narrower than the page
    // board, so only the absolute floor applies.
    const compactLaneW = Math.min(cLane(1).box.w, cLane(2).box.w);
    const compactFloor = vp.phone ? Math.max(vp.minLaneCompact, fullLaneW + 1) : vp.minLaneCompact;
    check(
      `${vp.label} round-result: the compact board drops the centre column so the lanes widen`,
      s.centre === null && compactLaneW >= compactFloor,
      `centre ${s.centre ? "present" : "absent"}, lanes ${px(compactLaneW)} vs the live board's ${px(fullLaneW)} (floor ${px(compactFloor)})`,
    );
    check(
      `${vp.label} round-result: both rockets are parked at the values the rows below report`,
      cLane(1).stopText === "2.31s" &&
        cLane(2).stopText === "4.18s" &&
        digits(s.resultRows[0]?.elapsedText) === "2310" &&
        digits(s.resultRows[1]?.elapsedText) === "4180",
      `pills ${cLane(1).stopText} / ${cLane(2).stopText}; rows ${s.resultRows.map((r) => r?.elapsedText).join(" / ")}`,
    );
    await capture(`${vp.label}-round-result`);

    // ── End-of-match popup (frozen last round in the main flow) ────────────
    await render("popup", POPUP, '[data-testid="precision-rocket-race"]');
    const bare = await snapshot(NAMES);
    check(
      `${vp.label} popup: the frozen last-round board renders under the "Last round" caption`,
      bare.popupCaption === "Last round" &&
        bare.lanes[0].stopText === "2.31s" &&
        bare.lanes[1].stopText === "4.18s",
      `caption "${bare.popupCaption}", pills ${bare.lanes[0].stopText} / ${bare.lanes[1].stopText}`,
    );
    check(
      `${vp.label} popup: no sideways scroll, the popup body scrolls vertically instead`,
      bare.docScrollWidth <= bare.docClientWidth + 1 &&
        (bare.host?.overflowY === "auto" || bare.host?.overflowY === "scroll"),
      `scrollWidth ${bare.docScrollWidth} vs ${bare.docClientWidth}, host overflow-y ${bare.host?.overflowY}`,
    );
    check(
      `${vp.label} popup: the embedded board fits the popup width`,
      bare.board.abs.left >= -1 && bare.board.abs.right <= s.vw + 1,
      `board ${px(bare.board.abs.left)}..${px(bare.board.abs.right)} of ${px(s.vw)}`,
    );
    await capture(`${vp.label}-popup-top`);
    await page.evaluate(() => window.scrollPopupToRace());
    await page.waitForTimeout(350);
    const scrolled = await snapshot(NAMES);
    check(
      `${vp.label} popup: the board is reachable by scrolling (fully inside its own scroll box)`,
      !!scrolled.host && scrolled.board.abs.top >= -2 && scrolled.board.abs.bottom <= s.vh + 2,
      `board ${px(scrolled.board.abs.top)}..${px(scrolled.board.abs.bottom)} of ${px(s.vh)} (scrolled ${scrolled.host?.scrollTop}px)`,
    );
    check(
      `${vp.label} popup: the frozen board is on screen without scrolling when it already fits`,
      scrolled.host.scrollHeight > scrolled.host.clientHeight || scrolled.board.abs.bottom <= s.vh + 1,
      `content ${scrolled.host.scrollHeight} vs box ${scrolled.host.clientHeight}`,
    );
    await capture(`${vp.label}-popup-race`);
    await page.close();

  }

  check(
    "no page/console errors anywhere in the run",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );
} finally {
  if (browser) await browser.close();
}

// ── 6. Report ───────────────────────────────────────────────────────────────
console.log(`\nScreenshots written to qa/reports/precision-mobile/ (${shot.length} files)`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
