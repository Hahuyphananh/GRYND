// standalone/chess-ai/artwork/render-artwork.mjs
//
// The five cover images a portal's submission form asks for, made from a REAL
// capture of the built game.
//
// Memory Grid captures its lit pattern; chess captures a played position — after
// 1.e4 e5 2.Nf3 Nc6 the f1 bishop is picked up, so the cover shows the board's
// own language: amber last-move trail, sky legal-move dots, clocks, and the
// Stockfish name. Drawing a board by hand would be a lie about the game.
//
//   1. capture — headless Chrome, the built package served from 127.0.0.1, four
//                plies played, a piece selected, two crops screenshotted at 2x
//   2. compose — the capture is cover-cropped into a rounded panel on the game's
//                own navy stage, with the wordmark, strapline and PLAY FREE badge
//                drawn in vector
//
// Covers go to `dist/portal/artwork/chess-ai/` — a subfolder so they never
// overwrite another game's covers in the shared artwork directory. They are for
// the portal's submission form, not the game package.
//
// Run with `npm run artwork:portal:chess-ai` (needs Chrome and a built package:
// `npm run build:portal:chess-ai`).
//
// The position is real engine output, so a re-run plays a different — equally
// valid — game. Everything else is deterministic.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import sharp from "sharp";

import { sleep, withBrowserPage } from "../scripts/lib/browser.mjs";

const ROOT = process.cwd();
const PACKAGE_DIR = resolve(ROOT, "dist/portal/chess-ai");
const OUT_DIR = resolve(ROOT, "dist/portal/artwork/chess-ai");

const FONT = "Segoe UI, Segoe UI Variable Display, Inter, Arial, Helvetica, sans-serif";
const AMBER = "#fbbf24";
const AMBER_DEEP = "#f59e0b";
const WHITE = "#ffffff";

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

assert.ok(
  existsSync(join(PACKAGE_DIR, "index.html")),
  "no built package at dist/portal/chess-ai — run `npm run build:portal:chess-ai` first"
);

// ── 1. Capture the built game ────────────────────────────────────────────

async function captureBoard() {
  return withBrowserPage(PACKAGE_DIR, async ({ base, page }) => {
    // The board is ~640 px square; 2x rendering keeps the panel crisp at 630 px.
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.navigate(`${base}/index.html`);
    await page.until("the board", "document.querySelector('[data-square=\"e2\"]') !== null", 20_000);
    await page.until(
      "the engine to boot",
      "window.__CHESS_STATE__ && window.__CHESS_STATE__.engineReady === true",
      40_000
    );

    const click = (square) =>
      page.evaluate(`(() => {
        const el = document.querySelector('[data-square="${square}"]');
        if (!el) return false;
        el.click();
        return true;
      })()`);

    // 1.e4 e5 2.Nf3 Nc6 — a real engine reply after each human move.
    for (const [from, to, expected] of [
      ["e2", "e4", 1],
      ["g1", "f3", 3],
    ]) {
      assert.ok(await click(from), `could not click ${from}`);
      await page.until(
        `the ${from} pick`,
        `window.__CHESS_STATE__.selected === '${from}'`,
        5_000
      );
      assert.ok(await click(to), `could not click ${to}`);
      await page.until(
        `the ${from}${to} move`,
        `window.__CHESS_STATE__.history.length >= ${expected}`,
        5_000
      );
      await page.until(
        "Stockfish's reply",
        `window.__CHESS_STATE__.history.length === ${expected + 1} && window.__CHESS_STATE__.thinking === false`,
        40_000
      );
    }

    // Pick up the bishop: e2/d3/c4 light up with the board's own capture dots.
    assert.ok(await click("f1"), "could not pick up the bishop");
    await page.until("the f1 pick", "window.__CHESS_STATE__.selected === 'f1'", 5_000);
    await sleep(500);

    const clips = await page.evaluate(`(() => {
      window.scrollTo(0, 0);
      const board = document.querySelector('[data-testid="board"]').getBoundingClientRect();
      const seats = [...document.querySelectorAll('.seat')].map((el) => el.getBoundingClientRect());
      const rect = (left, top, right, bottom) => ({
        x: Math.round(left), y: Math.round(top),
        width: Math.round(right - left), height: Math.round(bottom - top),
      });
      const left = Math.min(board.left, ...seats.map((seat) => seat.left));
      const right = Math.max(board.right, ...seats.map((seat) => seat.right));
      // 30px of side breathing room: the frame's 22px stroke is centred on the
      // panel edge and would otherwise cover the first/last file of the board.
      const PAD = 30;
      // Only 10px above/below the seat bars: 30px reached up into the page header
      // and sliced its tagline into the top of the landscape cover.
      const VERTICAL_PAD = 10;
      return {
        board: rect(board.left - PAD, board.top - PAD, board.right + PAD, board.bottom + PAD),
        stage: rect(
          left - PAD,
          Math.min(board.top, ...seats.map((seat) => seat.top)) - VERTICAL_PAD,
          right + PAD,
          Math.max(board.bottom, ...seats.map((seat) => seat.bottom)) + VERTICAL_PAD,
        ),
      };
    })()`);

    const shots = {};
    for (const [name, clip] of Object.entries(clips)) {
      assert.ok(clip.width > 200 && clip.height > 200, `the ${name} clip is wrong: ${JSON.stringify(clip)}`);
      const shot = await page.send("Page.captureScreenshot", {
        format: "png",
        clip: { ...clip, scale: 2 },
      });
      shots[name] = Buffer.from(shot.data, "base64");
      const meta = await sharp(shots[name]).metadata();
      console.log(`captured ${name} at ${meta.width}x${meta.height} (CSS ${clip.width}x${clip.height} @2x)`);
    }
    return shots;
  });
}

// ── 2. Compose the covers ────────────────────────────────────────────────

function backgroundSvg(width, height) {
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stop-color="#12213f"/>
        <stop offset="0.55" stop-color="#080d1a"/>
        <stop offset="1" stop-color="#04070f"/>
      </linearGradient>
      <radialGradient id="warm" cx="0.16" cy="0.1" r="0.8">
        <stop offset="0" stop-color="${AMBER_DEEP}" stop-opacity="0.20"/>
        <stop offset="1" stop-color="#04070f" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="cool" cx="0.94" cy="0.92" r="0.75">
        <stop offset="0" stop-color="#2f7fb8" stop-opacity="0.20"/>
        <stop offset="1" stop-color="#04070f" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect width="${width}" height="${height}" fill="url(#warm)"/>
    <rect width="${width}" height="${height}" fill="url(#cool)"/>
  </svg>`;
}

function frameSvg(panel, canvasWidth, canvasHeight) {
  const { left, top, width, height, radius } = panel;
  return `<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${left}" y="${top}" width="${width}" height="${height}" rx="${radius}" fill="none"
      stroke="${AMBER}" stroke-opacity="0.14" stroke-width="22"/>
    <rect x="${left}" y="${top}" width="${width}" height="${height}" rx="${radius}" fill="none"
      stroke="${AMBER}" stroke-opacity="0.6" stroke-width="4"/>
    <rect x="${left}" y="${top}" width="${width}" height="${height}" rx="${radius}" fill="none"
      stroke="#04070f" stroke-opacity="0.85" stroke-width="2"/>
  </svg>`;
}

function textSvg({ width, height, text, badge }) {
  const lines = text
    .map(
      (line) =>
        `<text x="${line.x}" y="${line.y}" text-anchor="${line.anchor ?? "start"}" ` +
        `font-family="${FONT}" font-size="${line.size}" font-weight="${line.weight ?? 900}" ` +
        `fill="${line.fill ?? WHITE}" fill-opacity="${line.opacity ?? 1}" ` +
        `letter-spacing="${line.spacing ?? 0}">${line.value}</text>`
    )
    .join("\n    ");

  const badgeSvg = badge
    ? `<g>
      <rect x="${badge.x}" y="${badge.y}" width="${badge.width}" height="${badge.height}" rx="${badge.height / 2}"
        fill="${AMBER}"/>
      <text x="${badge.x + badge.width / 2}" y="${badge.y + badge.height / 2 + badge.height * 0.17}"
        text-anchor="middle" font-family="${FONT}" font-size="${badge.height * 0.42}" font-weight="900"
        fill="#0a0f1a" letter-spacing="${badge.height * 0.06}">${badge.label}</text>
    </g>`
    : "";

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    ${lines}
    ${badgeSvg}
  </svg>`;
}

/**
 * One layout per format, mirroring the other standalone games. Every panel is
 * drawn from the same capture; the text is sized so no line meets the panel.
 */
const LAYOUTS = {
  "1920x1080": {
    source: "stage",
    matchSourceAspect: true,
    panel: { left: 1090, top: 130, width: 700, height: 820, radius: 26 },
    text: [
      { value: "GRYND · CHESS", x: 120, y: 236, size: 26, fill: AMBER, spacing: 9, weight: 800 },
      { value: "CHESS", x: 120, y: 380, size: 138 },
      { value: "VS STOCKFISH 16", x: 120, y: 462, size: 66, fill: AMBER },
      {
        value: "Play the engine. No account, no downloads.",
        x: 120,
        y: 560,
        size: 32,
        opacity: 0.78,
        weight: 600,
      },
      {
        value: "3 difficulty levels · 5-minute clocks · undo",
        x: 120,
        y: 622,
        size: 24,
        opacity: 0.5,
        weight: 600,
        spacing: 1.5,
      },
    ],
    badge: { x: 120, y: 700, width: 318, height: 66, label: "PLAY FREE" },
  },
  "800x1200": {
    source: "stage",
    panel: { left: 100, top: 540, width: 600, height: 560, radius: 24 },
    text: [
      { value: "GRYND · CHESS", x: 80, y: 118, size: 20, fill: AMBER, spacing: 7, weight: 800 },
      { value: "CHESS", x: 80, y: 252, size: 96 },
      { value: "VS STOCKFISH 16", x: 80, y: 326, size: 48, fill: AMBER },
      { value: "Play the engine.", x: 80, y: 390, size: 26, opacity: 0.78, weight: 600 },
      { value: "No account. No downloads.", x: 80, y: 426, size: 26, opacity: 0.78, weight: 600 },
      {
        value: "3 levels · 5-minute clocks",
        x: 80,
        y: 482,
        size: 20,
        opacity: 0.45,
        weight: 600,
        spacing: 1.2,
      },
    ],
    badge: { x: 100, y: 1130, width: 252, height: 44, label: "PLAY FREE" },
  },
  "800x800": {
    source: "board",
    panel: { left: 170, top: 316, width: 460, height: 460, radius: 22 },
    text: [
      { value: "GRYND · CHESS", x: 130, y: 78, size: 17, fill: AMBER, spacing: 6, weight: 800 },
      { value: "CHESS", x: 130, y: 178, size: 82 },
      { value: "VS STOCKFISH 16", x: 130, y: 232, size: 38, fill: AMBER },
      {
        value: "Play the engine offline. Three levels.",
        x: 130,
        y: 282,
        size: 22,
        opacity: 0.72,
        weight: 600,
      },
    ],
  },
  "630x500": {
    source: "board",
    panel: { left: 145, top: 146, width: 340, height: 340, radius: 18 },
    text: [
      {
        // dx, not a leading space: SVG collapses whitespace between tspans, which
        // rendered the first version as "CHESSAI".
        value:
          '<tspan fill="#ffffff">CHESS</tspan><tspan fill="#fbbf24" dx="14">AI</tspan>',
        x: 315,
        y: 80,
        size: 54,
        anchor: "middle",
        spacing: 2,
      },
      {
        value: "vs Stockfish 16 · offline",
        x: 315,
        y: 118,
        size: 19,
        anchor: "middle",
        opacity: 0.7,
        weight: 600,
      },
    ],
  },
  "1200x630": {
    source: "board",
    panel: { left: 640, top: 65, width: 500, height: 500, radius: 22 },
    text: [
      { value: "GRYND · CHESS", x: 72, y: 142, size: 19, fill: AMBER, spacing: 7, weight: 800 },
      { value: "CHESS", x: 72, y: 264, size: 96 },
      { value: "VS STOCKFISH 16", x: 72, y: 330, size: 46, fill: AMBER },
      {
        value: "Play the engine offline.",
        x: 72,
        y: 390,
        size: 22,
        opacity: 0.75,
        weight: 600,
      },
      {
        value: "3 difficulty levels · 5-minute clocks",
        x: 72,
        y: 432,
        size: 19,
        opacity: 0.45,
        weight: 600,
        spacing: 1.2,
      },
    ],
  },
};

const COVERS = [
  { file: "cover-landscape-1920x1080.png", width: 1920, height: 1080 },
  { file: "cover-portrait-800x1200.png", width: 800, height: 1200 },
  { file: "cover-square-800x800.png", width: 800, height: 800 },
  { file: "cover-itch-630x500.png", width: 630, height: 500 },
  { file: "social-1200x630.png", width: 1200, height: 630 },
];

async function roundedShot(shot, panel) {
  const resized = await sharp(shot)
    .resize(panel.width, panel.height, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
  const mask = Buffer.from(
    `<svg width="${panel.width}" height="${panel.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${panel.width}" height="${panel.height}" rx="${panel.radius}" ry="${panel.radius}" fill="#fff"/></svg>`
  );
  return sharp(resized).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

async function renderCover(shots, cover) {
  const layout = LAYOUTS[`${cover.width}x${cover.height}`];
  assert.ok(layout, `no layout for ${cover.width}x${cover.height}`);

  const source = shots[layout.source];
  assert.ok(source, `no "${layout.source}" capture for ${cover.file}`);

  const panel = { ...layout.panel };
  if (layout.matchSourceAspect) {
    const sourceMeta = await sharp(source).metadata();
    panel.width = Math.round((panel.height * sourceMeta.width) / sourceMeta.height);
  }
  assert.ok(
    panel.left + panel.width <= cover.width && panel.top + panel.height <= cover.height,
    `the ${cover.file} panel does not fit its canvas`
  );

  const panelShot = await roundedShot(source, panel);

  const buffer = await sharp({
    create: { width: cover.width, height: cover.height, channels: 4, background: "#04070f" },
  })
    .composite([
      { input: Buffer.from(backgroundSvg(cover.width, cover.height)), top: 0, left: 0 },
      { input: panelShot, top: panel.top, left: panel.left },
      { input: Buffer.from(frameSvg(panel, cover.width, cover.height)), top: 0, left: 0 },
      { input: Buffer.from(textSvg({ ...cover, ...layout })), top: 0, left: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();

  const file = join(OUT_DIR, cover.file);
  await sharp(buffer).toFile(file);
  return file;
}

// ── 3. Run ───────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });
const startedAt = Date.now();
const shots = await captureBoard();

const written = [];
for (const cover of COVERS) {
  const file = await renderCover(shots, cover);
  const meta = await sharp(file).metadata();
  assert.equal(meta.width, cover.width, `${cover.file} is ${meta.width}px wide`);
  assert.equal(meta.height, cover.height, `${cover.file} is ${meta.height}px tall`);
  assert.ok(statSync(file).size > 15_000, `${cover.file} looks empty`);
  written.push({ file, width: meta.width, height: meta.height, bytes: statSync(file).size });
}

writeFileSync(
  join(OUT_DIR, "artwork-report.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      position: "1.e4 e5 2.Nf3 Nc6, bishop f1 selected",
      covers: written.map((entry) => ({
        file: entry.file.split(/[\\/]/).pop(),
        width: entry.width,
        height: entry.height,
        bytes: entry.bytes,
      })),
    },
    null,
    2
  )
);

console.log(`\n${written.length} cover(s) written to dist/portal/artwork/chess-ai/\n`);
for (const entry of written) {
  console.log(
    `  ${kb(entry.bytes).padStart(9)}  ${entry.width}x${entry.height}  ${entry.file.split(/[\\/]/).pop()}`
  );
}
console.log(
  "\nThese are for the portal's submission form, not the game package." +
    "\nThe board is a live capture, so a re-run plays a different (equally valid) game.\n"
);
