// standalone/memory-grid/artwork/render-artwork.mjs
//
// The five cover images a portal's submission form asks for, made from a REAL
// capture of the built game.
//
// Solitaire Duel draws its covers from a vector master because its board is
// static. Memory Grid's identity IS a dealt board with lit tiles, so drawing one
// by hand would be a lie: this script launches the built package in headless
// Chrome, starts a match, waits for the memorize phase, and screenshots the
// phase banner and grid at 2x device scale. That capture is the board every
// cover shows.
//
//   1. capture  — headless Chrome, the package served from 127.0.0.1, one match
//                 started, the memorize phase's lit pattern screenshotted
//   2. compose  — the capture is cover-cropped into a rounded panel and placed on
//                 the game's own navy stage, with the wordmark, strapline and a
//                 PLAY FREE badge drawn in vector
//
// The covers go to `dist/portal/artwork/`, NOT inside the game package: they are
// uploaded to the portal's form, so shipping them with the game would only bloat
// the download and confuse a review of the build.
//
// Run it with `npm run artwork:portal:memory-grid` (needs Chrome and a built
// package: `npm run build:portal:memory-grid`).
//
// The board in the capture comes from a random match seed, so a re-run deals a
// different — equally valid — pattern. Everything else is deterministic.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

import sharp from "sharp";

const ROOT = process.cwd();
const PACKAGE_DIR = resolve(ROOT, "dist/portal/memory-grid");
const OUT_DIR = resolve(ROOT, "dist/portal/artwork");
const KEEP_CAPTURE = process.argv.includes("--keep-capture");

const FONT = "Segoe UI, Segoe UI Variable Display, Inter, Arial, Helvetica, sans-serif";
const AMBER = "#fbbf24";
const AMBER_DEEP = "#f59e0b";
const WHITE = "#ffffff";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

async function startServer(dir) {
  const server = createServer((req, res) => {
    const requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const safe = normalize(requested).replace(/^([/\\])+/, "");
    let file = join(dir, safe || "index.html");
    if (!file.startsWith(dir)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

// ── 1. Capture the built game ────────────────────────────────────────────

async function captureBoard() {
  const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  assert.ok(chromePath, "Chrome not found — set CHROME_PATH to a Chrome/Chromium binary");

  const { server, base } = await startServer(PACKAGE_DIR);
  const profile = mkdtempSync(join(tmpdir(), "grynd-memory-grid-art-"));

  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--metrics-recording-only",
      "--no-pings",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const browserWs = await new Promise((done, fail) => {
    let buffered = "";
    const timer = setTimeout(
      () => fail(new Error("Chrome did not report a DevTools endpoint")),
      25_000,
    );
    chrome.stderr.on("data", (chunk) => {
      buffered += chunk.toString();
      const found = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (found) {
        clearTimeout(timer);
        done(found[1]);
      }
    });
    chrome.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`Chrome exited before it was ready (code ${code})`));
    });
  });

  const devtoolsPort = new URL(browserWs).port;
  let pageTarget = null;
  for (let attempt = 0; attempt < 50 && !pageTarget; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((r) => r.json());
    pageTarget = targets.find((target) => target.type === "page");
    if (!pageTarget) await sleep(100);
  }
  assert.ok(pageTarget, "no page target exposed by Chrome");

  const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => fail(new Error("CDP socket failed")), { once: true });
  });

  let messageId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const settle = pending.get(message.id);
    pending.delete(message.id);
    settle?.(message);
  });

  const send = (method, params = {}) => {
    const id = (messageId += 1);
    return new Promise((done, fail) => {
      pending.set(id, (message) =>
        message.error
          ? fail(new Error(`${method}: ${JSON.stringify(message.error)}`))
          : done(message.result),
      );
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "page evaluation failed");
    }
    return result.result.value;
  };

  const until = async (label, expression, timeoutMs = 20_000) => {
    const startedAt = Date.now();
    for (;;) {
      if (await evaluate(expression)) return;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
      await sleep(120);
    }
  };

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    // 2x device scale, so the panel stays crisp when a 630 px itch cover crops it.
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1600,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await send("Page.navigate", { url: `${base}/index.html` });
    await until("the menu", "!!document.querySelector('[data-testid=\"start-match\"]')");
    await evaluate("document.querySelector('[data-testid=\"start-match\"]').click(); true");

    // The memorize window is the one moment the board is at its most
    // photogenic: amber tiles, a live countdown, nothing revealed yet.
    await until(
      "the lit pattern",
      "document.querySelectorAll('[data-tile-state=\"pattern\"]').length > 0",
      25_000,
    );
    // Let the 180 ms flip finish before the shutter.
    await sleep(500);

    // Two crops of the same moment:
    //   banner — the phase banner AND the grid, aspect ~0.93, for the wide cover
    //   board  — the grid alone, square, so a square panel needs no crop at all
    // Every panel below is sized to its source's aspect, so no cover ever cuts a
    // row of tiles in half.
    const clips = await evaluate(
      `(() => {
        window.scrollTo(0, 0);
        const board = document.querySelector('[data-testid="memory-board"]').getBoundingClientRect();
        const timer = document.querySelector('[data-testid="countdown"]').getBoundingClientRect();
        const rect = (left, top, right, bottom) => ({
          x: Math.round(left),
          y: Math.round(top),
          width: Math.round(right - left),
          height: Math.round(bottom - top),
        });
        return {
          banner: rect(
            Math.max(0, Math.min(board.left, timer.left) - 40),
            // tight at the top: the scoreboard sits just above the banner and
            // would otherwise bleed into the cover
            Math.max(0, Math.min(board.top, timer.top) - 18),
            Math.min(window.innerWidth, Math.max(board.right, timer.right) + 40),
            Math.min(window.innerHeight, Math.max(board.bottom, timer.bottom) + 40),
          ),
          board: rect(
            Math.max(0, board.left - 26),
            Math.max(0, board.top - 26),
            Math.min(window.innerWidth, board.right + 26),
            Math.min(window.innerHeight, board.bottom + 26),
          ),
        };
      })()`,
    );

    const shots = {};
    for (const [name, clip] of Object.entries(clips)) {
      assert.ok(
        clip.width > 200 && clip.height > 200,
        `the ${name} clip looks wrong: ${JSON.stringify(clip)}`,
      );
      const shot = await send("Page.captureScreenshot", {
        format: "png",
        clip: { ...clip, scale: 2 },
      });
      shots[name] = Buffer.from(shot.data, "base64");
      const meta = await sharp(shots[name]).metadata();
      console.log(
        `captured ${name} at ${meta.width}x${meta.height} (CSS ${clip.width}x${clip.height} @2x)`,
      );
    }

    if (KEEP_CAPTURE) {
      mkdirSync(OUT_DIR, { recursive: true });
      for (const [name, buffer] of Object.entries(shots)) {
        const file = join(OUT_DIR, `memory-grid-${name}.png`);
        await sharp(buffer).png().toFile(file);
        console.log(`kept the raw ${name} capture: ${file}`);
      }
    }

    return shots;
  } finally {
    socket.close();
    await fetch(`http://127.0.0.1:${devtoolsPort}/json/close/${pageTarget.id}`).catch(() => {});
    chrome.kill();
    server.close();
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // a still-shutting-down Chrome can hold the profile on Windows; harmless
    }
  }
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
        `letter-spacing="${line.spacing ?? 0}">${line.value}</text>`,
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
 * One layout per format. Every panel is drawn from the same capture; the text is
 * sized to the canvas so no line collides with it.
 */
const LAYOUTS = {
  "1920x1080": {
    source: "banner",
    // the panel's width follows the capture's aspect, so the banner is never cut
    matchSourceAspect: true,
    panel: { left: 1090, top: 130, width: 760, height: 820, radius: 26 },
    text: [
      { value: "GRYND · MEMORY DUEL", x: 120, y: 236, size: 26, fill: AMBER, spacing: 9, weight: 800 },
      { value: "MEMORY", x: 120, y: 372, size: 132 },
      { value: "GRID", x: 120, y: 516, size: 132, fill: AMBER },
      {
        value: "Study the pattern. Rebuild it from memory.",
        x: 120,
        y: 612,
        size: 32,
        opacity: 0.78,
        weight: 600,
      },
      {
        value: "5 rounds · 3×3 to 6×6 · tiebreak round",
        x: 120,
        y: 676,
        size: 24,
        opacity: 0.5,
        weight: 600,
        spacing: 1.5,
      },
    ],
    badge: { x: 120, y: 742, width: 318, height: 66, label: "PLAY FREE" },
  },
  "800x1200": {
    source: "board",
    panel: { left: 100, top: 520, width: 600, height: 580, radius: 24 },
    text: [
      { value: "GRYND · MEMORY DUEL", x: 80, y: 118, size: 20, fill: AMBER, spacing: 7, weight: 800 },
      { value: "MEMORY", x: 80, y: 246, size: 92 },
      { value: "GRID", x: 80, y: 348, size: 92, fill: AMBER },
      { value: "Study the pattern.", x: 80, y: 414, size: 26, opacity: 0.78, weight: 600 },
      { value: "Rebuild it from memory.", x: 80, y: 452, size: 26, opacity: 0.78, weight: 600 },
      {
        value: "5 rounds · 3×3 to 6×6",
        x: 80,
        y: 506,
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
      { value: "GRYND · MEMORY DUEL", x: 130, y: 78, size: 17, fill: AMBER, spacing: 6, weight: 800 },
      { value: "MEMORY", x: 130, y: 172, size: 78 },
      { value: "GRID", x: 130, y: 248, size: 78, fill: AMBER },
      {
        value: "Study the pattern. Rebuild it from memory.",
        x: 130,
        y: 296,
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
        value: '<tspan fill="#ffffff">MEMORY </tspan><tspan fill="#fbbf24">GRID</tspan>',
        x: 315,
        y: 84,
        size: 54,
        anchor: "middle",
        spacing: 2,
      },
      {
        value: "Remember the pattern",
        x: 315,
        y: 124,
        size: 20,
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
      { value: "GRYND · MEMORY DUEL", x: 72, y: 142, size: 19, fill: AMBER, spacing: 7, weight: 800 },
      { value: "MEMORY", x: 72, y: 258, size: 92 },
      { value: "GRID", x: 72, y: 352, size: 92, fill: AMBER },
      {
        value: "Study the pattern. Rebuild it from memory.",
        x: 72,
        y: 414,
        size: 22,
        opacity: 0.75,
        weight: 600,
      },
      {
        value: "5 rounds · 3×3 to 6×6",
        x: 72,
        y: 456,
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
      `<rect width="${panel.width}" height="${panel.height}" rx="${panel.radius}" ry="${panel.radius}" fill="#fff"/></svg>`,
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
    `the ${cover.file} panel does not fit its canvas`,
  );

  const panelShot = await roundedShot(source, panel);

  const buffer = await sharp({
    create: { width: cover.width, height: cover.height, channels: 4, background: "#04070f" },
  })
    .composite([
      { input: Buffer.from(backgroundSvg(cover.width, cover.height)), top: 0, left: 0 },
      { input: panelShot, top: layout.panel.top, left: layout.panel.left },
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

assert.ok(
  existsSync(join(PACKAGE_DIR, "index.html")),
  `no built package at ${PACKAGE_DIR} — run \`npm run build:portal:memory-grid\` first`,
);

mkdirSync(OUT_DIR, { recursive: true });
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

console.log(`\n${written.length} cover(s) written to dist/portal/artwork/\n`);
for (const entry of written) {
  console.log(
    `  ${kb(entry.bytes).padStart(9)}  ${entry.width}x${entry.height}  ${entry.file.split(/[\\/]/).pop()}`,
  );
}
console.log(
  "\nThese are for the portal's submission form, not the game package." +
    "\nThe board is a live capture: a new run deals a different (equally valid) pattern.\n",
);
