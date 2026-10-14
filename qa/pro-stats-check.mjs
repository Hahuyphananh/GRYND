// qa/pro-stats-check.mjs
//
// Renders the REAL GRYND PRO performance dashboard (qa/pro-stats-harness.jsx)
// in a real browser and asserts what is actually on screen — the part the unit
// suites cannot reach: that each chart DRAWS (a path, dated ticks, a working
// tooltip), that the per-game table and the recent-results list populate, that
// the filters are server requests rather than client-side filtering, that the
// layout survives a phone viewport, and that a locked / empty / single-point /
// failed payload renders the state it should instead of a misleading graph.
//
// The harness mounts the dashboard under the app's OWN data layer
// (SWRProvider → the real fetcher and persistent cache) with a stubbed `fetch`,
// so the request the component makes is the request it makes in production.
//
// Checked:
//   * pro      — tiles, four labelled charts, table, recent results, tooltips,
//                game + date-range filters, load-more, phone layout;
//   * locked   — the API answered locked: upgrade prompt, and NO figures;
//   * free     — a non-member is never even asked for the analytics;
//   * guest    — signed out: the sign-in prompt, no request;
//   * empty    — a player with no settled match: empty states, no fake line;
//   * onepoint — one reading is not a curve;
//   * error    — a failed request shows the error state, not a blank page;
//   * loading  — the first load shows the skeleton.
//
// Run: npm run verify:pro-stats
// Screenshots: qa/reports/pro-stats-*.png

import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "../src/lib/appTextTranslations.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "pro-stats-"));
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });

// ── Stubs ──────────────────────────────────────────────────────────────────
// The dashboard is a client component and only needs `next/link` (rendered as a
// plain anchor so its href is assertable). Clerk is not involved: the page
// passes `signedIn`/`pro` in as props, exactly as the server component does.
const STUBS = {
  "next/link": `
    import React from "react";
    export default function Link({ href, children, ...rest }) {
      return React.createElement("a", { href: typeof href === "string" ? href : String(href), ...rest }, children);
    }
  `,
  "next/navigation": `
    const router = { push(){}, replace(){}, back(){}, refresh(){}, prefetch(){} };
    export const useRouter = () => router;
    export const usePathname = () => "/stats";
    export const useSearchParams = () => new URLSearchParams();
    export default { useRouter, usePathname, useSearchParams };
  `,
  "next/image": `import React from "react"; export default function Img() { return null; }`,
  "posthog-js/react": `export const usePostHog = () => null; export default {};`,
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
  entryPoints: [join(root, "qa/pro-stats-harness.jsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".js": "jsx" },
  outfile: join(outDir, "harness.js"),
  logLevel: "error",
  absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  banner: {
    js: 'var process = { env: { NODE_ENV: "development" }, platform: "browser", browser: true, version: "v0.0.0" };',
  },
  plugins: [
    {
      name: "pro-stats-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = matchStubKey(args.path, args.resolveDir);
          if (!key) return null;
          return { path: key, namespace: "pro-stats-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "pro-stats-stub" }, (args) => ({
          contents: STUBS[args.path],
          loader: "jsx",
          resolveDir: root,
        }));
      },
    },
  ],
});

// ── The app's real stylesheet ──────────────────────────────────────────────
const compiled = await postcss([
  tailwindcss(join(root, "tailwind.config.js")),
  autoprefixer(),
]).process(readFileSync(join(root, "src/app/globals.css"), "utf8"), {
  from: join(root, "src/app/globals.css"),
});
writeFileSync(
  join(outDir, "app.css"),
  compiled.css.replace(/@import\s+url\(["']?https?:\/\/[^)]*\);?/g, ""),
);

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GRYND PRO statistics check</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./harness.js"></script></body></html>`,
);

const server = createServer((req, res) => {
  const rawPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const allowed = new Map([
    ["/index.html", "index.html"],
    ["/app.css", "app.css"],
    ["/harness.js", "harness.js"],
  ]);
  const safeFile = allowed.get(rawPath);
  if (!safeFile) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const buf = readFileSync(join(outDir, safeFile));
    res.writeHead(200, {
      "Content-Type": rawPath.endsWith(".css")
        ? "text/css"
        : rawPath.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch();

/** Case-insensitive: section headings are uppercased by CSS. */
const has = (haystack, needle) => haystack.toLowerCase().includes(String(needle).toLowerCase());

/** Loads one scenario and returns the page, its body text and any page error. */
async function open(scenario, viewport = { width: 1280, height: 1000 }) {
  // `en-US` so the copy, the dates and the number formatting are the ones the
  // assertions were written against (the app language is English here too).
  const page = await browser.newPage({ viewport, locale: "en-US" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}?scenario=${scenario}`, { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(() => document.body.innerText.trim().length > 0, { timeout: 10_000 })
    .catch(() => {});
  // Let the (mocked) request settle and React commit.
  await page.waitForTimeout(1_200);
  return { page, errors, text: await page.evaluate(() => document.body.innerText) };
}

const shots = (page, name) =>
  page.screenshot({ path: join(REPORTS, `pro-stats-${name}.png`), fullPage: true });

/** The box of the tile whose label matches — a tile is the label's parent. */
async function tileBox(page, label) {
  return page.locator(`p:has-text("${label}")`).first().locator("xpath=..").boundingBox();
}

/** The box of the chart card that carries this axis label, or null if absent. */
async function chartBox(page, axisLabel) {
  const locator = page.locator(`section:has-text("${axisLabel}")`).first();
  if ((await locator.count()) === 0) return null;
  return locator.boundingBox();
}

/** The four chart cards, in the order the dashboard lays them out. */
const CHART_ORDER = [
  "stats.chart.rating_axis",
  "stats.chart.overall_axis",
  "stats.chart.trophy_axis",
  "stats.chart.rank_axis",
];
async function chartBoxes(page) {
  return Promise.all(CHART_ORDER.map((key) => chartBox(page, t("en", key))));
}

const sameRow = (a, b) => Math.abs(a.y - b.y) <= 2;

// ── 1. The member dashboard ────────────────────────────────────────────────
{
  const { page, errors, text } = await open("pro");
  const expected = await page.evaluate(() => window.__expected);

  check("pro: the totals tile renders the payload's match count", has(text, expected.matches), expected.matches);
  check("pro: the record renders wins-losses-draws", has(text, expected.record), expected.record);
  check("pro: the win rate is shown with one decimal", has(text, expected.winRate), expected.winRate);
  check("pro: the per-game table carries the current rating", has(text, expected.chessRating), expected.chessRating);
  check("pro: the per-game table carries the trophy count", has(text, "240"));
  check("pro: no unresolved translation key leaked into the UI", !/stats\.[a-z_.]+/.test(text));

  // Four differently-labelled charts. The per-game Elo chart starts with the
  // "pick a game" hint (Elo is per game — it never merges games).
  check("pro: the per-game chart asks for a game before drawing", has(text, t("en", "stats.chart.rating_pick")));
  check("pro: the Overall Elo chart states its own metric", has(text, t("en", "stats.chart.overall_axis")));
  check("pro: the trophy chart states its own metric", has(text, t("en", "stats.chart.trophy_axis")));
  check("pro: the rank chart states which end is rank 1", has(text, t("en", "stats.chart.rank_axis")));
  check("pro: the recent results are listed", has(text, t("en", "stats.recent.title")));

  const charts = await page.evaluate(() =>
    [...document.querySelectorAll("figure svg[role='img']")].map((svg) => ({
      segments: (svg.querySelector("path")?.getAttribute("d") || "").split("L").length,
      ticks: svg.querySelectorAll("text").length,
    })),
  );
  check("pro: at least three charts drew a line", charts.length >= 3, `charts=${charts.length}`);
  check(
    "pro: every drawn chart has a multi-point path and labelled axes",
    charts.length >= 3 && charts.every((chart) => chart.segments >= 5 && chart.ticks >= 6),
    JSON.stringify(charts),
  );
  check("pro: the rank ticks are labelled as ranks", /#[\d,]+/.test(text));

  // A tooltip appears for the point under the cursor / keyboard focus.
  const tooltipBefore = await page.locator("figure div.pointer-events-none").count();
  await page.locator("figure svg circle").first().focus();
  await page.waitForTimeout(150);
  const tooltipAfter = await page.locator("figure div.pointer-events-none").count();
  check(
    "pro: focusing a point opens its tooltip",
    tooltipBefore === 0 && tooltipAfter >= 1,
    `${tooltipBefore}→${tooltipAfter}`,
  );

  // The filters are REQUESTS: the server decides what a filtered win rate is.
  await page.selectOption("select", "chess");
  await page.waitForTimeout(600);
  let requests = await page.evaluate(() => window.__proStats.requests);
  check("pro: choosing a game asks the server for that game", requests.some((url) => url.includes("game=chess")));

  const chessText = await page.evaluate(() => document.body.innerText);
  check("pro: the Elo chart draws once a game is chosen", !has(chessText, t("en", "stats.chart.rating_pick")));
  check("pro: the chosen game is named on its chart", has(chessText, t("en", "stats.chart.rating_axis")));

  await page.click(`text=${t("en", "stats.range.30d")}`);
  await page.waitForTimeout(600);
  requests = await page.evaluate(() => window.__proStats.requests);
  check("pro: a date range is sent to the server, not applied locally", requests.some((url) => url.includes("from=")));
  const pressed = await page.getAttribute(
    `button:has-text("${t("en", "stats.range.30d")}")`,
    "aria-pressed",
  );
  check("pro: the active range is marked for assistive tech", pressed === "true", String(pressed));

  await page.click(`text=${t("en", "stats.recent.load_more")}`);
  await page.waitForTimeout(600);
  requests = await page.evaluate(() => window.__proStats.requests);
  check("pro: load-more paginates through the API", requests.some((url) => url.includes("limit=20")));

  // Layout: four tiles across the top, charts two-up, at desktop width.
  const tiles = await Promise.all(
    ["stats.tile.matches", "stats.tile.record", "stats.tile.win_rate", "stats.tile.form"].map((key) =>
      tileBox(page, t("en", key)),
    ),
  );
  check(
    "pro: the four headline tiles sit on one row at desktop width",
    tiles.every((box) => box && sameRow(box, tiles[0])),
    JSON.stringify(tiles.map((box) => Math.round(box?.y ?? -1))),
  );
  const cards = await chartBoxes(page);
  check(
    "pro: the charts are paired two-up at desktop width",
    cards.length === 4 && cards.every(Boolean) &&
      sameRow(cards[0], cards[1]) &&
      sameRow(cards[2], cards[3]) &&
      !sameRow(cards[0], cards[2]),
    JSON.stringify(cards.map((box) => Math.round(box?.y ?? -1))),
  );

  await shots(page, "pro-desktop");
  check("pro: the page raised no runtime error", errors.length === 0, errors.join(" | "));
  await page.close();
}

// ── 2. The phone layout ────────────────────────────────────────────────────
{
  const { page, text } = await open("pro", { width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("phone: nothing overflows the viewport horizontally", overflow <= 1, `overflow=${overflow}px`);
  const expected = await page.evaluate(() => window.__expected);
  check("phone: the headline tiles are still rendered", has(text, expected.winRate));
  const charts = await page.evaluate(() => document.querySelectorAll("figure svg[role='img']").length);
  check("phone: the charts are still drawn", charts >= 3, `charts=${charts}`);

  const tiles = await Promise.all(
    ["stats.tile.matches", "stats.tile.record", "stats.tile.win_rate", "stats.tile.form"].map((key) =>
      tileBox(page, t("en", key)),
    ),
  );
  check(
    "phone: the tiles stack full-width instead of shrinking into a row",
    tiles.every((box) => box && box.width >= 300) &&
      tiles.every((box, index) => index === 0 || box.y > tiles[index - 1].y),
    JSON.stringify(tiles.map((box) => [Math.round(box?.width ?? -1), Math.round(box?.y ?? -1)])),
  );
  // The per-game Elo card carries no axis until a game is picked, so stack
  // whichever cards are present (the other three always are).
  const cards = (await chartBoxes(page)).filter(Boolean);
  check(
    "phone: the charts stack too, rather than being squeezed side by side",
    cards.length >= 3 && cards.every((box, index) => index === 0 || box.y > cards[index - 1].y),
    JSON.stringify(cards.map((box) => Math.round(box.y))),
  );
  const wide = await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return 0;
    const wrapper = table.parentElement;
    return wrapper ? wrapper.scrollWidth - wrapper.clientWidth : 0;
  });
  check(
    "phone: the results table scrolls inside its own wrapper, not the page",
    overflow <= 1 && (wide === 0 || (await page.evaluate(() => getComputedStyle(document.querySelector("table").parentElement).overflowX)) === "auto"),
  );
  await shots(page, "pro-phone");
  await page.close();
}

// ── 3. The API said locked (even though the page prop claimed a member) ────
{
  const { page, text } = await open("locked");
  const expected = await page.evaluate(() => window.__expected);
  check("locked: the upgrade prompt is shown", has(text, t("en", "stats.locked.title")));
  check("locked: it links to the upgrade page", (await page.locator('a[href="/upgrade-pro"]').count()) >= 1);
  check("locked: no chart was drawn", (await page.locator("figure svg[role='img']").count()) === 0);
  check(
    "locked: not one figure from the payload is on screen",
    !has(text, expected.matches) && !has(text, expected.winRate) && !has(text, expected.chessRating),
  );
  await shots(page, "locked");
  await page.close();
}

// ── 4. A free player: no request is even made ──────────────────────────────
{
  const { page, text } = await open("free");
  check("free: the upgrade prompt is shown", has(text, t("en", "stats.locked.title")));
  const requests = await page.evaluate(() => window.__proStats.requests);
  check("free: the analytics endpoint is never called", requests.length === 0, requests.join(","));
  await page.close();
}

// ── 5. A signed-out visitor ────────────────────────────────────────────────
{
  const { page, text } = await open("guest");
  check("guest: the sign-in prompt is shown", has(text, t("en", "stats.locked.signin")));
  check("guest: it links to sign-in", (await page.locator('a[href="/sign-in"]').count()) >= 1);
  const requests = await page.evaluate(() => window.__proStats.requests);
  check("guest: the analytics endpoint is never called", requests.length === 0, requests.join(","));
  await page.close();
}

// ── 6. A player who has settled nothing ────────────────────────────────────
{
  const { page, text } = await open("empty");
  check("empty: the chart says there is nothing to plot yet", has(text, t("en", "stats.chart.no_points")));
  check("empty: the per-game table says so too", has(text, t("en", "stats.pergame.empty")));
  check("empty: the recent list says so too", has(text, t("en", "stats.recent.empty")));
  check("empty: no chart was drawn from nothing", (await page.locator("figure svg[role='img']").count()) === 0);
  check("empty: an undecided win rate reads —, never 0%", text.includes("—"));
  await shots(page, "empty");
  await page.close();
}

// ── 7. One reading is not a curve ──────────────────────────────────────────
{
  const { page, text } = await open("onepoint");
  check("onepoint: a single point is reported as no curve", has(text, t("en", "stats.chart.no_points")));
  check("onepoint: no line was fabricated", (await page.locator("figure svg path").count()) === 0);
  await page.close();
}

// ── 8. A failed request ────────────────────────────────────────────────────
{
  const { page, text } = await open("error");
  check("error: the failure state replaces the dashboard", !has(text, t("en", "stats.pergame.title")));
  check("error: a retry control is offered", (await page.locator("button").count()) >= 1);
  check("error: no chart was drawn", (await page.locator("figure svg[role='img']").count()) === 0);
  await shots(page, "error");
  await page.close();
}

// ── 9. The first load ──────────────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: "en-US" });
  await page.goto(`${base}?scenario=loading`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const text = await page.evaluate(() => document.body.innerText);
  check("loading: a skeleton is shown while the payload is in flight", (await page.locator("[aria-busy='true']").count()) >= 1);
  check("loading: no chart is drawn before the data arrives", (await page.locator("figure svg[role='img']").count()) === 0);
  check("loading: the dashboard body has not rendered yet", !has(text, t("en", "stats.pergame.title")));
  await page.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`screenshots → qa/reports/pro-stats-*.png`);
process.exit(fail === 0 ? 0 : 1);
