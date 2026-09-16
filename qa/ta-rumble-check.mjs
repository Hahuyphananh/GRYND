// qa/ta-rumble-check.mjs
//
// Browser check for Tower Arena's impact rumble. Mounts the REAL TowerScene
// (qa/ta-trail-harness.jsx) and measures the scene wrapper's transform frame by
// frame in Chromium while driving the real `impact` token, asserting:
//
//   1. The scene punches out immediately (peak displacement within ~40ms) and
//      the whole move is fast (settles in ~110ms, inside the 80–140ms band).
//   2. The movement is irregular: X and Y go out of phase, and the direction
//      reverses several times — not a straight diagonal sway.
//   3. It progressively settles (bigger steps early, smaller steps late).
//   4. It ALWAYS returns to exactly the original position: identity transform,
//      and the SVG's own on-screen rect is back where it started.
//   5. Consecutive shakes differ (per-impact jitter), but stay bounded.
//   6. Rapid, overlapping impacts never accumulate and never leave the stage
//      offset, however many land back to back.
//   7. `prefers-reduced-motion` removes the rumble entirely.
//   8. The rumble is geometry-independent: short fall, long fall, a tower up at
//      the ceiling, and no falling block at all (match ending) all behave the
//      same, because the rumble is driven only by the impact token.
//   9. Source wiring: `impact`/`impactKey` is the ONLY trigger, both drop paths
//      (local human + remote/bot) bump it, and no other animation library or
//      scene offset was introduced.
//
// Run: node qa/ta-rumble-check.mjs

import { chromium } from "playwright";
import esbuild from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_FILE = "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx";
const pageSrc = readFileSync(join(root, PAGE_FILE), "utf8");

const SHAKE_SEL = '[data-testid="ta-scene-shake"]';
const MAX_PX = 15; // hard bound on the punch (the project's stated ~15px ceiling)

// ── The rumble's constants, read from the component itself ─────────────
// Parsed up here because both the browser scenarios (expected strength for the
// fall the scene actually used) and the analytic checks below need them.
const readNumbers = (name) => {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(pageSrc);
  return m
    ? m[1]
        .split(",")
        .map((v) => Number.parseFloat(v.trim()))
        .filter((v) => Number.isFinite(v))
    : null;
};
const readConst = (name) => Number.parseFloat((new RegExp(`const ${name} = ([\\d.]+)`).exec(pageSrc) || [])[1]);
const ampMin = readConst("SHAKE_MIN_AMPLITUDE");
const ampMax = readConst("SHAKE_MAX_AMPLITUDE");
const fallRef = readConst("FALL_REFERENCE_CELLS");
const minFall = readConst("MIN_FALL_CELLS");
const duration = readConst("SHAKE_DURATION");
const jitterMin = readConst("SHAKE_JITTER_MIN");
const jitterMax = readConst("SHAKE_JITTER_MAX");
const keyX = readNumbers("const SHAKE_X");
const keyY = readNumbers("const SHAKE_Y");
const keyTimes = readNumbers("const SHAKE_TIMES");
// Worst case the browser can ever see: maximum amplitude with maximum jitter.
const steps = keyX && keyY ? keyX.map((v, i) => ({ x: v * ampMax * jitterMax, y: keyY[i] * ampMax * jitterMax })) : null;
const mags = steps ? steps.map((s) => Math.hypot(s.x, s.y)) : null;

/** Vector peak (px, max jitter) the punch reaches for a fall of `dz` cells. */
const expectedPeak = (dz) => {
  const strength = Math.min(1, Math.max(0, (dz - minFall) / (fallRef - minFall)));
  return (ampMin + (ampMax - ampMin) * strength) * jitterMax;
};

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

// ── Bundle the harness + the real scene (same stubs as the trail check) ──
const STUBS = [
  { match: /^next\/navigation$/, source: `export const useParams = () => ({});\nexport const useRouter = () => ({ push() {}, replace() {}, back() {}, prefetch() {} });\nexport const usePathname = () => "/";` },
  { match: /^posthog-js\/react$/, source: `export const usePostHog = () => null;` },
  { match: /creator-mode\/CreatorModeHost$/, source: `export default function CreatorModeHost() { return null; }` },
  { match: /creator-mode\/CreatorModeLayout$/, source: `const Null = () => null;\nexport const CreatorModeShell = Null;\nexport const CreatorView = Null;\nexport const ShellHeader = Null;\nexport const ShellMain = Null;\nexport const ShellAside = Null;\nexport default Null;` },
  { match: /creator-mode\/CreatorResultOverlay$/, source: `export default function CreatorResultOverlay() { return null; }` },
  { match: /components\/navigation-bar$/, source: `export default function NavigationBar() { return null; }` },
  { match: /components\/Footer$/, source: `export default function Footer() { return null; }` },
  { match: /components\/IconAvatar$/, source: `export default function IconAvatar() { return null; }` },
  { match: /components\/lobby\/PvpLobby$/, source: `export const CoinIcon = () => null;\nexport default function PvpLobby() { return null; }` },
  { match: /context\/SocketProvider$/, source: `export const useSocket = () => ({ socket: null });` },
  { match: /lib\/gameAudio$/, source: `export const playTurnSwitch = () => {};\nexport const playCrash = () => {};\nexport const playTick = () => {};\nexport const playVictory = () => {};\nexport const playDefeat = () => {};` },
];

const outDir = mkdtempSync(join(tmpdir(), "ta-rumble-"));
const bundleOut = join(outDir, "harness.js");
await esbuild.build({
  entryPoints: [join(root, "qa/ta-trail-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: bundleOut,
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "page-stubs",
      setup(build) {
        for (const stub of STUBS) {
          const path = `stub:${stub.match.source}`;
          build.onResolve({ filter: stub.match }, () => ({ path, namespace: "page-stub" }));
          build.onLoad(
            { filter: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) },
            () => ({ contents: stub.source, loader: "js", resolveDir: root }),
          );
        }
      },
    },
  ],
});
const harnessJs = readFileSync(bundleOut, "utf8");

const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Tower Arena rumble check</title>
<style>
  body { margin: 0; background: #05070f }
  .h-full { height: 100% }
  .w-full { width: 100% }
</style></head>
<body><div id="root"></div><script src="/harness.js"></script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(pageHtml);
    return;
  }
  if (url.pathname === "/harness.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(harnessJs);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ── Scenario payloads ──────────────────────────────────────────────────
const tower = [{ id: "b0", shape: "short", cells: [{ x: 0, depth: 0, z: 0 }], turnNumber: 1 }];
// Towers chosen so the scene's own geometry yields a specific visual fall
// distance (`dropDz`): the spawn sits 10 cells above the landing unless the top
// of the stage clamps it, and the stage grows with the tower.
//   floor landing (z=1)        → dropDz 10  (a full-height fall)
//   landing at z=21            → dropDz 6.5 (medium)
//   landing at z=26 (ceiling)  → dropDz 3.5 (the shortest fall in the game)
const tallTower = [
  { id: "b0", shape: "short", cells: [{ x: 0, depth: 0, z: 0 }], turnNumber: 1 },
  { id: "b1", shape: "short", cells: [{ x: 0, depth: 0, z: 23 }], turnNumber: 2 },
];
const midTower = [
  { id: "b0", shape: "short", cells: [{ x: 0, depth: 0, z: 0 }], turnNumber: 1 },
  { id: "b1", shape: "short", cells: [{ x: 0, depth: 0, z: 20 }], turnNumber: 2 },
];
const ceilingTower = [
  { id: "b0", shape: "short", cells: [{ x: 0, depth: 0, z: 0 }], turnNumber: 1 },
  { id: "b1", shape: "short", cells: [{ x: 0, depth: 0, z: 24 }], turnNumber: 2 },
];
const falling = (z = 1, willFall = false) => ({
  cells: [
    { x: 6, depth: 0, z },
    { x: 7, depth: 0, z },
    { x: 8, depth: 0, z },
  ],
  extra: [],
  willFall,
  slideDx: 0,
  key: 1,
  shape: "I",
});

/**
 * Bump the impact token and record the scene wrapper's transform every frame.
 * `extraBumps` are delays (ms) at which further impacts land — used for the
 * rapid-fire case. Everything runs in-page so frames aren't lost to IPC.
 */
async function sampleRumble(page, { bumpTo = 1, from = 0, extraBumps = [], ms = 380 } = {}) {
  return page.evaluate(
    async ({ bumpTo, from, extraBumps, ms, sel }) => {
      const read = () => {
        const el = document.querySelector(sel);
        if (!el) return { tx: 0, ty: 0, transform: "none", missing: true };
        const cs = getComputedStyle(el);
        const m = /matrix\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(
          cs.transform || "",
        );
        return {
          tx: m ? parseFloat(m[5]) : 0,
          ty: m ? parseFloat(m[6]) : 0,
          transform: cs.transform,
        };
      };
      const svgRect = () => {
        const svg = document.querySelector("svg");
        if (!svg) return null;
        const r = svg.getBoundingClientRect();
        return { left: Math.round(r.left * 100) / 100, top: Math.round(r.top * 100) / 100 };
      };

      const frames = [];
      const bumps = [];
      const t0 = performance.now();
      const doBump = (value) => {
        bumps.push(performance.now() - t0);
        window.updateScene({ impact: value });
      };
      if (from !== bumpTo) doBump(bumpTo);

      let next = 0;
      await new Promise((resolve) => {
        const tick = () => {
          const elapsed = performance.now() - t0;
          for (let i = next; i < extraBumps.length && elapsed >= extraBumps[i]; i += 1) {
            doBump(bumpTo + i + 1);
            next = i + 1;
          }
          frames.push({ ms: elapsed, ...read() });
          if (elapsed < ms) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });

      return { frames, bumps, svgAfter: svgRect() };
    },
    { bumpTo, from, extraBumps, ms, sel: SHAKE_SEL },
  );
}

const size = (f) => Math.hypot(f.tx, f.ty);
const settleMs = (frames) => {
  let last = frames[0];
  for (const f of frames) if (size(f) > 0.5) last = f;
  return last.ms;
};

/**
 * Median frame interval of a sampling run.
 *
 * A ~110ms envelope cannot be sampled frame-accurately in headless Chromium
 * (software rendering lands frames 30–70ms apart, so a whole shake is 2–3
 * samples and the punch is often missed entirely). Frame timing is therefore
 * measured rather than assumed, and the assertions below are expressed in
 * frames: what the browser can prove is that the shake fires, moves, is bounded
 * and returns exactly home; the envelope's shape and peak are proven
 * deterministically from the keyframe constants at the end of this file.
 */
const frameInterval = (frames) => {
  const gaps = frames.slice(1).map((f, i) => f.ms - frames[i].ms).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 16;
};

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.renderScene && window.updateScene);

  // Warm-up: the first animation after page load is not trustworthy — the main
  // thread is still compiling the bundle, so requestAnimationFrame starves and
  // the measurement lands late. Fire a throwaway impact and let it finish.
  await page.evaluate(
    (p) => window.renderScene({ ...p, width: 420, height: 620, impact: 0 }),
    { tower, falling: falling() },
  );
  await page.waitForSelector(SHAKE_SEL);
  await page.evaluate(() => window.updateScene({ impact: 999 }));
  await page.waitForTimeout(280);

  // ── A normal landing ──────────────────────────────────────────────────
  await page.evaluate(
    (p) => window.renderScene({ ...p, width: 420, height: 620, impact: 0 }),
    { tower, falling: falling() },
  );
  await page.waitForSelector(SHAKE_SEL);
  const restRect = await page.evaluate(() => {
    const r = document.querySelector("svg").getBoundingClientRect();
    return { left: Math.round(r.left * 100) / 100, top: Math.round(r.top * 100) / 100 };
  });
  const hit = await sampleRumble(page, { bumpTo: 1 });

  const moved = hit.frames.filter((f) => size(f) > 0.5);
  const peak = hit.frames.reduce((a, f) => (size(f) > size(a) ? f : a), hit.frames[0]);
  const peakAt = peak.ms;
  const settled = settleMs(hit.frames);
  const last = hit.frames[hit.frames.length - 1];

  const frameMs = frameInterval(hit.frames);
  // NOTE: absolute start/settle times are NOT asserted here. Headless Chromium
  // adds a variable 30–100ms of scheduler/render latency between the impact and
  // the first frame that shows it (measured across runs), which says nothing
  // about the effect. What the browser proves is that the shake fires, moves,
  // is bounded, is transient, and ends exactly home; the envelope (punch at
  // ~11ms, decay, 110ms total) is proven from the component's own constants at
  // the end of this file.
  check(
    "the scene moves when — and only when — the impact token bumps",
    moved.length > 0 && Math.hypot(peak.tx, peak.ty) > 0.5,
    `first movement ${moved[0]?.ms.toFixed(0)}ms after the bump (frames ~${frameMs.toFixed(0)}ms apart), peak ${Math.hypot(peak.tx, peak.ty).toFixed(1)}px`,
  );

  // Transient: once it is back home it stays home for the rest of the window.
  // (0.05px counts as home — the block is sub-pixel at that point.)
  const lastMotionAt = hit.frames.filter((f) => size(f) > 0.05).reduce((a, f) => Math.max(a, f.ms), 0);
  const trailing = hit.frames.filter((f) => f.ms > lastMotionAt);
  check(
    "the shake is transient: it settles and stays home afterwards",
    trailing.length >= 3 && trailing.every((f) => size(f) <= 0.05) && moved.length <= 8,
    `moved over ${moved.length} frames (${(lastMotionAt - (moved[0]?.ms ?? 0)).toFixed(0)}ms), then ${trailing.length} frames at rest`,
  );
  check(
    "the punch stays subtle and bounded",
    Math.abs(peak.tx) <= MAX_PX && Math.abs(peak.ty) <= MAX_PX,
    `max |x|=${Math.max(...hit.frames.map((f) => Math.abs(f.tx))).toFixed(1)}px |y|=${Math.max(...hit.frames.map((f) => Math.abs(f.ty))).toFixed(1)}px`,
  );

  // Both axes are really driven (the *irregularity* of the pattern is proven
  // analytically further down — a ~110ms envelope is only 5–7 frames here, far
  // too coarse to count direction reversals).
  const maxX = Math.max(...hit.frames.map((f) => Math.abs(f.tx)));
  const maxY = Math.max(...hit.frames.map((f) => Math.abs(f.ty)));
  check(
    "both axes move (an X/Y shake, not a single-axis slide)",
    maxX > 0.3 && maxY > 0.3,
    `max |x|=${maxX.toFixed(1)}px |y|=${maxY.toFixed(1)}px`,
  );


  // Exact return: no permanent offset, on the wrapper or the rendered SVG.
  check(
    "it returns to exactly the original position (identity transform, SVG back home)",
    last.tx === 0 &&
      last.ty === 0 &&
      hit.svgAfter &&
      Math.abs(hit.svgAfter.left - restRect.left) < 0.5 &&
      Math.abs(hit.svgAfter.top - restRect.top) < 0.5,
    `transform=${last.transform} svg ${JSON.stringify(restRect)} → ${JSON.stringify(hit.svgAfter)}`,
  );

  // ── Consecutive impacts: different, but each one lands home ────────────
  const second = await sampleRumble(page, { bumpTo: 2, from: 1 });
  const trace = (run) => run.frames.filter((f) => size(f) > 0.5).map((f) => `${f.tx.toFixed(1)}/${f.ty.toFixed(1)}`).join(",");
  const secondLast = second.frames[second.frames.length - 1];
  check(
    "a second landing shakes differently (per-impact jitter) and still lands home",
    trace(hit) !== trace(second) && secondLast.tx === 0 && secondLast.ty === 0,
    `trace[0..3]=${trace(second).split(",").slice(0, 3).join(" ")}`,
  );

  // ── Rapid consecutive impacts (mid-shake restarts) ────────────────────
  const rapid = await sampleRumble(page, {
    bumpTo: 3,
    from: 2,
    extraBumps: [35, 70, 105, 140, 175, 210],
    ms: 520,
  });
  const rapidLast = rapid.frames[rapid.frames.length - 1];
  const rapidPeak = Math.max(...rapid.frames.map(size));
  check(
    "rapid consecutive impacts never accumulate or get stuck at an offset",
    rapidLast.tx === 0 && rapidLast.ty === 0 && rapidPeak <= MAX_PX,
    `peak=${rapidPeak.toFixed(1)}px final=${rapidLast.transform} bumps=${rapid.bumps.length}`,
  );

  // ── Reduced motion ────────────────────────────────────────────────────
  // A dedicated page whose preference is set BEFORE load. That is both the
  // real-world case (a visitor who already prefers reduced motion) and the
  // only one motions hooks honour: framer-motion reads the preference once per
  // mount, and Playwright's mid-session emulateMedia never updates it.
  const rmPage = await browser.newPage({
    viewport: { width: 900, height: 900 },
    reducedMotion: "reduce",
  });
  await rmPage.goto(base, { waitUntil: "networkidle" });
  await rmPage.waitForFunction(() => window.renderScene && window.updateScene);
  await rmPage.evaluate(
    (p) => window.renderScene({ ...p, width: 420, height: 620, impact: 0 }),
    { tower, falling: falling() },
  );
  await rmPage.waitForSelector(SHAKE_SEL);
  const reduced = await sampleRumble(rmPage, { bumpTo: 1, ms: 260 });
  check(
    "prefers-reduced-motion: no rumble at all (scene stays put)",
    Math.max(...reduced.frames.map(size)) <= 0.5,
    `max offset=${Math.max(...reduced.frames.map(size)).toFixed(2)}px`,
  );
  await rmPage.close();

  // ── Impact strength follows the fall distance ──────────────────────────
  // The scene's OWN fall distance is read back out of the DOM: the falling
  // block's initial transform is exactly `y: -dropDz`, so this measures what
  // the component computed rather than re-deriving its geometry here.
  const scenarios = [
    { name: "very short fall (lands at the ceiling)", drops: [{ tower: ceilingTower, falling: falling(26) }], band: [3, 5] },
    { name: "medium fall", drops: [{ tower: midTower, falling: falling(21) }], band: [6, 9] },
    { name: "long fall (drops the full sky band)", drops: [{ tower, falling: falling(1) }], band: [10, 15] },
    { name: "very tall tower", drops: [{ tower: ceilingTower, falling: falling(26, true) }], band: [3, 5] },
    {
      name: "consecutive placements (long → medium → short)",
      drops: [
        { tower, falling: falling(1) },
        { tower: midTower, falling: falling(21) },
        { tower: ceilingTower, falling: falling(26) },
      ],
      band: [3, 15],
    },
    // No block left to size from: the rumble must fall back to its quietest
    // state rather than reusing a stale, unrelated strength.
    { name: "match ending (no falling block left)", drops: [{ tower, falling: null }], band: [0, 5] },
  ];
  const strength = [];
  const readDropDz = (target) =>
    target.evaluate(() => {
      const el = document.querySelector('[data-testid="ta-drop-block"]');
      if (!el) return null;
      const m = /matrix\(1, 0, 0, 1, 0, (-?[\d.]+)\)/.exec(getComputedStyle(el).transform || "");
      return m ? Math.abs(Number.parseFloat(m[1])) : null;
    });

  // Measured peaks are undersampled (a 110ms envelope is 5–7 frames), so each
  // shake is repeated and the largest observed displacement is kept — this
  // compares the strengths, it does not try to measure the exact punch.
  const measurePeak = async (target, repeats = 3) => {
    let token = 500;
    let peak = 0;
    let home = true;
    for (let i = 0; i < repeats; i += 1) {
      const run = await sampleRumble(target, { bumpTo: token + 1, from: token, ms: 240 });
      token += 1;
      peak = Math.max(peak, ...run.frames.map(size));
      const end = run.frames[run.frames.length - 1];
      home = home && end.tx === 0 && end.ty === 0;
    }
    return { peak, home };
  };

  for (const scenario of scenarios) {
    let dz = null;
    let peak = 0;
    let home = true;
    for (const drop of scenario.drops) {
      await page.evaluate(
        (p) => window.renderScene({ ...p, width: 420, height: 620, impact: 0 }),
        drop,
      );
      await page.waitForSelector(SHAKE_SEL);
      const measuredDz = await readDropDz(page);
      if (measuredDz !== null) dz = measuredDz;
      const result = await measurePeak(page);
      peak = Math.max(peak, result.peak);
      home = home && result.home;
    }
    strength.push({ ...scenario, dz, peak, home });
  }

  check(
    "every scenario rumbles and returns exactly home",
    strength.every((s) => s.home && s.peak > 0),
    strength.map((s) => `${s.name.split(" (")[0]}=${s.peak.toFixed(1)}px${s.home ? "" : " STUCK"}`).join(" · "),
  );
  check(
    "a longer fall always shakes harder than a shorter one",
    (() => {
      const long = strength.find((s) => s.name.startsWith("long"));
      const medium = strength.find((s) => s.name.startsWith("medium"));
      const short = strength.find((s) => s.name.startsWith("very short"));
      return long.peak > medium.peak && medium.peak > short.peak && long.peak > short.peak * 1.4;
    })(),
    strength.map((s) => `${s.dz?.toFixed(1)}cells→${s.peak.toFixed(1)}px`).join(" · "),
  );
check(
  "no scenario exceeds the ~15px ceiling",
  strength.every((s) => s.peak <= MAX_PX),
  `max ${Math.max(...strength.map((s) => s.peak)).toFixed(1)}px`,
);
check(
  "the scene sized each impact from the fall it actually animated",
  strength.every((s) => s.dz === null ? true : expectedPeak(s.dz) >= s.band[0] && expectedPeak(s.dz) <= s.band[1]),
  strength.map((s) => `${s.dz?.toFixed(1)}c→${expectedPeak(s.dz ?? 0).toFixed(1)}px (band ${s.band.join("–")})`).join(" · "),
);

  // ── Frame-rate independence ────────────────────────────────────────────
  // The envelope is defined in seconds, so throttling the CPU (fewer frames)
  // must not change how long the shake lasts — only how many frames show it.
  // `falling` in the match-ending scenario leaves no fall to size from.
  await page.evaluate(
    (p) => window.renderScene({ ...p, width: 420, height: 620, impact: 0 }),
    { tower, falling: falling(1) },
  );
  await page.waitForSelector(SHAKE_SEL);
  const cdp = await page.context().newCDPSession(page);
  const spanAt = async (rate) => {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    const run = await sampleRumble(page, { bumpTo: 900 + rate, from: 900 + rate - 1, ms: 400 });
    const moved = run.frames.filter((f) => size(f) > 0.5);
    const span = moved.length ? moved[moved.length - 1].ms - moved[0].ms : 0;
    const end = run.frames[run.frames.length - 1];
    return { span, home: end.tx === 0 && end.ty === 0, frames: moved.length };
  };
  const normalRate = await spanAt(1);
  const throttled = await spanAt(4);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  check(
    "the rumble is frame-rate independent (same ~110ms envelope when the CPU is 4× slower)",
    normalRate.home &&
      throttled.home &&
      normalRate.span >= 40 &&
      normalRate.span <= 200 &&
      throttled.span >= 40 &&
      throttled.span <= 200 &&
      Math.abs(normalRate.span - throttled.span) < 90,
    `1×: ${normalRate.span.toFixed(0)}ms/${normalRate.frames}f · 4×: ${throttled.span.toFixed(0)}ms/${throttled.frames}f`,
  );

  // ── The thud lands WITH the block ──────────────────────────────────────
  // Rather than assert the wiring in the source only, this mounts a real drop
  // with the harness relaying the landing exactly like the page does (signal →
  // impact token → shake) and times the thud against the block's own measured
  // landing. It also proves the landing is neither the 1200/1650ms teardown nor
  // something that fires for a fall that never reached the tower.
  await page.evaluate(
    (p) => window.renderScene({ ...p, width: 420, height: 620, impact: 0, relayImpact: true }),
    { tower, falling: falling(1) },
  );
  await page.waitForSelector(SHAKE_SEL);
  const landing = await page.evaluate(async (ms) => {
    const readTy = () => {
      const el = document.querySelector('[data-testid="ta-drop-block"]');
      if (!el) return { ty: null, mounted: false };
      const m = /matrix\(1, 0, 0, 1, 0, (-?[\d.]+)\)/.exec(getComputedStyle(el).transform || "");
      return { ty: m ? Number.parseFloat(m[1]) : 0, mounted: true };
    };
    const wrap = document.querySelector('[data-testid="ta-scene-shake"]');
    const shakeSize = () => {
      const m = /matrix\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(
        getComputedStyle(wrap).transform || "",
      );
      return m ? Math.hypot(Number.parseFloat(m[5]), Number.parseFloat(m[6])) : 0;
    };
    const frames = [];
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        frames.push({ ms: performance.now() - t0, ...readTy(), shake: shakeSize() });
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return { frames, landings: window.__landings.map((l) => ({ key: l.key, ms: l.t - t0 })) };
  }, 900);

  const lf = landing.frames;
  const gapsL = lf.slice(1).map((f, i) => f.ms - lf[i].ms).sort((a, b) => a - b);
  const frameMsL = gapsL[Math.floor(gapsL.length / 2)] || 16;
  const dropDz = Math.max(...lf.map((f) => Math.abs(f.ty ?? 0)));
  const expectedLanding = Math.min(0.9, 0.32 + dropDz * 0.035) * 1000;
  const landedFrame = lf.find((f) => f.ty !== null && Math.abs(f.ty) <= 0.05);
  const thud = landing.landings[0];
  check(
    "the impact fires when the block actually touches down (not on the teardown)",
    landing.landings.length === 1 &&
      Boolean(landedFrame) &&
      Math.abs(thud.ms - expectedLanding) <= Math.max(150, frameMsL * 3) &&
      thud.ms <= 1200 - 150 &&
      landedFrame.mounted,
    `drop ${dropDz.toFixed(1)}c → landed at ${landedFrame?.ms.toFixed(0)}ms, thud at ${thud?.ms.toFixed(0)}ms (expected ${expectedLanding.toFixed(0)}ms, teardown would be 1200ms), block still mounted`,
  );
  check(
    "the landing stamp is the drop's own key, and it drives the shake",
    thud?.key === 1 &&
      // 0.2px: the shake is only 110ms long, so the first frame that shows it
      // can be a whole (slow, headless) frame late — this asserts that the
      // relayed token really moved the scene, not how big that frame was.
      lf.some((f) => f.ms > thud.ms && f.shake > 0.2) &&
      // …and the scene is exactly home again afterwards.
      Math.abs(lf[lf.length - 1].shake) <= 0.05,
    `key=${thud?.key} peak after landing=${Math.max(...lf.filter((f) => f.ms > (thud?.ms ?? 0)).map((f) => f.shake)).toFixed(1)}px`,
  );

  // ── Stability: idle scene, layout, and small/large screens ─────────────
  // A settled scene (tower only, no drop in flight) must be perfectly still:
  // no wrapper transform, no drift of the rendered SVG, no document reflow and
  // no animation left running anywhere. Several frames of "nothing happened"
  // is the only honest way to prove an effect isn't quietly looping.
  await page.evaluate(
    (p) => window.renderScene({ ...p, width: 420, height: 620, impact: 0 }),
    { tower, falling: null },
  );
  await page.waitForSelector(SHAKE_SEL);
  const idle = await page.evaluate(async (ms) => {
    const snap = () => {
      const wrap = document.querySelector('[data-testid="ta-scene-shake"]');
      const m = /matrix\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(
        getComputedStyle(wrap).transform || "",
      );
      const r = document.querySelector("svg").getBoundingClientRect();
      return {
        tx: m ? Number.parseFloat(m[5]) : 0,
        ty: m ? Number.parseFloat(m[6]) : 0,
        box: `${r.left.toFixed(2)},${r.top.toFixed(2)},${r.width.toFixed(2)},${r.height.toFixed(2)}`,
        scroll: `${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}@${window.scrollY},${window.innerWidth}x${window.innerHeight}`,
      };
    };
    const before = snap();
    const frames = [];
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        frames.push(snap());
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return {
      before,
      after: frames[frames.length - 1],
      frames,
      running: document.getAnimations().filter((a) => a.playState === "running").length,
    };
  }, 620);

  check(
    "an idle match is completely still (no jitter, nothing animating)",
    idle.frames.every((f) => f.tx === 0 && f.ty === 0) && idle.running === 0,
    `${idle.frames.length} frames, every frame exactly at 0 · running animations=${idle.running}`,
  );
  check(
    "the effects never reflow the page (no layout shift, on any axis)",
    idle.after.box === idle.before.box && idle.after.scroll === idle.before.scroll,
    `svg ${idle.before.box} → ${idle.after.box} · document unchanged`,
  );

  // The same two facts, but measured across real impacts: a landing must not
  // move anything permanently, and the scene must be at rest afterwards.
  const afterImpacts = await page.evaluate(async () => {
    const snap = () => {
      const wrap = document.querySelector('[data-testid="ta-scene-shake"]');
      const m = /matrix\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(
        getComputedStyle(wrap).transform || "",
      );
      const r = document.querySelector("svg").getBoundingClientRect();
      return {
        tx: m ? Number.parseFloat(m[5]) : 0,
        ty: m ? Number.parseFloat(m[6]) : 0,
        box: `${r.left.toFixed(2)},${r.top.toFixed(2)},${r.width.toFixed(2)},${r.height.toFixed(2)}`,
        scroll: `${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}@${window.scrollY}`,
      };
    };
    const before = snap();
    for (let i = 1; i <= 3; i += 1) {
      window.updateScene({ impact: 700 + i });
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 250));
    return { before, after: snap() };
  });
  check(
    "repeated landings leave the layout exactly where it was",
    afterImpacts.after.box === afterImpacts.before.box &&
      afterImpacts.after.scroll === afterImpacts.before.scroll &&
      afterImpacts.after.tx === 0 &&
      afterImpacts.after.ty === 0,
    `svg ${afterImpacts.before.box} → ${afterImpacts.after.box} · at rest`,
  );

  // ── Smaller and larger screens ─────────────────────────────────────────
  // The effects are CSS/transform work on an SVG with a viewBox, so they must
  // behave identically on a phone-width touch layout and on a desktop one.
  const viewportResults = [];
  for (const vp of [
    { name: "mobile 390×844 (touch)", width: 390, height: 844, mobile: true },
    { name: "desktop 1440×900", width: 1440, height: 900, mobile: false },
  ]) {
    const vpPage = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.mobile,
      isMobile: vp.mobile,
    });
    vpPage.on("pageerror", (err) => console.log(`PAGE ERROR (${vp.name}):`, err.message));
    await vpPage.goto(base, { waitUntil: "networkidle" });
    await vpPage.waitForFunction(() => window.renderScene && window.updateScene);
    // Warm-up: the very first animation after load competes with bundle
    // compilation, so fire a throwaway drop first.
    await vpPage.evaluate(
      (p) => window.renderScene({ ...p, impact: 0 }),
      { tower, falling: falling(1), width: vp.width, height: Math.min(vp.height, 760) },
    );
    await vpPage.waitForSelector(SHAKE_SEL);
    await vpPage.waitForTimeout(300);
    await vpPage.evaluate(
      (p) => window.renderScene({ ...p, impact: 0, relayImpact: true }),
      { tower, falling: falling(1), width: vp.width, height: Math.min(vp.height, 760) },
    );
    await vpPage.waitForSelector(SHAKE_SEL);
    const run = await vpPage.evaluate(async (ms) => {
      const wrap = document.querySelector('[data-testid="ta-scene-shake"]');
      const read = () => {
        const m = /matrix\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(
          getComputedStyle(wrap).transform || "",
        );
        return m ? Math.hypot(Number.parseFloat(m[5]), Number.parseFloat(m[6])) : 0;
      };
      const svgRect = () => {
        const r = document.querySelector("svg").getBoundingClientRect();
        return `${r.left.toFixed(2)},${r.top.toFixed(2)},${r.width.toFixed(2)},${r.height.toFixed(2)}`;
      };
      const ghostsAtStart = document.querySelectorAll('[data-testid="ta-trail-ghost"]').length;
      const overflowBefore = document.documentElement.scrollWidth - window.innerWidth;
      const boxBefore = svgRect();
      const shakes = [];
      const t0 = performance.now();
      await new Promise((resolve) => {
        const tick = () => {
          shakes.push(read());
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      return {
        ghostsAtStart,
        peak: Math.max(...shakes),
        last: shakes[shakes.length - 1],
        overflowBefore,
        overflowAfter: document.documentElement.scrollWidth - window.innerWidth,
        boxBefore,
        boxAfter: svgRect(),
        landings: window.__landings.length,
      };
    }, 900);
    await vpPage.close();
    viewportResults.push({ ...vp, ...run });
  }

  check(
    "the effects work identically on a phone and a desktop layout",
    viewportResults.every(
      (v) => v.landings === 1 && v.peak > 0.5 && v.last <= 0.05 && v.ghostsAtStart === 3,
    ),
    viewportResults
      .map((v) => `${v.name}: thud=${v.landings} peak=${v.peak.toFixed(1)}px final=${v.last.toFixed(2)}px ghosts=${v.ghostsAtStart}`)
      .join(" · "),
  );
  check(
    "neither layout gains a scrollbar or moves its scene when a block lands",
    viewportResults.every(
      (v) => v.overflowBefore <= 1 && v.overflowAfter <= 1 && v.boxBefore === v.boxAfter,
    ),
    viewportResults
      .map((v) => `${v.name}: h-overflow ${v.overflowBefore}→${v.overflowAfter}px, scene ${v.boxBefore}→${v.boxAfter}`)
      .join(" · "),
  );

  // A drop cancelled before it lands must NOT thud (and must leave no timer).
  await page.evaluate(
    (p) => window.renderScene({ ...p, width: 420, height: 620, impact: 0, relayImpact: true }),
    { tower, falling: falling(1) },
  );
  await page.waitForSelector(SHAKE_SEL);
  await page.evaluate(() => window.updateScene({ falling: null }));
  await page.waitForTimeout(750);
  const cancelled = await page.evaluate(() => window.__landings.length);
  check(
    "a fall that never reaches the tower never thuds (and leaves no timer behind)",
    cancelled === 0,
    `landings=${cancelled} after the drop was cleared mid-air`,
  );

  await browser.close();
} finally {
  server.close();
}  // ── Source wiring ──────────────────────────────────────────────────────
check(
  "the impact token is the only trigger, and it is consumed as a token (not a boolean)",
  /const shake = useAnimationControls\(\)/.test(pageSrc) &&
    /\bimpact === shakenFor\.current\b/.test(pageSrc) &&
    /\bshake\.start\(impactShake\(impact, impactAmplitude\(lastDropDz\.current\)\)\)/.test(pageSrc) &&
    !/animate=\{\{\s*x:\s*impact/.test(pageSrc),
  "",
);
check(
  "the rumble is applied to the scene wrapper, and the old fixed shake is gone",
  /data-testid="ta-scene-shake"[\s\S]{0,400}?animate=\{shake\}/.test(pageSrc) &&
    !/\[0, -3, 3, -2, 2, 0\]/.test(pageSrc) &&
    (pageSrc.match(/<motion\.div[\s\S]{0,400}?animate=\{shake\}/g) || []).length === 1,
  "",
);
// The thud is fired by the DROP'S OWN landing, never by the page's teardown
// timer. The block touches down at `fallSeconds` (≈0.3–0.9s) while the falling
// block is deliberately held on screen for 1200/1650ms, so a bump from the
// teardown would land the impact up to ~0.8s after contact.
check(
  "the impact is fired by the landing itself — the teardown timers don't bump it",
  (pageSrc.match(/setImpactKey\(\(k\) => k \+ 1\)/g) || []).length === 1 &&
    /onDropLanded=\{\(\) => setImpactKey\(\(k\) => k \+ 1\)\}/.test(pageSrc) &&
    // No bump anywhere inside a timer callback: both drop paths keep their
    // 1200/1650ms timers purely for tearing the drop down.
    (pageSrc.match(/window\.setTimeout\(\(\) => \{[\s\S]{0,400}?setImpactKey/g) || []).length === 0 &&
    (pageSrc.match(/willFall \? 1650 : 1200/g) || []).length === 2,
  `bump sites=${(pageSrc.match(/setImpactKey\(\(k\) => k \+ 1\)/g) || []).length}, teardowns=${(pageSrc.match(/willFall \? 1650 : 1200/g) || []).length}`,
);
check(
  "the landing signal is the same duration the block itself animates",
  /window\.setTimeout\(\(\) => onDropLandedRef\.current\?\.\(key\), fallSeconds \* 1000\)/.test(pageSrc) &&
    // The drop group's x and y are animated over exactly that same value…
    (pageSrc.match(/duration: fallSeconds, ease: "easeIn"/g) || []).length >= 2 &&
    // …is cancelled when the drop goes away (replaced mid-air, cleared, unmount),
    // and is called through a ref so a page re-render can't restart it late.
    /return \(\) => window\.clearTimeout\(timer\);/.test(pageSrc) &&
    /onDropLandedRef\.current = onDropLanded;/.test(pageSrc),
  "one shared value: fallSeconds",
);
const shakeBlock = pageSrc.slice(
  pageSrc.indexOf("function impactShake"),
  pageSrc.indexOf("const SKY_DUST"),
);
check(
  "every shake ends exactly at 0 and no new animation library was added",
  /x\[x\.length - 1\] = 0;/.test(shakeBlock) &&
    /y\[y\.length - 1\] = 0;/.test(shakeBlock) &&
    !/framer-motion\/dom|gsap|animejs|motion\/react/.test(pageSrc),
  "",
);
check(
  "reduced motion is honoured before the shake starts",
  /if \(reduceMotion\) return; \/\/ preference honoured/.test(pageSrc),
  "",
);

// ── The shake's SHAPE and its fall scaling, from the component's own numbers ──
// Frame-level sampling can't be trusted to catch a ~110ms envelope on a busy
// headless main thread (frames land ~30ms apart), so the punch, the decay, the
// bounds and the strength mapping are asserted on the keyframes themselves — in
// user pixels, with the maximum jitter applied, the worst case the browser can
// ever see.
check(
  "each fall height lands in its intended band (short 3–5px, medium 6–9px, long 10–15px)",
  Boolean(mags) &&
    expectedPeak(minFall) >= 3 &&
    expectedPeak(minFall) <= 5 &&
    expectedPeak(6.5) >= 6 &&
    expectedPeak(6.5) <= 9 &&
    expectedPeak(fallRef) >= 10 &&
    expectedPeak(fallRef) <= 15,
  `${minFall}c→${expectedPeak(minFall).toFixed(1)}px · 6.5c→${expectedPeak(6.5).toFixed(1)}px · ${fallRef}c→${expectedPeak(fallRef).toFixed(1)}px`,
);
check(
  "the strength rises with the fall and clamps at both ends (never absurd)",
  Boolean(mags) &&
    expectedPeak(0) === expectedPeak(minFall) &&
    Array.from({ length: 12 }, (_, i) => expectedPeak(i + minFall)).every(
      (peak, i, arr) => i === 0 || peak >= arr[i - 1],
    ) &&
    expectedPeak(999) === expectedPeak(fallRef) &&
    expectedPeak(999) <= MAX_PX,
  `fall ${minFall}c→${expectedPeak(minFall).toFixed(1)}px … ${fallRef}c+→${expectedPeak(999).toFixed(1)}px`,
);
check(
  "the envelope is defined in seconds, not frames (frame-rate independent)",
  duration >= 0.08 &&
    duration <= 0.14 &&
    keyTimes.length === mags.length &&
    keyTimes[0] === 0 &&
    keyTimes[keyTimes.length - 1] === 1 &&
    /transition: \{\s*duration: SHAKE_DURATION,\s*times: SHAKE_TIMES/.test(pageSrc),
  `${duration * 1000}ms, times 0→1 in ${keyTimes.length} steps`,
);

check(
  "the punch is the first move and lands within ~15ms (BAM, then settle)",
  Boolean(steps) &&
    mags[0] === 0 &&
    mags[1] === Math.max(...mags) &&
    keyTimes.length === mags.length &&
    keyTimes[1] * duration <= 0.02,
  `punch ${mags[1]?.toFixed(1)}px at ${(keyTimes[1] * duration * 1000).toFixed(0)}ms`,
);
check(
  "the shake decays monotonically to exactly 0 (progressive settle, always home)",
  Boolean(mags) &&
    mags.slice(1).every((m, i) => i === mags.length - 2 ? m === 0 : m > mags[i + 2]) &&
    mags[mags.length - 1] === 0 &&
    // Even at opposite ends of the jitter band the decay must hold.
    mags[1] * jitterMin > mags[2] * jitterMax,
  `step magnitudes ${mags?.map((m) => m.toFixed(1)).join(" → ")}px`,
);
const swings = steps ? steps.slice(1, -1) : []; // the punch plus every decay step
check(
  "the jolt is irregular (alternating X, mixed X/Y signs, not a diagonal slide)",
  Boolean(steps) &&
    swings.reduce((n, s, i) => (i > 0 && Math.sign(s.x) !== Math.sign(swings[i - 1].x) ? n + 1 : n), 0) >= 3 &&
    swings.some((s) => Math.sign(s.x) === Math.sign(s.y)) &&
    swings.some((s) => Math.sign(s.x) !== Math.sign(s.y)),
  JSON.stringify(swings.map((s) => `${s.x.toFixed(1)}/${s.y.toFixed(1)}`)),
);
// The bound is the project's stated ~15px ceiling, not the old fixed 12px
// amplitude — strength now scales up to SHAKE_MAX_AMPLITUDE, so the punch can
// legitimately exceed the old constant as long as it stays inside the ceiling.
check(
  "the punch stays subtle and bounded at maximum jitter",
  Boolean(steps) &&
    duration >= 0.08 &&
    duration <= 0.14 &&
    steps.every((s) => Math.abs(s.x) <= MAX_PX && Math.abs(s.y) <= MAX_PX) &&
    Math.max(...mags) <= MAX_PX,
  `peak ${Math.max(...mags).toFixed(1)}px vector · ${duration * 1000}ms · per-axis max ${Math.max(...steps?.map((s) => Math.max(Math.abs(s.x), Math.abs(s.y))) ?? []).toFixed(1)}px`,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
