// qa/ta-trail-check.mjs
//
// Browser check for Tower Arena's falling-block motion trail. Mounts the REAL
// TowerScene (qa/ta-trail-harness.jsx, exported from the match page) and
// measures the actual animation frame by frame in Chromium, asserting:
//
//   1. A drop renders exactly 3 trail ghosts behind the block, same cell count
//      (so the ghosts are the block's own shape, not a stand-in).
//   2. The BLOCK's own fall is untouched: it starts `dropDz` user units up,
//      travels that distance, lands at its spot within `fallSeconds`.
//   3. The ghosts LAG the block on the same path, in order (block furthest
//      along, then trail 1, 2, 3).
//   4. The lag GROWS as the block speeds up (strong during the fast part of
//      the fall, barely there at the start) — the whole point of the effect.
//   5. The ghosts are transparent again by the time the drop lands, and the
//      opacities are the faded frames of the block (0.48 / 0.28 / 0.12).
//   6. Clearing `falling` removes every ghost (nothing left in the tower).
//   7. A doomed (ceiling-breaching) drop trails in the block's red and leaves
//      nothing behind either.
//   8. `prefers-reduced-motion` drops the trail but keeps the fall.
//   9. The same scene at two very different container sizes produces the same
//      user-unit motion (the trail is resolution-independent).
//  10. Source wiring: the ghosts are rendered INSIDE the `falling` gate, walk
//      `falling.cells`, and add no state or timers; the local drop and the
//      remote/bot drop feed the SAME falling payload.
//
// Run: node qa/ta-trail-check.mjs

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

// ── Expectations mirrored from the scene's own constants ────────────────
const TRAIL_OPACITIES = [0.48, 0.28, 0.12];
const SHAPE_FILL = { I: "#00e5ff", long: "#7cf29c", big: "#ff9f43" };
const DOOMED_FILL = "#ff4d6d";
const GHOST_SEL = '[data-testid="ta-trail-ghost"]';
const BLOCK_SEL = '[data-testid="ta-drop-block"]';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

// ── 1. Bundle the harness + the real scene. The page's non-visual imports
//    (routing, analytics, socket, creator mode, footer, audio, big lobby
//    component) are stubbed: the scene only needs framer-motion + engine math.
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

const outDir = mkdtempSync(join(tmpdir(), "ta-trail-"));
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
          build.onLoad({ filter: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }, () => ({
            contents: stub.source,
            loader: "js",
            resolveDir: root,
          }));
        }
      },
    },
  ],
});
const harnessJs = readFileSync(bundleOut, "utf8");

const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Tower Arena trail check</title>
<style>
  body { margin: 0; background: #05070f }
  /* The two Tailwind utilities the stage actually relies on for sizing, so the
     harness renders the scene at a real pixel size (the point of the
     resolution-independence check). Everything else in the scene is SVG. */
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

// ── Scenario payloads. Cells are the server-resolved landing cells; the scene
//    derives everything else (spawn height, duration) from them.
const tower = [{ id: "b0", shape: "short", cells: [{ x: 0, depth: 0, z: 0 }], turnNumber: 1 }];
const floorCells = (shape, z = 1) => {
  const widths = { I: 3, long: 4, big: 3 };
  return Array.from({ length: widths[shape] ?? 1 }, (_, i) => ({ x: 6 + i, depth: 0, z }));
};
const fallingFor = ({ shape = "I", key = 1, willFall = false, cells, extra = [] }) => ({
  cells: cells ?? floorCells(shape),
  extra,
  willFall,
  slideDx: 0,
  key,
  shape,
});

// Sample the drop for `durationMs`, reading the group transforms (user units)
// and opacities on every animation frame.
async function sampleDrop(page, durationMs) {
  return page.evaluate(async (ms) => {
    const read = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const m = /matrix\(1, 0, 0, 1, 0, (-?[\d.]+)\)/.exec(cs.transform || "");
      return { ty: m ? parseFloat(m[1]) : 0, opacity: parseFloat(cs.opacity) };
    };
    const frames = [];
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const block = document.querySelector('[data-testid="ta-drop-block"]');
        const ghosts = [...document.querySelectorAll('[data-testid="ta-trail-ghost"]')];
        frames.push({
          ms: performance.now() - t0,
          block: read(block),
          ghosts: ghosts.map(read),
        });
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });

    const block = document.querySelector('[data-testid="ta-drop-block"]');
    const ghosts = [...document.querySelectorAll('[data-testid="ta-trail-ghost"]')];
    const rectsOf = (el) => el.querySelectorAll("rect").length;
    const svg = document.querySelector("svg");
    return {
      frames,
      ghostCount: ghosts.length,
      ghostRects: ghosts.map(rectsOf),
      blockRects: block ? rectsOf(block) : 0,
      ghostFill: ghosts.map((g) => g.querySelector("rect")?.getAttribute("fill") ?? null),
      blockFill: block ? block.querySelector("rect")?.getAttribute("fill") ?? null : null,
      // The drop block is pure SVG (no images): a ghost can only be pixels.
      images: svg ? svg.querySelectorAll("image").length : 0,
      svgPx: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
    };
  }, durationMs);
}

const render = async (page, props) => {
  await page.evaluate((p) => window.renderScene(p), props);
  await page.waitForFunction((sel) => document.querySelector(sel), BLOCK_SEL);
};

// The block's progress along the fall: ty runs from -dropDz (sky) → 0 (landed).
const blockAt = (frames, when) => frames.reduce((a, b) => (Math.abs(b.ms - when) < Math.abs(a.ms - when) ? b : a));
const landedFrame = (frames) =>
  frames.filter((f) => f.block).reduce((a, b) => (Math.abs(b.block.ty) < Math.abs(a.block.ty) ? b : a));

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.renderScene);

  // ── A stable drop (the common case) ────────────────────────────────────
  await render(page, { tower, falling: fallingFor({ shape: "I" }), width: 420, height: 620 });
  const drop = await sampleDrop(page, 1250);

  const dropDz = Math.abs(drop.frames[0].block.ty);
  const landed = landedFrame(drop.frames);
  const travel = Math.abs(landed.block.ty) - drop.frames[0].block.ty;

  check(
    "a drop renders exactly 3 trail ghosts behind the block",
    drop.ghostCount === 3,
    `ghosts=${drop.ghostCount}`,
  );
  check(
    "each ghost is the block's own shape (same cell count), block included",
    drop.ghostRects.length === 3 &&
      drop.ghostRects.every((n) => n === drop.blockRects) &&
      drop.blockRects > 0,
    `ghost cells=${drop.ghostRects.map((n) => n / 3).join(",")} block rects=${drop.blockRects}`,
  );
  check(
    "ghosts wear the block's own colors (faded copy, not a new style)",
    drop.ghostFill.every((f) => f === drop.blockFill) && drop.blockFill === SHAPE_FILL.I,
    `ghost=${JSON.stringify(drop.ghostFill)} block=${drop.blockFill}`,
  );
  check(
    "the block's own fall is unchanged (spawn → travel → land)",
    Math.abs(dropDz - 10) < 0.5 && Math.abs(travel - dropDz) < 1 && Math.abs(landed.block.ty) < 1,
    `dropDz=${dropDz.toFixed(2)} travel=${travel.toFixed(2)} landed ty=${landed.block.ty.toFixed(2)} at ${Math.round(landed.ms)}ms`,
  );

  // Ghosts hold still with the block, in order, on the same path.
  const fastest = drop.frames.reduce((a, b) => {
    if (!b.block || b.ghosts.length < 3) return a;
    if (!a.block || a.ghosts.length < 3) return b;
    return b.block.ty - b.ghosts[0].ty > a.block.ty - a.ghosts[0].ty ? b : a;
  });
  const order = [fastest.block.ty, ...fastest.ghosts.map((g) => g.ty)];
  check(
    "the ghosts trail the block in order (block furthest, then 1→2→3)",
    fastest.ghosts.length === 3 &&
      order[0] > order[1] && order[1] > order[2] && order[2] > order[3],
    `ty block=${order[0].toFixed(2)} ghosts=${order.slice(1).map((t) => t.toFixed(2)).join(" → ")}`,
  );

  const gapAt = (frame) => (frame?.block && frame.ghosts[0] ? frame.block.ty - frame.ghosts[0].ty : null);
  const early = blockAt(drop.frames, 130);
  const late = blockAt(drop.frames, 620);
  const earlyGap = gapAt(early);
  const lateGap = gapAt(late);
  check(
    "the trail is strongest while the block is moving fastest",
    earlyGap !== null && lateGap !== null && lateGap > earlyGap * 1.5 && lateGap > 0.3,
    `gap@130ms=${earlyGap?.toFixed(2)} gap@620ms=${lateGap?.toFixed(2)} user units`,
  );
  check(
    "the ghosts overlap the block early on (no visible second animation)",
    earlyGap !== null && earlyGap < 0.6,
    `gap=${earlyGap?.toFixed(2)} user units`,
  );

  const afterLanding = drop.frames[drop.frames.length - 1];
  const ghostOpacityAfter = afterLanding.ghosts.map((g) => g.opacity);
  check(
    "every ghost has faded out by the time the drop lands (nothing left behind)",
    ghostOpacityAfter.length === 3 &&
      ghostOpacityAfter.every((o) => o <= 0.05) &&
      afterLanding.block !== null,
    `ghost opacity=${JSON.stringify(ghostOpacityAfter)} block opacity=${afterLanding.block?.opacity.toFixed(2)}`,
  );
  check(
    "the trail is pure SVG (no images/text added by the effect)",
    drop.images === 0,
    `images=${drop.images}`,
  );

  // ── Clearing the drop removes every ghost ──────────────────────────────
  await page.evaluate(() => window.renderScene({ tower: [], falling: null }));
  await page.waitForTimeout(120);
  const cleared = await page.evaluate(
    (sels) => ({
      ghosts: document.querySelectorAll(sels.ghost).length,
      block: document.querySelectorAll(sels.block).length,
    }),
    { ghost: GHOST_SEL, block: BLOCK_SEL },
  );
  check(
    "removing the falling block removes every ghost (no permanent trail)",
    cleared.ghosts === 0 && cleared.block === 0,
    JSON.stringify(cleared),
  );

  // ── A resting tower carries no ghosting at all ─────────────────────────
  // The trail must only ever exist while a block is in flight: no ghost on a
  // stationary tower block, and no faded copy left behind anywhere.
  // (not `render()`: there is no drop to wait for)
  await page.evaluate((p) => window.renderScene(p), { tower, falling: null, width: 420, height: 620 });
  await page.waitForTimeout(150);
  const resting = await page.evaluate((ghostSel) => {
    const groups = [...document.querySelectorAll("svg g")];
    const faded = groups.filter((g) => Number.parseFloat(getComputedStyle(g).opacity) < 0.99);
    return {
      ghosts: document.querySelectorAll(ghostSel).length,
      blocks: groups.length,
      faded: faded.length,
    };
  }, GHOST_SEL);
  check(
    "a resting tower has no ghost on it (tower blocks stay fully opaque)",
    resting.ghosts === 0 && resting.blocks > 0 && resting.faded === 0,
    `${resting.blocks} tower groups, ${resting.faded} faded, ${resting.ghosts} ghosts`,
  );

  // ── The block stays crisp; the ghosts are the faded copies ─────────────
  // Measured across the middle of the fall rather than at one fixed instant:
  // the block's own opacity ramps 0.95 → 1 over its first 120ms, and a starved
  // first frame can still be showing the initial value at 300ms on a busy
  // headless main thread. What must hold mid-fall is that the block is always
  // crisper than every ghost, that it does reach full opacity, and that the
  // ghosts fade in strict newest → oldest order.
  const midFrames = drop.frames.filter(
    (f) => f.ms >= 250 && f.ms <= 620 && f.block && f.ghosts.length === 3,
  );
  const opaqueFrame = midFrames.find((f) => f.block.opacity === 1);
  const midGhosts = (opaqueFrame?.ghosts || []).map((g) => g.opacity);
  check(
    "the block itself stays crisp and fully opaque, with the ghosts faded behind it",
    midFrames.length >= 3 &&
      midFrames.every((f) => f.block.opacity >= 0.95 && f.ghosts.every((g) => g.opacity < f.block.opacity)) &&
      Boolean(opaqueFrame) &&
      midGhosts.every((o) => o > 0.05 && o < 1) &&
      midGhosts.every((o, i) => i === 0 || midGhosts[i - 1] > o),
    `${midFrames.length} mid-fall frames · block opacity=${opaqueFrame?.block.opacity} · ghost opacities=${JSON.stringify(midGhosts)}`,
  );

  // ── A bot/remote drop runs through the very same path ──────────────────
  await render(page, { tower, falling: fallingFor({ shape: "long", key: 7 }), width: 420, height: 620 });
  const botDrop = await sampleDrop(page, 1250);
  const botLanded = landedFrame(botDrop.frames);
  check(
    "a remote (bot) drop animates identically and trails in the bot's shape colors",
    botDrop.ghostCount === 3 &&
      botDrop.ghostFill.every((f) => f === SHAPE_FILL.long) &&
      Math.abs(Math.abs(botLanded.block.ty)) < 1 &&
      Math.abs(Math.abs(botDrop.frames[0].block.ty) - 10) < 0.5,
    `fill=${JSON.stringify(botDrop.ghostFill)} landed=${botLanded.block.ty.toFixed(2)}`,
  );

  // ── A doomed drop trails in red and also leaves nothing behind ─────────
  await render(page, { tower, falling: fallingFor({ shape: "big", key: 9, willFall: true }), width: 420, height: 620 });
  const doomed = await sampleDrop(page, 1500);
  const doomedEnd = doomed.frames[doomed.frames.length - 1];
  check(
    "a ceiling-breaching drop trails red and fades out with the block",
    doomed.ghostCount === 3 &&
      doomed.ghostFill.every((f) => f === DOOMED_FILL) &&
      doomedEnd.ghosts.every((g) => g.opacity <= 0.05) &&
      (doomedEnd.block === null || doomedEnd.block.opacity <= 0.05),
    `fill=${JSON.stringify(doomed.ghostFill)} end ghost=${JSON.stringify(doomedEnd.ghosts.map((g) => g.opacity))} block=${doomedEnd.block?.opacity}`,
  );

  // ── Reduced motion keeps the drop, drops the trail ─────────────────────
  // A dedicated page with the preference set BEFORE load: framer-motion reads
  // it once per mount, and that is exactly how a reduced-motion visitor
  // arrives at the game.
  const rmPage = await browser.newPage({
    viewport: { width: 900, height: 900 },
    reducedMotion: "reduce",
  });
  await rmPage.goto(base, { waitUntil: "networkidle" });
  await rmPage.waitForFunction(() => window.renderScene);
  await render(rmPage, { tower, falling: fallingFor({ shape: "I", key: 11 }), width: 420, height: 620 });
  const reduced = await sampleDrop(rmPage, 900);
  const reducedLanded = landedFrame(reduced.frames);
  check(
    "prefers-reduced-motion: no trail, but the block still falls",
    reduced.ghostCount === 0 && Math.abs(reducedLanded.block.ty) < 1,
    `ghosts=${reduced.ghostCount} landed=${reducedLanded.block.ty.toFixed(2)}`,
  );
  await rmPage.close();

  // ── Resolution independence: same user-unit motion at any container size ─
  await render(page, { tower, falling: fallingFor({ shape: "I", key: 21 }), width: 300, height: 520 });
  const narrow = await sampleDrop(page, 1250);
  await render(page, { tower, falling: fallingFor({ shape: "I", key: 22 }), width: 1000, height: 900 });
  const wide = await sampleDrop(page, 1250);
  const maxLag = (run) =>
    run.frames.reduce((a, f) => {
      if (!f.block || f.ghosts.length < 3) return a;
      return Math.max(a, f.block.ty - f.ghosts[2].ty);
    }, 0);
  check(
    "the same trail math holds at very different stage sizes (user units)",
    narrow.svgPx !== wide.svgPx &&
      Math.abs(narrow.svgPx - 300) < 2 &&
      Math.abs(wide.svgPx - 1000) < 2 &&
      Math.abs(maxLag(narrow) - maxLag(wide)) < 0.2 &&
      maxLag(narrow) > 0.3,
    `stage px ${narrow.svgPx} vs ${wide.svgPx} · trail lag ${maxLag(narrow).toFixed(2)} vs ${maxLag(wide).toFixed(2)} user units`,
  );

  await browser.close();
} finally {
  server.close();
}

// ── Source wiring (the behaviour above can't see inside the component) ───
const frames = [...pageSrc.matchAll(/\{ delay: ([\d.]+), opacity: ([\d.]+) \}/g)].map((m) => ({
  delay: +m[1],
  opacity: +m[2],
}));
check(
  "the trail is exactly 3 frames with the specified opacities",
  frames.length === 3 &&
    frames.every((f, i) => Math.abs(f.opacity - TRAIL_OPACITIES[i]) < 0.001) &&
    frames[0].opacity > frames[1].opacity &&
    frames[1].opacity > frames[2].opacity,
  JSON.stringify(frames),
);

const fallingGate = pageSrc.indexOf("{falling && (");
const ghostIdx = pageSrc.indexOf('data-testid="ta-trail-ghost"');
const blockIdx = pageSrc.indexOf('data-testid="ta-drop-block"');
check(
  "the ghosts render inside the `falling` gate, before the block",
  fallingGate > -1 && ghostIdx > fallingGate && blockIdx > ghostIdx,
  `gate=${fallingGate} ghosts=${ghostIdx} block=${blockIdx}`,
);

const trailBlock = pageSrc.slice(pageSrc.indexOf("{/* Motion trail"), blockIdx);
check(
  "ghosts walk the falling block's own cells, with no state and no timers",
  trailBlock.includes("falling.cells") &&
    !/useState|useEffect|setTimeout|setInterval/.test(trailBlock) &&
    trailBlock.includes("dropDz") &&
    trailBlock.includes("fallSeconds"),
  `len=${trailBlock.length}`,
);

// Both the local drop and the authoritative/remote (bot) path must feed the
// same payload, or one of them would animate without a trail.
const FALLING_FIELDS = ["cells", "extra", "willFall", "slideDx", "key", "shape"];
const payloadSets = [...pageSrc.matchAll(/setFallingBlock\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]);
const setsEveryField = (body) =>
  FALLING_FIELDS.every((field) => new RegExp(`\\b${field}\\s*[:,]`).test(body));
check(
  "the local drop and the remote/bot drop feed the same falling payload",
  payloadSets.length === 2 && payloadSets.every(setsEveryField),
  `call sites=${payloadSets.length} fields=${JSON.stringify(payloadSets.map((b) => FALLING_FIELDS.filter((f) => new RegExp(`\\b${f}\\s*[:,]`).test(b)).length))}`,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
