// qa/dnb-board-check.mjs
//
// Browser check for the Dots & Boxes board's selection contrast + claimed-box
// marks. Mounts the REAL board (qa/dnb-board-harness.jsx) and asserts:
//
//   1. A drawn edge is painted in the color of whoever drew it (host amber /
//      guest cyan) at the heavy "claimed" stroke weight.
//   2. Every still-open edge stays a faint NEUTRAL ghost — never a player
//      color, so a hover/ghost can never be mistaken for a claim.
//   3. A claimed box shows the owner's pfp (official /icons/<key>.webp) instead
//      of the old letter glyph — and the GRYND logo (/images/smalllogo.png) for
//      the AI seat, which resolves no icon key.
//   4. Those mark assets actually load (200).
//   5. An edge whose owner was never recorded (a match persisted before
//      ownership existed) still renders as neutral "taken", not as an open
//      slot.
//
// No board geometry is hard-coded: drawn lines are identified by their color
// and weight, so resizing the grid can't produce a false failure.
//
// Run: node qa/dnb-board-check.mjs

import { chromium } from "playwright";
import esbuild from "esbuild";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(root, "public");

const HOST_COLOR = "#f59e0b";
const GUEST_COLOR = "#22d3ee";
const UNKNOWN_COLOR = "#cbd5e1";
const AI_LOGO_SRC = "/images/smalllogo.png";
const DRAWN_STROKE = 6;
const GHOST_RE = /^rgba\(148, 163, 184/;

// 1. Bundle the harness + the real board. Next turns a static image import into
//    an object with `.src`; emulate that shape here.
const outDir = mkdtempSync(join(tmpdir(), "dnb-board-"));
const bundleOut = join(outDir, "harness.js");
await esbuild.build({
  entryPoints: [join(root, "qa/dnb-board-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: bundleOut,
  logLevel: "error",
  absWorkingDir: root,
  plugins: [
    {
      name: "next-static-image",
      setup(build) {
        build.onLoad({ filter: /\.png$/ }, () => ({
          contents: `export default { src: ${JSON.stringify(AI_LOGO_SRC)}, width: 612, height: 408 };`,
          loader: "js",
        }));
      },
    },
  ],
});
const harnessJs = readFileSync(bundleOut, "utf8");

const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>D&B board check</title>
<style>body{margin:0;background:#0b1220}</style></head>
<body><div id="root"></div><script src="/harness.js"></script></body></html>`;

// 2. Tiny static server: the bundle + the app's real public assets.
const MIME = { ".png": "image/png", ".webp": "image/webp" };
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
  const file =
    url.pathname.startsWith("/icons/") || url.pathname.startsWith("/images/")
      ? join(PUBLIC, url.pathname)
      : null;
  if (file && existsSync(file)) {
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(readFileSync(file));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

// One host line, one guest line, one box each — with ownership recorded.
const CLAIMED_PROPS = {
  drawnH: ["0,0"],
  drawnV: ["0,0"],
  boxes: ["0,0", "1,1"],
  boxOwners: { "0,0": "host", "1,1": "guest" },
  edgeOwners: { "h:0,0": "host", "v:0,0": "guest" },
  player1Color: HOST_COLOR,
  player2Color: GUEST_COLOR,
  interactive: true,
};

try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // A render error would otherwise just look like a missing <svg>.
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.renderBoard && window.renderBoardWithLegend);

  const readBoard = () =>
    page.evaluate(() => {
      const svg = document.querySelector("svg");
      return {
        lines: [...svg.querySelectorAll("line")].map((el) => ({
          stroke: el.getAttribute("stroke"),
          width: Number(el.getAttribute("stroke-width")),
          horizontal: el.getAttribute("y1") === el.getAttribute("y2"),
          vertical: el.getAttribute("x1") === el.getAttribute("x2"),
        })),
        images: [...svg.querySelectorAll("image")].map((el) => el.getAttribute("href")),
        texts: [...svg.querySelectorAll("text")].map((el) => el.textContent),
      };
    });

  const renderBoard = async (props) => {
    await page.evaluate((p) => window.renderBoard(p), props);
    await page.waitForFunction(() => document.querySelectorAll("svg line").length > 0);
    return readBoard();
  };

  // ── Drawn lines are owner-colored and heavy; open lines are neutral ──────
  const board = await renderBoard({ ...CLAIMED_PROPS, hostIconKey: "gryndicon1", guestIconKey: "gryndicon2" });
  const claimed = board.lines.filter((l) => !GHOST_RE.test(String(l.stroke)));
  const hostLine = claimed.find((l) => l.stroke === HOST_COLOR);
  const guestLine = claimed.find((l) => l.stroke === GUEST_COLOR);
  const openLines = board.lines.filter((l) => GHOST_RE.test(String(l.stroke)));

  check(
    "host-drawn line uses the host color, heavy + horizontal",
    !!hostLine && hostLine.width === DRAWN_STROKE && hostLine.horizontal,
    JSON.stringify(hostLine),
  );
  check(
    "guest-drawn line uses the guest color, heavy + vertical",
    !!guestLine && guestLine.width === DRAWN_STROKE && guestLine.vertical,
    JSON.stringify(guestLine),
  );
  check(
    "exactly the two drawn edges read as claimed (no false claims)",
    claimed.length === 2 && openLines.length === board.lines.length - 2,
    `claimed=${claimed.length} open=${openLines.length} total=${board.lines.length}`,
  );
  check(
    "every open edge is a faint neutral ghost, never a player color",
    openLines.every((l) => l.width < DRAWN_STROKE),
    `maxOpenWidth=${Math.max(...openLines.map((l) => l.width))}`,
  );

  // ── Claimed boxes carry the owner's pfp, not a letter ───────────────────
  check(
    "claimed boxes show owner pfp icons instead of letter glyphs",
    board.images.includes("/icons/gryndicon1.webp") &&
      board.images.includes("/icons/gryndicon2.webp") &&
      board.texts.length === 0,
    `images=${JSON.stringify(board.images)} texts=${JSON.stringify(board.texts)}`,
  );

  // ── vs AI: the guest box mark is the GRYND logo (no icon key) ───────────
  const aiBoard = await renderBoard({ ...CLAIMED_PROPS, hostIconKey: "gryndicon1", guestIconKey: null, isAiGame: true });
  check(
    "AI-claimed box shows the GRYND logo, host box keeps the pfp",
    aiBoard.images.includes(AI_LOGO_SRC) && aiBoard.images.includes("/icons/gryndicon1.webp"),
    JSON.stringify(aiBoard.images),
  );

  // ── Legend: the color key under the board ───────────────────────────────
  // The legend's whole job is "which color is whose", so it is checked against
  // the colors the BOARD actually rendered — not against the constants — and
  // each seat must carry the same mark as its claimed boxes (pfp, or the GRYND
  // logo for the AI seat).
  const LEGEND_PROPS = {
    label: "Claimed lines",
    hostName: "HostPlayer",
    guestName: "GRYND AI",
    hostIconKey: "gryndicon1",
    guestIconKey: null,
    isAiGame: true,
    selfSeat: "host",
    hostColor: HOST_COLOR,
    guestColor: GUEST_COLOR,
  };
  await page.evaluate(
    (p) => window.renderBoardWithLegend(p),
    {
      board: {
        ...CLAIMED_PROPS,
        hostIconKey: "gryndicon1",
        guestIconKey: null,
        isAiGame: true,
      },
      legend: LEGEND_PROPS,
    },
  );
  await page.waitForFunction(() => document.querySelector('[data-testid="dnb-color-legend"]'));

  const legend = await page.evaluate(() => {
    const attr = (sel, name) =>
      document.querySelector(sel)?.getAttribute(name) ?? null;
    const chip = (seat) => {
      const el = document.querySelector(`[data-testid="dnb-legend-${seat}"]`);
      if (!el) return null;
      return {
        self: el.getAttribute("data-self"),
        text: el.textContent,
        icon: el.querySelector("img")?.getAttribute("src") ?? null,
      };
    };
    // Scope to the BOARD svg: the legend contributes an svg of its own.
    const boardSvg = document.querySelector('[data-testid="dnb-board"]');
    return {
      label: document
        .querySelector('[data-testid="dnb-color-legend"]')
        ?.textContent,
      hostSwatch: attr('[data-testid="dnb-legend-swatch-host"]', "stroke"),
      guestSwatch: attr('[data-testid="dnb-legend-swatch-guest"]', "stroke"),
      swatchWidth: Number(
        attr('[data-testid="dnb-legend-swatch-host"]', "stroke-width"),
      ),
      chip: { host: chip("host"), guest: chip("guest") },
      // The AI seat renders a raw <img> (the logo), unlike the pfp seats which
      // go through IconAvatar's sized wrapper — so it needs its own size
      // utility or it would blow up to the asset's intrinsic 612×408.
      guestMarkClass: document
        .querySelector('[data-testid="dnb-legend-guest"] img')
        ?.getAttribute("class"),
      chipCount: document.querySelectorAll(
        '[data-testid="dnb-legend-host"], [data-testid="dnb-legend-guest"]',
      ).length,
      boardClaimedColors: [
        ...(boardSvg?.querySelectorAll("line") ?? []),
      ]
        .map((el) => el.getAttribute("stroke"))
        // Same ghost test as GHOST_RE — re-declared here because this callback
        // runs in the browser, where module scope isn't available.
        .filter((s) => s && !/^rgba\(148, 163, 184/.test(s)),
      boardImages: [...(boardSvg?.querySelectorAll("image") ?? [])].map((el) =>
        el.getAttribute("href"),
      ),

    };
  });

  check(
    "legend swatches are exactly the colors the board painted claimed lines with",
    legend.hostSwatch === HOST_COLOR &&
      legend.guestSwatch === GUEST_COLOR &&
      new Set(legend.boardClaimedColors).has(legend.hostSwatch) &&
      new Set(legend.boardClaimedColors).has(legend.guestSwatch),
    `swatches=${legend.hostSwatch}/${legend.guestSwatch} board=${JSON.stringify(legend.boardClaimedColors)}`,
  );
  check(
    "legend names both seats",
    (legend.label || "").includes("Claimed lines") &&
      (legend.chip.host?.text || "").includes("HostPlayer") &&
      (legend.chip.guest?.text || "").includes("GRYND AI"),
    JSON.stringify(legend.chip),
  );
  check(
    "legend marks each seat with the same icon its claimed boxes use (AI = GRYND logo)",
    legend.chip.host?.icon === "/icons/gryndicon1.webp" &&
      legend.chip.guest?.icon === AI_LOGO_SRC &&
      legend.boardImages.includes(AI_LOGO_SRC),
    `host=${legend.chip.host?.icon} guest=${legend.chip.guest?.icon} board=${JSON.stringify(legend.boardImages)}`,
  );
  check(
    "the viewer's own seat chip is outlined, the opponent's is not",
    legend.chip.host?.self === "true" && legend.chip.guest?.self === "false",
    `host=${legend.chip.host?.self} guest=${legend.chip.guest?.self}`,
  );
  check(
    "legend shows exactly one chip per seat, swatch drawn at the claimed weight",
    legend.chipCount === 2 && legend.swatchWidth === 4,
    `chips=${legend.chipCount} swatchWidth=${legend.swatchWidth}`,
  );
  check(
    "the AI seat's logo mark is size-constrained (raw <img>, not an avatar wrapper)",
    /\bh-4\b/.test(legend.guestMarkClass || "") &&
      /\bw-4\b/.test(legend.guestMarkClass || "") &&
      (legend.guestMarkClass || "").includes("object-contain"),
    legend.guestMarkClass,
  );

  const loads = await page.evaluate(async (urls) => {
    const out = {};
    for (const u of urls) {
      try {
        out[u] = (await fetch(u)).status;
      } catch (err) {
        out[u] = String(err);
      }
    }
    return out;
  }, [AI_LOGO_SRC, "/icons/gryndicon1.webp"]);
  check(
    "mark assets resolve (200)",
    loads[AI_LOGO_SRC] === 200 && loads["/icons/gryndicon1.webp"] === 200,
    JSON.stringify(loads),
  );

  // ── Legacy row (no ownership recorded) still reads as "taken" ───────────
  const legacy = await renderBoard({
    drawnH: ["0,0"],
    drawnV: [],
    boxes: [],
    boxOwners: {},
    player1Color: HOST_COLOR,
    player2Color: GUEST_COLOR,
  });
  const legacyDrawn = legacy.lines.filter((l) => !GHOST_RE.test(String(l.stroke)));
  check(
    "an edge with no recorded owner renders as neutral 'taken' at full weight",
    legacyDrawn.length === 1 && legacyDrawn[0].stroke === UNKNOWN_COLOR && legacyDrawn[0].width === DRAWN_STROKE,
    JSON.stringify(legacyDrawn),
  );

  await browser.close();
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
