// qa/solitaire-ranked-theme-check.mjs
//
// MOBILE VISUAL CHECK for the table picker on the ranked match page.
//
// Builds qa/solitaire-ranked-theme-harness.tsx — the real picker and the real
// board in the ranked match page's own layout markup — and verifies, at phone
// widths, the thing that unit tests cannot:
//
//   * the picker sits ABOVE the board and stays inside the viewport;
//   * the collapsed label names the active table;
//   * opening it does not shift the board, overflow the page, or leave the panel
//     outside the screen;
//   * picking a preset repaints the shared board and persists the choice;
//   * the board still deals a full tableau underneath all of it.
//
// Screenshots: qa/reports/solitaire-ranked-theme/<width>-open.png and
//              qa/reports/solitaire-ranked-theme/<width>.png
//
// Run: node qa/solitaire-ranked-theme-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "grynd-ranked-theme-"));
const REPORTS = join(root, "qa", "reports", "solitaire-ranked-theme");
mkdirSync(REPORTS, { recursive: true });

const STORAGE_KEY = "grynd.solitaire.boardTheme.v1";

await esbuild.build({
  entryPoints: [join(root, "qa/solitaire-ranked-theme-harness.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  loader: {
    ".js": "jsx",
    ".png": "dataurl",
    ".svg": "dataurl",
    ".webp": "dataurl",
    ".jpg": "dataurl",
  },
  define: { "process.env.NODE_ENV": '"development"' },
});

const css = await postcss([tailwind()]).process(
  readFileSync(join(root, "src/app/globals.css"), "utf8"),
  { from: join(root, "src/app/globals.css") },
);
writeFileSync(join(outDir, "app.css"), css.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, ""));
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html><html class="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ranked table picker</title>
<link rel="stylesheet" href="./app.css"></head>
<body style="margin:0;background:#05070d"><div id="root"></div>
<script src="./harness.js"></script></body></html>`,
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  for (const candidate of [join(outDir, relative), join(root, "public", relative)]) {
    try {
      const body = await readFile(candidate);
      res.writeHead(200, { "content-type": MIME[extname(candidate)] ?? "application/octet-stream" });
      res.end(body);
      return;
    } catch {
      // try the next root
    }
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/index.html`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ channel: "chrome" });
}

const readLayout = (page) =>
  page.evaluate(() => {
    const picker = document.querySelector('[data-testid="solitaire-theme-picker"]');
    const summary = picker?.querySelector("summary");
    const panel = picker?.querySelector("div");
    const board = document.querySelector('[data-testid="solitaire-board"]');
    const frame = document.querySelector('[data-testid="ranked-board-frame"]');
    const rect = (node) => {
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, w: box.width, h: box.height };
    };
    let stored = null;
    try {
      stored = window.localStorage.getItem("grynd.solitaire.boardTheme.v1");
    } catch {
      // storage blocked
    }
    return {
      picker: rect(picker),
      summary: rect(summary),
      summaryText: summary?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      panel: rect(panel),
      // A closed <details> keeps its content box in some Chromium builds, so the
      // rect alone is not proof the panel is showing. The element's own `open`
      // attribute is the state the user actually toggled.
      panelVisible: Boolean(picker?.open) && Boolean(panel && panel.getBoundingClientRect().height > 0),
      board: rect(board),
      frame: rect(frame),
      theme: board?.getAttribute("data-solitaire-theme") ?? null,
      felt: board ? getComputedStyle(board).backgroundImage : null,
      // `data-card` is only on face-up cards; every tableau/stock card carries
      // `data-face-up`. Count the full deal, not just the seven visible tops.
      cards: document.querySelectorAll("[data-face-up]").length,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollOverflow: document.documentElement.scrollWidth - window.innerWidth,
      stored,
    };
  });

for (const viewport of [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
  { width: 768, height: 1024 },
  { width: 1280, height: 900 },
]) {
  // Tailwind's `sm` is 640px: below it the picker is a bottom sheet, at and
  // above it the original popover anchored under the button.
  const isPhone = viewport.width < 640;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message)));

  await page.goto(url);
  await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30000 });
  await page.waitForTimeout(350);
  await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY);
  await page.reload();
  await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30000 });
  await page.waitForTimeout(350);

  const label = `ranked @ ${viewport.width}`;
  const closed = await readLayout(page);

  check(`${label}: the picker is rendered`, Boolean(closed.picker && closed.picker.w > 0));
  check(
    `${label}: the collapsed label names the table`,
    /Table · Classic Green/.test(closed.summaryText ?? ""),
    closed.summaryText ?? "none",
  );
  check(
    `${label}: the picker sits ABOVE the board`,
    Boolean(closed.picker && closed.board) && closed.picker.bottom <= closed.board.y + 1,
    JSON.stringify({ picker: closed.picker, board: closed.board }),
  );
  check(
    `${label}: the picker stays inside the viewport`,
    Boolean(closed.picker) && closed.picker.x >= 0 && closed.picker.right <= viewport.width + 1,
    JSON.stringify({ picker: closed.picker, viewport: closed.viewport }),
  );
  check(`${label}: the full tableau is dealt`, closed.cards > 20, `${closed.cards} cards`);
  check(`${label}: no horizontal overflow`, closed.scrollOverflow <= 1, `${closed.scrollOverflow}px`);

  // ── Open the picker ────────────────────────────────────────────────────
  await page.click('[data-testid="solitaire-theme-picker"] summary');
  await page.waitForTimeout(120);
  const opened = await readLayout(page);

  check(`${label}: the panel opens`, opened.panelVisible && opened.panel.w > 0);
  check(
    `${label}: the panel stays inside the viewport`,
    Boolean(opened.panel) &&
      opened.panel.x >= -1 &&
      opened.panel.right <= viewport.width + 1 &&
      opened.panel.y >= -1 &&
      opened.panel.bottom <= viewport.height + 1,
    JSON.stringify({ panel: opened.panel, viewport: opened.viewport }),
  );
  if (isPhone) {
    check(
      `${label}: it is a BOTTOM SHEET, pinned to the viewport edge`,
      Boolean(opened.panel) && Math.abs(opened.panel.bottom - viewport.height) <= 2,
      `panel bottom ${opened.panel?.bottom} vs viewport ${viewport.height}`,
    );
    check(
      `${label}: the sheet never covers the board`,
      Boolean(opened.panel && opened.board) && opened.panel.y >= opened.board.bottom - 1,
      JSON.stringify({ panelTop: opened.panel?.y, boardBottom: opened.board?.bottom }),
    );
  } else {
    check(
      `${label}: it is the wider-screen POPOVER, anchored under the button`,
      Boolean(opened.panel && opened.picker) && opened.panel.y >= opened.picker.bottom - 1,
      JSON.stringify({ panelTop: opened.panel?.y, pickerBottom: opened.picker?.bottom }),
    );
    check(
      `${label}: the popover is right-aligned to the picker`,
      Boolean(opened.panel && opened.picker) &&
        Math.abs(opened.panel.right - opened.picker.right) <= 2,
      JSON.stringify({ panelRight: opened.panel?.right, pickerRight: opened.picker?.right }),
    );
    check(
      `${label}: the popover is not pinned to the bottom`,
      Boolean(opened.panel) && Math.abs(opened.panel.bottom - viewport.height) > 2,
      `panel bottom ${opened.panel?.bottom}`,
    );
  }
  check(
    `${label}: opening it does not move the board`,
    Boolean(opened.board && closed.board) && Math.abs(opened.board.y - closed.board.y) <= 1,
    `${closed.board?.y} → ${opened.board?.y}`,
  );
  check(`${label}: opening it adds no horizontal overflow`, opened.scrollOverflow <= 1, `${opened.scrollOverflow}px`);

  const openShot = join(REPORTS, `${viewport.width}-open.png`);
  await page.screenshot({ path: openShot, fullPage: true });
  console.log(`   screenshot → ${openShot.replace(root, "").replace(/\\/g, "/")}`);

  // ── Pick a preset ──────────────────────────────────────────────────────
  const classicFelt = closed.felt;
  await page.click('[data-theme-key="ocean"]');
  await page.waitForTimeout(150);
  const picked = await readLayout(page);

  check(`${label}: selecting Ocean Blue repaints the board`, picked.theme === "ocean", picked.theme ?? "none");
  check(`${label}: the felt actually changed`, picked.felt !== classicFelt);
  check(`${label}: the choice is persisted for the next visit`, picked.stored === "ocean", picked.stored ?? "none");
  check(`${label}: the picker label follows the choice`, /Ocean Blue/.test(picked.summaryText ?? ""), picked.summaryText ?? "");

  if (isPhone) {
    await page.click('[data-testid="solitaire-theme-sheet-done"]');
  } else {
    // No Done button on the non-modal popover; the summary is the toggle.
    await page.click('[data-testid="solitaire-theme-picker"] summary');
  }
  await page.waitForTimeout(120);
  const resealed = await readLayout(page);
  check(`${label}: closing hides the panel`, !resealed.panelVisible);
  check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 2).join(" | "));

  const closedShot = join(REPORTS, `${viewport.width}.png`);
  await page.screenshot({ path: closedShot, fullPage: true });
  console.log(`   screenshot → ${closedShot.replace(root, "").replace(/\\/g, "/")}`);

  await context.close();
}

await browser.close();
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
