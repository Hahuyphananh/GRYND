// qa/ta-block-art-check.mjs
//
// Browser check for Tower Arena's cartoon-2D block art — the single renderer
// shared by the tower and the picker (src/components/tower-arena/BlockArt.tsx).
//
// It mounts the REAL TowerScene (one block of every shape) and the REAL
// BlockGlyph in all three picker states, at 320 / 360 / 390 / 1280 px, and
// asserts:
//
//   1. Every cell paints the three values of its shape's palette — base,
//      highlight, shadow — in strict luminance order, plus the one shared dark
//      outline. The base hexes are unchanged from the shipped seven-colour map.
//   2. The artwork stays inside the SVG viewBox (no clipped silhouette), and
//      the stage fits its container at every width with no page overflow.
//   3. The stage's hit area still covers the whole board: a click anywhere on
//      it reaches the scene's onStageClick (the real drop handler) exactly once.
//   4. The picker icon is the SAME drawing: its base/highlight/shadow equal the
//      board's for that shape, its cell count equals the real footprint, and its
//      aspect ratio equals the footprint's.
//   5. available / selected / unavailable are distinguishable: available is the
//      plain art, selected carries the shared yellow keyline, unavailable is
//      dimmed and desaturated.
//   6. Source wiring: both the scene and the picker import the one module, and
//      the old duplicated renderer is gone.
//
// Run: node qa/ta-block-art-check.mjs

import { chromium } from "playwright";
import esbuild from "esbuild";
import sharp from "sharp";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports", "tower-arena-art");
mkdirSync(REPORTS, { recursive: true });

const PAGE_FILE = "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx";
const ART_FILE = "src/components/tower-arena/BlockArt.tsx";
const pageSrc = readFileSync(join(root, PAGE_FILE), "utf8");
const artSrc = readFileSync(join(root, ART_FILE), "utf8");

const SHIPPED_BASES = {
  short: "#a5f3fc",
  square: "#f5ff3b",
  I: "#00e5ff",
  L: "#ff5c8a",
  T: "#a78bfa",
  long: "#7cf29c",
  big: "#ff9f43",
};
const WIDTHS = [320, 360, 390, 1280];

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

// ── Bundle the harness + the real scene (same stubs as the trail check) ───
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
  { match: /components\/GameSessionHost$/, source: `export default function GameSessionHost() { return null; }` },
  { match: /components\/game\/MatchLoading$/, source: `export default function MatchLoading() { return null; }` },
  { match: /components\/FrameAvatar$/, source: `export default function FrameAvatar() { return null; }` },
  { match: /components\/result\/PvpResultScreen$/, source: `export default function PvpResultScreen() { return null; }` },
  { match: /hooks\/useMatchSync$/, source: `export const useMatchSync = () => {};` },
  { match: /hooks\/useDeadlineRead$/, source: `export const useDeadlineRead = () => {};` },
  { match: /hooks\/useServerClockEstimate$/, source: `export const useServerClockEstimate = () => ({ offsetMs: 0, nowMs: 0, serverNow: () => Date.now() });` },
  { match: /lib\/deadlineRead$/, source: `export const towerArenaDueRead = () => false;` },
  { match: /context\/SocketProvider$/, source: `export const useSocket = () => ({ socket: null });` },
  { match: /lib\/gameAudio$/, source: `export const playTurnSwitch = () => {};\nexport const playCrash = () => {};\nexport const playTick = () => {};\nexport const playVictory = () => {};\nexport const playDefeat = () => {};` },
];

const outDir = mkdtempSync(join(tmpdir(), "ta-block-art-"));
const bundleOut = join(outDir, "harness.js");
await esbuild.build({
  entryPoints: [join(root, "qa/ta-block-art-harness.jsx")],
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
<html><head><meta charset="utf-8"><title>Tower Arena block art</title>
<style>
  body { margin: 0; background: #05070f; color: #fff; font: 12px system-ui }
  .h-full { height: 100% }
  .w-full { width: 100% }
  .cursor-pointer { cursor: pointer }
  .select-none { user-select: none }
  .touch-none { touch-action: none }
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

/**
 * Read the rendered art out of the page: every tower cell, every glyph state,
 * the stage fit and the resolved colours. Runs in the browser so it can use
 * getComputedStyle (the outline is a CSS-variable fill) and the module's own
 * exported palette.
 */
const measure = (page) =>
  page.evaluate(() => {
    const luminance = (rgb) => {
      const [r, g, b] = (rgb.match(/[\d.]+/g) || []).slice(0, 3).map(Number).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const attrsOf = (g) =>
      [...g.querySelectorAll(":scope > rect")].map((r) => ({
        fill: r.getAttribute("fill"),
        opacity: r.getAttribute("opacity"),
        stroke: r.getAttribute("stroke"),
        strokeWidth: getComputedStyle(r).strokeWidth,
        computedStroke: getComputedStyle(r).stroke,
        bbox: r.getBBox(),
        box: r.getBoundingClientRect(),
      }));

    const stage = document.getElementById("stage");
    const svg = stage.querySelector("svg");
    const sRect = svg.getBoundingClientRect();
    const viewBox = { x: svg.viewBox.baseVal.x, y: svg.viewBox.baseVal.y, w: svg.viewBox.baseVal.width, h: svg.viewBox.baseVal.height };
    const palette = window.__palette;
    const baseMap = new Map(Object.entries(palette).map(([shape, p]) => [p.base, { shape, ...p }]));

    const towerCells = [...svg.querySelectorAll('g[data-block-state="solid"]')].map((g) => {
      const rects = attrsOf(g);
      return {
        rects,
        base: rects[0]?.fill,
        baseLum: rects[0] ? luminance(getComputedStyle(g.querySelectorAll(":scope > rect")[0]).fill) : null,
        highlightLum: rects[1] ? luminance(getComputedStyle(g.querySelectorAll(":scope > rect")[1]).fill) : null,
        shadowLum: rects[2] ? luminance(getComputedStyle(g.querySelectorAll(":scope > rect")[2]).fill) : null,
      };
    });

    const glyphs = {};
    for (const shape of window.__shapes) {
      glyphs[shape] = {};
      for (const state of ["available", "selected", "unavailable"]) {
        const host = document.querySelector(`[data-glyph-state="${shape}:${state}"]`);
        const gsvg = host.querySelector("svg");
        const groups = [...gsvg.querySelectorAll("g[data-block-state]")];
        const rects = groups[0] ? attrsOf(groups[0]) : [];
        glyphs[shape][state] = {
          width: +gsvg.getBoundingClientRect().width.toFixed(2),
          height: +gsvg.getBoundingClientRect().height.toFixed(2),
          cells: groups.length,
          rectsPerCell: groups.map((g) => g.querySelectorAll(":scope > rect").length),
          stateAttr: groups[0]?.getAttribute("data-block-state") ?? null,
          groupOpacity: groups[0] ? +getComputedStyle(groups[0]).opacity : null,
          filter: groups[0] ? getComputedStyle(groups[0]).filter : null,
          base: rects[0]?.fill ?? null,
          highlight: rects[1]?.fill ?? null,
          shadow: rects[2]?.fill ?? null,
          outline: rects[3]?.computedStroke ?? null,
          outlineWidth: rects[3] ? +parseFloat(rects[3].strokeWidth) : null,
          keyline: rects[4]?.stroke ?? null,
        };
      }
    }

    return {
      stage: {
        width: +sRect.width.toFixed(2),
        height: +sRect.height.toFixed(2),
        clientWidth: stage.clientWidth,
        clientHeight: stage.clientHeight,
        className: svg.getAttribute("class") || "",
        viewBox,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      },
      towerCells,
      glyphs,
      palette,
      baseMapKeys: [...baseMap.keys()],
    };
  });

try {
  const browser = await chromium.launch();
  const seenShapes = new Set();
  let allWidthsOk = true;

  for (const width of WIDTHS) {
    const height = width >= 1280 ? 520 : 380;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.renderArt);
    await page.evaluate(({ w, h }) => window.renderArt({ width: w, height: h }), { w: width, h: height });
    await page.waitForSelector("#stage svg");
    await page.waitForTimeout(120);

    const m = await measure(page);

    // ── Palette: the shipped seven base colours, unchanged ────────────────
    if (width === WIDTHS[0]) {
      const bases = Object.fromEntries(Object.entries(m.palette).map(([k, v]) => [k, v.base]));
      check(
        "the seven-colour shape map is preserved (same base hex per shape)",
        JSON.stringify(bases) === JSON.stringify(SHIPPED_BASES),
        JSON.stringify(bases),
      );
      check(
        "every shape has three distinct values (base / highlight / shadow)",
        Object.values(m.palette).every(
          (p) => new Set([p.base, p.highlight, p.shadow]).size === 3,
        ),
        Object.entries(m.palette).map(([k, p]) => `${k}:${p.base}/${p.highlight}/${p.shadow}`).join(" "),
      );
    }

    // ── Every tower cell: three values in order + the one dark outline ─────
    const badCells = m.towerCells.filter((c) => {
      if (c.rects.length !== 4) return true;
      const entry = m.baseMapKeys.includes(c.base) &&
        Object.values(m.palette).find((p) => p.base === c.base);
      if (!entry) return true;
      const [base, hi, sh, outline] = c.rects;
      return !(
        hi.fill === entry.highlight &&
        sh.fill === entry.shadow &&
        hi.opacity === "0.72" &&
        sh.opacity === "0.9" &&
        outline.fill === "none" &&
        /rgb\(5,\s*16,\s*31\)/.test(outline.computedStroke) &&
        c.baseLum > c.shadowLum &&
        c.highlightLum > c.baseLum
      );
    });
    check(
      `[${width}px] every block cell is base + highlight + shadow in luminance order with the shared dark outline`,
      badCells.length === 0 && m.towerCells.length > 0,
      `${m.towerCells.length - badCells.length}/${m.towerCells.length} cells ok`,
    );

    // ── The silhouette is never clipped by the viewBox ────────────────────
    const clipped = m.towerCells.flatMap((c) => c.rects).filter((r) => {
      const vb = m.stage.viewBox;
      const eps = 0.2;
      return r.bbox.x < vb.x - eps || r.bbox.y < vb.y - eps ||
        r.bbox.x + r.bbox.width > vb.x + vb.w + eps ||
        r.bbox.y + r.bbox.height > vb.y + vb.h + eps;
    });
    check(
      `[${width}px] no block art is clipped by the stage viewBox`,
      clipped.length === 0,
      clipped.length ? `${clipped.length} rects outside` : "all rects inside",
    );

    // ── Stage fit + page overflow ─────────────────────────────────────────
    const fits = m.stage.width <= m.stage.clientWidth + 1 && m.stage.height <= m.stage.clientHeight + 1;
    const noOverflow = m.stage.docScrollWidth <= m.stage.innerWidth + 1;
    check(
      `[${width}px] the board fits its container and the page does not scroll sideways`,
      fits && noOverflow,
      `svg ${m.stage.width}×${m.stage.height} in ${m.stage.clientWidth}×${m.stage.clientHeight} · document ${m.stage.docScrollWidth}px in ${m.stage.innerWidth}px`,
    );
    if (!(fits && noOverflow)) allWidthsOk = false;

    // ── Hit area: the whole stage still drops ─────────────────────────────
    const svgBox = await page.locator("#stage svg").boundingBox();
    await page.mouse.click(svgBox.x + svgBox.width / 2, svgBox.y + svgBox.height / 2);
    const clicks = await page.evaluate(() => window.__stageClicks);
    check(
      `[${width}px] the stage hit area is intact (a click on the board reaches the drop handler once)`,
      clicks === 1 && m.stage.className.includes("cursor-pointer"),
      `clicks=${clicks} class="${m.stage.className}"`,
    );

    // ── Picker: the same art, three distinguishable states ────────────────
    const footprint = { I: 3, L: 2, T: 4, square: 2, short: 1, long: 4, big: 6 };
    const shapeAspect = { I: [3, 1], L: [1, 2], T: [2, 2], square: [2, 1], short: [1, 1], long: [4, 1], big: [3, 2] };
    const glyphProblems = [];
    for (const [shape, state] of Object.entries(m.glyphs)) {
      const p = m.palette[shape];
      for (const [name, g] of Object.entries(state)) {
        const expectRects = name === "selected" ? 5 : 4;
        const [aw, ah] = shapeAspect[shape];
        if (g.cells !== footprint[shape]) glyphProblems.push(`${shape}:${name} cells=${g.cells}`);
        if (!g.rectsPerCell.every((n) => n === expectRects)) glyphProblems.push(`${shape}:${name} rects=${g.rectsPerCell}`);
        if (g.base !== p.base || g.highlight !== p.highlight || g.shadow !== p.shadow) glyphProblems.push(`${shape}:${name} palette drift`);
        if (!/rgb\(5,\s*16,\s*31\)/.test(g.outline || "")) glyphProblems.push(`${shape}:${name} outline=${g.outline}`);
        if (!(g.outlineWidth >= 0.7)) glyphProblems.push(`${shape}:${name} outlineWidth=${g.outlineWidth}`);
        if (Math.abs(g.width / g.height - aw / ah) > 0.12) glyphProblems.push(`${shape}:${name} aspect ${g.width}x${g.height}`);
        if (name === "available" && (g.stateAttr !== "solid" || g.groupOpacity !== 1)) glyphProblems.push(`${shape}:available state=${g.stateAttr} op=${g.groupOpacity}`);
        if (name === "selected" && (g.stateAttr !== "selected" || g.keyline !== "var(--gr-selected, #f5ff3b)")) glyphProblems.push(`${shape}:selected keyline=${g.keyline}`);
        if (name === "unavailable" && (!(g.groupOpacity < 0.7) || !/grayscale/.test(g.filter || ""))) glyphProblems.push(`${shape}:unavailable op=${g.groupOpacity} filter=${g.filter}`);
        seenShapes.add(shape);
      }
    }
    check(
      `[${width}px] picker icons are the same art (palette, footprint, aspect, outline) in all three states`,
      glyphProblems.length === 0,
      glyphProblems.length ? glyphProblems.join(" · ") : "21 glyphs ok",
    );

    // ── Pixel proof: the three values are actually painted ────────────────
    // Attribute checks prove intent; this samples the rendered pixels of one
    // cell top-to-bottom and requires the highlight to be lighter than the
    // base and the shadow darker than it, so a band that collapsed below a
    // pixel at phone width would be caught.
    if (width === 320 || width === 1280) {
      const cellBox = await page.evaluate(() => {
        const g = document.querySelectorAll('#stage svg g[data-block-state="solid"]')[0];
        const b = g.querySelectorAll(':scope > rect')[0].getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      });
      const shot = await page.screenshot({ clip: cellBox });
      const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
      const lumAt = (relY) => {
        const px = Math.floor(cellBox.width / 2);
        const py = Math.min(info.height - 1, Math.floor(info.height * relY));
        const i = (py * info.width + px) * info.channels;
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]].map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const [hiLum, baseLum, shLum] = [lumAt(0.2), lumAt(0.45), lumAt(0.8)];
      check(
        `[${width}px] the painted pixels show highlight > base > shadow`,
        cellBox.width >= 8 && hiLum > baseLum + 0.02 && baseLum > shLum + 0.02,
        `cell ${cellBox.width.toFixed(1)}px · highlight ${hiLum.toFixed(2)} > base ${baseLum.toFixed(2)} > shadow ${shLum.toFixed(2)}`,
      );
    }

    await page.screenshot({ path: join(REPORTS, `stage-${width}.png`), fullPage: true });
    if (errors.length) console.log(`  page errors @${width}px:`, errors.join(" | "));
    await page.close();
  }

  check("all seven shapes were painted and measured", seenShapes.size === 7, [...seenShapes].join(","));
  check("the stage fits at every measured width", allWidthsOk, WIDTHS.join(", "));
  await browser.close();
} finally {
  server.close();
}

// ── Source wiring: one renderer, no duplicate art ──────────────────────
check(
  "the board and the picker import the one BlockArt module",
  /components\/tower-arena\/BlockArt/.test(pageSrc) &&
    pageSrc.includes("<BlockCell") &&
    pageSrc.includes("<BlockGlyph") &&
    !pageSrc.includes("SHAPE_COLORS") &&
    !/function BlockCell\(/.test(pageSrc) &&
    !/function BlockGlyph\(/.test(pageSrc),
  "scene imports BlockCell/BlockGlyph, local copies removed",
);
check(
  "the shared renderer stays pure SVG rects (no canvas, images or new engine)",
  artSrc.includes("<rect") &&
    !/canvas|<image|document\.|window\./.test(artSrc),
  "BlockArt.tsx is presentational SVG",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
