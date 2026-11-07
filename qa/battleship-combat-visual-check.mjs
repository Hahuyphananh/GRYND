// qa/battleship-combat-visual-check.mjs
//
// Visual + layout verification for the COMBAT screen:
//
//   * both 14×10 boards are stacked, close together, and sized so the player's
//     fleet, the enemy waters and the Lock button are all on the first screen —
//     no scrolling to reach the enemy board;
//   * the boards fit their cards without a horizontal scroll on phone or
//     desktop, and all 140 cells stay square and tappable;
//   * the viewer's own six ships are drawn, and only on their board.
//
// The screen is mounted from the REAL BattlePreview
// (qa/battleship-combat-visual-harness.jsx) with a server-shaped MatchView,
// bundled with the project's REAL Tailwind stylesheet. Only the mascot and the
// translation hook are stubbed — they need providers this page does not mount.
//
// Checks per viewport (390×844 phone, 1280×800 laptop):
//   1. the page does not scroll sideways;
//   2. both boards sit inside the viewport and their cards;
//   3. the boards are STACKED with a small gap, not side by side;
//   4. the enemy board and the Lock control are fully inside the first screen;
//   5. all 140 cells are drawn, square, and at least 20px;
//   6. neither board scrolls sideways, and column N is visible without a swipe;
//   7. the viewer's own six ships are drawn on their board;
//   8. no console / page errors.
//
// Screenshots: qa/reports/battleship-combat/.
//
// Run: node qa/battleship-combat-visual-check.mjs

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, createReadStream } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(root, "qa/reports/battleship-combat");
mkdirSync(SHOTS, { recursive: true });
const outDir = mkdtempSync(join(tmpdir(), "grynd-bs-combat-"));

// Providers this harness does not mount: the mascot and the language context.
const STUBS = {
  "components/mascot/GlitchSay": `
    export default function GlitchSay() { return null; }
  `,
  "hooks/useTranslation": `
    export function useTranslation() {
      return { t: (key, fallback) => (typeof fallback === "string" ? fallback : key), language: "en" };
    }
  `,
  // Next's client entry points pull in bundled Node shims the browser build
  // cannot resolve; the result card only needs the hooks' shape.
  "next-stub": `
    const Link = ({ children, ...rest }) => <a {...rest}>{children}</a>;
    export default Link;
    export { Link };
    export function useRouter() { return { push() {}, replace() {}, refresh() {}, back() {} }; }
    export function usePathname() { return "/"; }
    export function useSearchParams() { return new URLSearchParams(); }
    export function useParams() { return {}; }
    export function cookies() { return { get() {}, getAll: () => [], has: () => false, set() {}, delete() {} }; }
    export function headers() { return new Headers(); }
    export function draftMode() { return { isEnabled: false, enable() {}, disable() {} }; }
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
  entryPoints: [join(root, "qa/battleship-combat-visual-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "bs-combat-stubs",
      setup(build) {
        build.onResolve({ filter: /^next(\/|$)/ }, () => ({ path: "next-stub", namespace: "bs-stub" }));
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "bs-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "bs-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

const globals = readFileSync(join(root, "src/app/globals.css"), "utf8").replace(
  /@import url\([^)]*\);\s*/g,
  "",
);
const generated = await postcss([
  tailwindcss(join(root, "tailwind.config.js")),
  autoprefixer(),
]).process(globals, { from: join(root, "src/app/globals.css") });
writeFileSync(join(outDir, "app.css"), generated.css);
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);
console.log(`compiled stylesheet: ${(generated.css.length / 1024).toFixed(0)}KB\n`);

// Serve the harness over HTTP so the ship art (a public URL) actually loads.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const path = [
    join(outDir, url === "/" ? "index.html" : url.slice(1)),
    join(root, "public", url.slice(1)),
  ].find((candidate) => existsSync(candidate));
  if (!path) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
  createReadStream(path).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const base = `http://127.0.0.1:${server.address().port}/`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};
const px = (value) => (value == null ? "?" : `${Math.round(value * 10) / 10}px`);

const browser = await chromium
  .launch({ channel: "chrome" })
  .catch(() => chromium.launch());

// ── 1. The card art, rendered on its own ───────────────────────────────────
const art = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await art.goto(pathToFileURL(join(root, "src/images/battleship-card.svg")).href);
await art.waitForTimeout(300);
await art.screenshot({ path: join(SHOTS, "battleship-card.png") });
const artMetrics = await art.evaluate(() => {
  const svg = document.querySelector("svg");
  const svgBox = svg.getBoundingClientRect();
  return {
    boards: [...svg.querySelectorAll('rect[width="523"][height="383"]')].length,
    labels: [...svg.querySelectorAll("text")].map((node) => node.textContent.trim()),
    width: Math.round(svgBox.width),
    height: Math.round(svgBox.height),
  };
});
check(
  "card art: two 14×10 boards are drawn at 1200×630",
  artMetrics.boards === 2 && artMetrics.width === 1200 && artMetrics.height === 630,
  `${artMetrics.boards} boards, ${artMetrics.width}×${artMetrics.height}`,
);
check(
  "card art: the board is labelled to column N",
  artMetrics.labels.includes("A") && artMetrics.labels.includes("N"),
  artMetrics.labels.filter((label) => label.length === 1).join(""),
);
await art.close();

// ── 2. The combat screen ───────────────────────────────────────────────────
const errors = [];
const mount = async (width, height, dpr) => {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    hasTouch: width < 640,
  });
  page.on("pageerror", (error) => errors.push(`pageerror(${width}): ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource|fonts\.googleapis|net::ERR/.test(message.text())) return;
    errors.push(`console(${width}): ${message.text()}`);
  });
  await page.goto(base);
  await page.waitForFunction(() => !!window.__bsc?.mount, null, { timeout: 20000 });
  await page.evaluate(() => window.__bsc.mount());
  await page.waitForSelector('[data-testid="enemy-waters-cell-A1"]', { timeout: 15000 });
  await page.waitForTimeout(500);
  return page;
};

for (const vp of [
  { label: "390", width: 390, height: 844, dpr: 3 },
  { label: "1280", width: 1280, height: 800, dpr: 1 },
]) {
  const page = await mount(vp.width, vp.height, vp.dpr);
  const m = await page.evaluate(() => window.__bsc.measure());
  const tag = `${vp.label} combat`;
  const floor = 20;
  const gap = m.cards?.myFleet && m.cards?.enemy ? m.cards.enemy.top - m.cards.myFleet.bottom : null;

  console.log(
    `\n▸ ${vp.label}×${vp.height}: fleet board ${px(m.myFleet?.width)} ` +
      `(top ${px(m.myFleet?.top)}), enemy board ${px(m.enemy?.width)} (top ${px(m.enemy?.top)}), ` +
      `cell ${px(m.cellWidth)}, card gap ${px(gap)}, boards wrapper ${px(m.boards?.width)} ` +
      `(max-width ${m.boards?.maxWidth})`,
  );

  check(
    `${tag}: the page does not scroll sideways`,
    m.documentScrollWidth <= m.documentClientWidth + 1,
    `document ${m.documentScrollWidth}/${m.documentClientWidth}`,
  );

  check(
    `${tag}: both boards sit inside the viewport and their cards`,
    [m.myFleet, m.enemy].every(
      (strip) => strip !== null && strip.left >= -1 && strip.right <= m.viewportWidth + 1,
    ),
    `fleet ${px(m.myFleet?.left)}..${px(m.myFleet?.right)}, enemy ${px(m.enemy?.left)}..${px(m.enemy?.right)} of ${px(m.viewportWidth)}`,
  );

  check(
    `${tag}: the boards are stacked close together, not side by side`,
    m.cards?.myFleet != null &&
      m.cards?.enemy != null &&
      m.cards.enemy.top >= m.cards.myFleet.bottom - 1 &&
      gap !== null &&
      gap <= 16,
    `fleet card bottom ${px(m.cards?.myFleet?.bottom)}, enemy card top ${px(m.cards?.enemy?.top)}, gap ${px(gap)}`,
  );

  check(
    `${tag}: the enemy board is fully on the first screen`,
    m.cards?.enemy != null && m.cards.enemy.bottom <= m.viewportHeight + 1 && m.cards.enemy.top >= -1,
    `enemy card ${px(m.cards?.enemy?.top)}..${px(m.cards?.enemy?.bottom)} of ${px(m.viewportHeight)}`,
  );

  check(
    `${tag}: all 140 cells are drawn, square and at least ${floor}px`,
    m.enemyCells === 140 &&
      Math.abs(m.cellWidth - m.cellHeight) <= 1.5 &&
      m.cellWidth >= floor,
    `${m.enemyCells} cells, ${px(m.cellWidth)}×${px(m.cellHeight)} (floor ${floor}px)`,
  );

  check(
    `${tag}: neither board scrolls sideways`,
    [m.myFleet, m.enemy].every(
      (strip) => strip !== null && strip.scrollWidth <= strip.clientWidth + 1,
    ),
    `fleet ${px(m.myFleet?.scrollWidth)}/${px(m.myFleet?.clientWidth)}, enemy ${px(m.enemy?.scrollWidth)}/${px(m.enemy?.clientWidth)}`,
  );

  check(
    `${tag}: column N is visible without scrolling`,
    m.lastCell !== null &&
      m.enemy !== null &&
      m.lastCell.right <= m.enemy.right + 1 &&
      m.lastCell.right <= m.viewportWidth + 1,
    `N1 ${px(m.lastCell?.left)}..${px(m.lastCell?.right)} in strip ${px(m.enemy?.left)}..${px(m.enemy?.right)}`,
  );

  check(
    `${tag}: the viewer's own six ships are drawn on their board`,
    m.ownShipSprites === 6,
    `${m.ownShipSprites} ship sprites`,
  );

  check(
    `${tag}: the lock control is fully on the first screen`,
    m.locked !== null &&
      m.locked.left >= -1 &&
      m.locked.right <= m.viewportWidth + 1 &&
      m.locked.bottom <= m.viewportHeight + 1,
    `lock ${px(m.locked?.left)}..${px(m.locked?.right)}, bottom ${px(m.locked?.bottom)} of ${px(m.viewportHeight)}`,
  );

  await page.screenshot({ path: join(SHOTS, `${vp.label}-combat.png`) });
  await page.screenshot({ path: join(SHOTS, `${vp.label}-combat-full.png`), fullPage: true });
  await page.close();
}

check("no console / page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
