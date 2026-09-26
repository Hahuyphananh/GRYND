// qa/games-blank-audit.mjs
//
// Audits EVERY playable game route in a real browser and reports which ones
// render a blank page — the reported symptom is "only the background is
// visible": the app shell paints, but the page's own content does not.
//
// A DOM probe alone is NOT enough to detect that: a page can contain all its
// text while painting nothing (a full-screen overlay, an opacity-0 wrapper, a
// zero-height container, a motion component whose `animate` never runs). So
// each route is judged twice:
//
//   1. PAINT — decode the screenshot and measure how much of the content
//      region differs from the page's dominant (background) color. This is
//      what the player actually sees.
//   2. DOM — visible text characters and visible interactive/text nodes in
//      the page's own content region, excluding nav/footer chrome.
//
// A route is reported BLANK when it paints essentially nothing outside the
// chrome, and INVISIBLE-CONTENT when it has plenty of text in the DOM but
// paints none of it (the classic "background only" regression).
//
// Also recorded per route: HTTP status, final URL after redirects, uncaught
// page errors and console errors. Screenshots of flagged routes are written
// to qa/reports/games-blank-audit/.
//
// Usage:
//   node qa/games-blank-audit.mjs                        # localhost:3000
//   BASE=http://localhost:3210 node qa/games-blank-audit.mjs
//   node qa/games-blank-audit.mjs --shots                # screenshot everything
//
// The server must already be running (npm run build && npm run start). Run it
// with CLERK_SECRET_KEY="" to audit without a signed-in session: the proxy
// then skips Clerk entirely and every game route stays reachable.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports", "games-blank-audit");
const BASE = process.env.BASE || "http://localhost:3000";
const SHOT_ALL = process.argv.includes("--shots");
const FAIL_API = process.argv.includes("--fail-api");
// Playwright's bundled Chromium is not always downloaded (e.g. on a machine
// with system Chrome installed); BROWSER_CHANNEL=chrome uses the real one.
const CHANNEL = process.env.BROWSER_CHANNEL || "";

// ── Console-noise filter ───────────────────────────────────────────────────
// A match page that throws during render is the bug this audit hunts. The
// browser reports a render crash two ways: an uncaught `pageerror` (no error
// boundary) or a React/Next error-boundary message on the console (the
// boundary swallowed the throw). Everything here is NOT that: failed network
// requests, third-party ad/support scripts and CORS noise that every page
// emits. Whatever is left is a real JavaScript/React error worth reporting.
const CONSOLE_NOISE =
  /Failed to load resource|Access to script|net::ERR_|CORS policy|tawk\.to|googlesyndication|doubleclick|clarity\.ms|posthog|favicon|401 \(Unauthorized\)|500 \(Internal Server Error\)/i;

// Routes a player can reach WITHOUT an existing match/table id: each game's
// landing page (the target of the game cards in /casino) plus the vs-AI,
// multiplayer and history pages that hang off them.
const ROUTES = [
  { game: "Hub", path: "/casino" },
  { game: "Blackjack", path: "/games/blackjack" },
  { game: "Chess", path: "/games/chess" },
  { game: "Chess vs AI", path: "/games/chess/ai" },
  { game: "Chess game", path: "/games/chess-game/1" },
  { game: "Crash Arena", path: "/games/crash-arena" },
  { game: "Dice Flush", path: "/games/dice-flush" },
  { game: "Dots and Boxes", path: "/games/dots-and-boxes" },
  { game: "Four-In-A-Row", path: "/games/four-in-a-row" },
  { game: "Four-In-A-Row vs AI", path: "/games/four-in-a-row/play-ai" },
  { game: "Hex Duel", path: "/games/hex-duel" },
  { game: "Hex Duel multiplayer", path: "/games/hex-duel/multiplayer" },
  { game: "Hex Duel history", path: "/games/hex-duel/history" },
  { game: "Keno", path: "/games/keno" },
  { game: "Lane Runner", path: "/games/lane-runner" },
  { game: "Lane Runner history", path: "/games/lane-runner/history" },
  { game: "Memory Grid", path: "/games/memory-grid" },
  { game: "Mines PvP", path: "/games/mines-pvp" },
  { game: "Neon Flush", path: "/games/neon-flush" },
  { game: "Odds", path: "/games/odds" },
  { game: "Plinko", path: "/games/plinko" },
  { game: "Pool Masters", path: "/games/pool-masters" },
  { game: "Precision", path: "/games/precision" },
  { game: "Precision test", path: "/games/precision/test" },
  { game: "Roulette", path: "/games/roulette" },
  { game: "RPS", path: "/games/rps" },
  { game: "RPS vs AI", path: "/games/rps/play-ai" },
  { game: "Tower Arena", path: "/games/tower-arena" },
  { game: "Uno", path: "/games/uno" },
  // The top-level /uno aliases are separate routes, not rewrites.
  { game: "Uno (top-level)", path: "/uno" },
];

// Match/table pages: what a game sends you to after you hit Play. Audited with
// a synthetic id so the "no such match" / failed-fetch render path is exercised
// — that path must still paint something (a message, not a blank shell).
const MATCH_ROUTES = [
  { game: "Blackjack match", path: "/games/blackjack/1" },
  { game: "Chess table", path: "/games/chess/10" },
  { game: "Crash Arena table", path: "/games/crash-arena/table/1" },
  { game: "Dots and Boxes game", path: "/games/dots-and-boxes/game/1" },
  { game: "Four-In-A-Row game", path: "/games/four-in-a-row/game/1" },
  { game: "Keno PvP match", path: "/games/keno-pvp/1" },
  { game: "Lane Runner match", path: "/games/lane-runner/1" },
  { game: "Memory Grid match", path: "/games/memory-grid/1" },
  { game: "Mines PvP match", path: "/games/mines-pvp/1" },
  { game: "Plinko match", path: "/games/plinko/1" },
  { game: "Pool Masters game", path: "/games/pool-masters/game/1" },
  { game: "Precision game", path: "/games/precision/game/1" },
  { game: "Roulette match", path: "/games/roulette/1" },
  { game: "RPS game", path: "/games/rps/game/1" },
  { game: "Tower Arena game", path: "/games/tower-arena/game/1" },
  { game: "Uno game", path: "/games/uno/game/1" },
];

// ── Verdict thresholds ─────────────────────────────────────────────────────
// Painted content is measured in the middle band of the viewport (the page's
// own content area, away from the nav and the footer).
const CONTENT_TOP = 0.16; // fraction of viewport height
const CONTENT_BOTTOM = 0.9;
const PIXEL_DELTA = 24; // per-channel delta that counts as "not background"
const BLANK_PAINT_PCT = 1.0; // < 1% of content pixels differ from background
const BLANK_TEXT_CHARS = 120;
const BLANK_NODES = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Minimal PNG decoder (8-bit RGB/RGBA/gray, non-interlaced) ──────────────
// Playwright returns PNG buffers; decoding them here avoids adding a
// dependency just to ask "did anything actually paint?".
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG unsupported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 0xff;
    }
    prev = row;
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1) {
        out[d] = out[d + 1] = out[d + 2] = row[s];
        out[d + 3] = 255;
      } else if (channels === 2) {
        out[d] = out[d + 1] = out[d + 2] = row[s];
        out[d + 3] = row[s + 1];
      } else {
        out[d] = row[s];
        out[d + 1] = row[s + 1];
        out[d + 2] = row[s + 2];
        out[d + 3] = channels === 4 ? row[s + 3] : 255;
      }
    }
  }
  return { width, height, data: out };
}

// How much of the content band differs from the dominant (background) color,
// and where those differing pixels sit vertically.
function analysePaint(png) {
  const { width, height, data } = png;
  const bucket = (v) => v >> 4; // group near-identical colors

  // Dominant color = background.
  const counts = new Map();
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const d = (y * width + x) * 4;
      const key = (bucket(data[d]) << 8) | (bucket(data[d + 1]) << 4) | bucket(data[d + 2]);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let bgKey = 0;
  let bgCount = -1;
  for (const [k, v] of counts) {
    if (v > bgCount) {
      bgCount = v;
      bgKey = k;
    }
  }
  const bg = [((bgKey >> 8) & 0xf) << 4, ((bgKey >> 4) & 0xf) << 4, (bgKey & 0xf) << 4];

  const y0 = Math.floor(height * CONTENT_TOP);
  const y1 = Math.floor(height * CONTENT_BOTTOM);
  let contentPixels = 0;
  let painted = 0;
  let minPaintedRow = -1;
  let maxPaintedRow = -1;
  let totalPainted = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = (y * width + x) * 4;
      const differs =
        Math.abs(data[d] - bg[0]) > PIXEL_DELTA ||
        Math.abs(data[d + 1] - bg[1]) > PIXEL_DELTA ||
        Math.abs(data[d + 2] - bg[2]) > PIXEL_DELTA;
      if (differs) {
        totalPainted += 1;
        if (y >= y0 && y < y1) {
          painted += 1;
          if (minPaintedRow === -1) minPaintedRow = y;
          maxPaintedRow = y;
        }
      }
      if (y >= y0 && y < y1) contentPixels += 1;
    }
  }

  return {
    width,
    height,
    background: `rgb(${bg.join(",")})`,
    paintedPct: +((totalPainted / (width * height)) * 100).toFixed(2),
    contentPaintedPct: +((painted / contentPixels) * 100).toFixed(2),
    paintedRows: minPaintedRow === -1 ? null : [minPaintedRow, maxPaintedRow],
  };
}

// ── DOM probe: what the page's own content region contains ────────────────
function probeContent() {
  const chrome = "nav, footer, header, script, style, template, [data-chat-widget]";
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = window.getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return false;
    return true;
  };

  const body = document.body;
  const fullText = (body?.innerText || "").replace(/\s+/g, " ").trim();

  let contentText = "";
  let visibleContentNodes = 0;
  let opacityHiddenTextNodes = 0;
  for (const el of body.querySelectorAll("*")) {
    if (el.closest(chrome)) continue;
    const hasOwnText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
    );
    if (hasOwnText) {
      contentText += " " + (el.innerText || "");
      if (isVisible(el)) {
        // Effective opacity: a transparent ancestor hides the text just as
        // thoroughly as opacity on the element itself.
        let opacity = 1;
        for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
          opacity *= Number(window.getComputedStyle(node).opacity || 1);
          if (opacity <= 0.05) break;
        }
        if (opacity <= 0.05) opacityHiddenTextNodes += 1;
      }
    }
    if (!hasOwnText && !/^(img|canvas|svg|video|button|input|select|textarea)$/.test(el.tagName.toLowerCase())) {
      continue;
    }
    if (isVisible(el)) visibleContentNodes += 1;
  }

  return {
    fullTextChars: fullText.length,
    contentTextChars: contentText.replace(/\s+/g, " ").trim().length,
    visibleContentNodes,
    opacityHiddenTextNodes,
    bodyBg: window.getComputedStyle(body).backgroundColor,
    firstText: fullText.slice(0, 160),
  };
}

async function audit(browser, route) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  // `--fail-api` forces every API call to fail, which is the state a real
  // player lands in when the match-status endpoint errors. A match page that
  // never leaves its loading state here is the "blank page with only the
  // background" report, because its loading screen is a line of text on an
  // otherwise empty dark page.
  if (FAIL_API) {
    await page.route("**/api/**", (r) =>
      r.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Server error" }),
      }),
    );
  }
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 300)));
  // React/Next report render failures by logging on the console even when an
  // error boundary catches them, so the DOM can look "fine" while the page is
  // actually broken. Keep those separate from the network noise.
  const jsErrors = consoleErrors.filter((t) => !CONSOLE_NOISE.test(t));

  const result = { ...route, status: null, finalUrl: null, blank: false };
  try {
    const response = await page.goto(`${BASE}${route.path}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    result.status = response ? response.status() : null;
    // Let hydration + the first data fetch settle. `networkidle` can never be
    // reached on the pages that hold a socket open, so it is capped and the
    // fixed settle below is what actually guarantees the read is final.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await sleep(2500);
    result.finalUrl = page.url();

    Object.assign(result, await page.evaluate(probeContent));
    Object.assign(result, analysePaint(decodePng(await page.screenshot())));

    const paintsNothing = result.contentPaintedPct < BLANK_PAINT_PCT;
    const domIsEmpty = result.contentTextChars < BLANK_TEXT_CHARS && result.visibleContentNodes < BLANK_NODES;
    const domHidden = result.contentTextChars >= BLANK_TEXT_CHARS && result.opacityHiddenTextNodes > 0 && paintsNothing;

    // Three distinct failures, kept apart because they need different fixes:
    //   blank    — nothing rendered at all (a crash / an empty page)
    //   stuck    — the page never leaves its loading state (a hung fetch)
    //   hidden   — plenty of DOM text that never paints
    const stuck = /loading|creating game|chargement|waiting for/i.test(result.firstText || "");
    result.blank = paintsNothing && domIsEmpty && !stuck;
    result.stuckLoading = paintsNothing && stuck;
    result.invisibleContent = domHidden;

    if (result.blank || result.stuckLoading || result.invisibleContent || SHOT_ALL) {
      const name = route.game.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      result.screenshot = join(REPORTS, `${name}.png`);
      await page.screenshot({ path: result.screenshot });
    }
  } catch (err) {
    result.error = String(err).slice(0, 300);
  }

  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  // The real signal: an uncaught throw and/or a non-noise console error.
  result.jsErrors = jsErrors;
  result.crashed = pageErrors.length > 0 || jsErrors.length > 0;
  await context.close();
  return result;
}

const browser = await chromium.launch(CHANNEL ? { channel: CHANNEL } : {});
mkdirSync(REPORTS, { recursive: true });
const results = [];

const ALL_ROUTES = process.argv.includes("--landing-only")
  ? ROUTES
  : process.argv.includes("--match-only")
    ? MATCH_ROUTES
    : [...ROUTES, ...MATCH_ROUTES];
console.log(`auditing ${ALL_ROUTES.length} routes against ${BASE}\n`);

for (const route of ALL_ROUTES) {
  const r = await audit(browser, route);
  results.push(r);
  const flag = r.blank
    ? "BLANK"
    : r.stuckLoading
      ? "STUCK"
      : r.invisibleContent
        ? "HIDDEN"
        : r.crashed
          ? "JS-ERR"
          : r.error
            ? "ERROR"
            : "ok";
  console.log(
    `${flag.padEnd(6)} ${route.game.padEnd(23)} ${String(r.status || "-").padEnd(4)} ` +
      `paint:${String(r.contentPaintedPct ?? "-").padStart(6)}% text:${String(r.contentTextChars ?? "-").padStart(5)} ` +
      `nodes:${String(r.visibleContentNodes ?? "-").padStart(4)} pageerr:${r.pageErrors.length} jserr:${(r.jsErrors || []).length}` +
      `${r.error ? ` err:${r.error}` : ""}`,
  );
  for (const e of r.pageErrors || []) console.log(`         ! pageerror: ${e}`);
  for (const e of r.jsErrors || []) console.log(`         ! console:   ${e}`);
}

await browser.close();

const blanks = results.filter((r) => r.blank);
const stuck = results.filter((r) => r.stuckLoading);
const hidden = results.filter((r) => r.invisibleContent);
const crashed = results.filter((r) => r.crashed);

writeFileSync(
  join(REPORTS, "report.json"),
  JSON.stringify({ base: BASE, generatedAt: new Date().toISOString(), results }, null, 2),
);

console.log(`\n${results.length} routes audited`);
console.log(`blank: ${blanks.length}${blanks.length ? ` -> ${blanks.map((b) => b.game).join(", ")}` : ""}`);
console.log(`stuck on loading: ${stuck.length}${stuck.length ? ` -> ${stuck.map((b) => b.game).join(", ")}` : ""}`);
console.log(`invisible content: ${hidden.length}${hidden.length ? ` -> ${hidden.map((b) => b.game).join(", ")}` : ""}`);
console.log(`client-side crashes: ${crashed.length}${crashed.length ? ` -> ${crashed.map((c) => c.game).join(", ")}` : ""}`);
for (const c of crashed) {
  for (const e of c.pageErrors || []) console.log(`  ${c.game} [pageerror] ${e}`);
  for (const e of c.jsErrors || []) console.log(`  ${c.game} [console]   ${e}`);
}
console.log(`report: ${join(REPORTS, "report.json")}`);
