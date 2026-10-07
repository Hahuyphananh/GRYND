/**
 * sitemap.test.mjs
 *
 * Guards GRYND's sitemap ARCHITECTURE, not its current contents.
 *
 * The bug this suite exists to prevent: the sitemap used to own a hand-written
 * list of ~21 game objects, each pairing the literal "/games/<slug>" with the
 * table behind it. Adding a game meant editing the sitemap, and forgetting to
 * do so dropped a public page from the crawl silently — which is exactly what
 * happened to Mini Golf, Sudoku Duel, Speed Typing, Tic-Tac-Toe and Solitaire
 * Duel. There is now ONE inventory (src/lib/seoPages.ts) whose game entries are
 * GENERATED from the game catalog (GAME_LANDING_PAGES), and src/app/sitemap.ts
 * is nothing but a projection of it.
 *
 * So the assertions below are about invariants that survive adding a game:
 *
 *   1. SHAPE. Every URL is a root-relative, canonical, absolute-able path with
 *      no duplicates, no query, no hash and no trailing slash.
 *   2. GENERATION. Every game that has a public landing page is in the sitemap,
 *      because the URL is projected from the catalog rather than written down.
 *      Mini Golf and Sudoku Duel are named explicitly, since "one game was
 *      omitted" is precisely the failure mode this refactor removes.
 *   3. EXCLUSIONS. Nothing private is listed: no authenticated /play lobby, no
 *      /casino alias, no /api, no account/admin/auth page, and nothing that is
 *      itself a redirect. Only canonical URLs belong in a sitemap.
 *   4. COVERAGE. Every static route under src/app is either listed, or
 *      deliberately excluded WITH A REASON, or marks itself noindex. A new
 *      public page that nobody classified fails here — which is the only way
 *      "the sitemap is complete" can stay true without a human remembering.
 *
 * Run:  npm run test:sitemap
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  GAME_LANDING_SLUGS,
  gameLandingPath,
} from "../src/lib/gameLandingPages.ts";
import { GUIDES_INDEX_PATH, GUIDE_SLUGS, guidePath } from "../src/lib/guides.ts";
import {
  EXCLUDED_FROM_SITEMAP,
  PUBLIC_SEO_PAGES,
  PUBLIC_SEO_PATHS,
} from "../src/lib/seoPages.ts";

const read = (rel) => readFileSync(rel, "utf8");

const SITEMAP_ROUTE = "src/app/sitemap.ts";
const SEO_INVENTORY = "src/lib/seoPages.ts";
const APP_DIR = "src/app";

/** Games whose omission from the old hand-written list prompted this refactor. */
const MUST_BE_PRESENT = [
  "mini-golf",
  "sudoku-duel",
  "speed-typing",
  "tic-tac-toe",
  "solitaire-duel",
];

// ── Route discovery ───────────────────────────────────────────────────────

function pageFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pageFiles(path));
    else if (/^page\.(js|jsx|ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** "src/app/casino/chess/page.jsx" → "/casino/chess" (route groups removed). */
function routePath(file) {
  // The homepage's page file sits directly in src/app, so the separator is
  // optional — `(^|[\/])` handles both "page.jsx" and "casino/page.jsx".
  const rel = file
    .slice(APP_DIR.length + 1)
    .replace(/(^|[\\/])page\.(js|jsx|ts|tsx)$/, "");
  const segments = rel.split(/[\\/]/).filter((s) => !/^\(.*\)$/.test(s));
  return "/" + segments.join("/");
}

/** Every static (non-dynamic) route the app renders, excluding the API tree. */
function staticRoutes() {
  return pageFiles(APP_DIR)
    .map(routePath)
    .filter((path) => !path.startsWith("/api") && !path.includes("["));
}

/**
 * URLs that RENDER without a page file of their own.
 *
 * The hub is the case in point: there is no src/app/games/page.tsx, because
 * next.config.js rewrites /games to /casino before the router looks for a file.
 * Treating "no page.tsx" as "no route" here would be the wrong conclusion, so
 * the config's rewrite table is part of the rendered set. Dynamic sources
 * (`:slug`) are skipped — they are checked against the game catalog instead.
 */
function rewrittenPaths() {
  const config = read("next.config.js");
  const start = config.indexOf("async rewrites()");
  const end = config.indexOf("async redirects()", start);
  assert.ok(start !== -1 && end > start, "could not locate the rewrite table in next.config.js");
  return [...config.slice(start, end).matchAll(/source:\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((path) => !path.includes(":"));
}

// ── 1. Shape ──────────────────────────────────────────────────────────────

test("shape: every URL is a root-relative canonical path", () => {
  assert.ok(PUBLIC_SEO_PATHS.length >= 30, "expected the full public inventory");
  for (const path of PUBLIC_SEO_PATHS) {
    assert.equal(typeof path, "string", "a path must be a string");
    assert.ok(path.startsWith("/"), `${path} must be root-relative`);
    assert.ok(!path.includes("://"), `${path} must be a path, not an origin`);
    assert.doesNotMatch(path, /[?#]/, `${path} must not carry a query or a hash`);
    assert.doesNotMatch(path, /\/\//, `${path} must not contain a double slash`);
    assert.ok(
      path === "/" || !path.endsWith("/"),
      `${path} must not end in a trailing slash — /games and /games/ are different URLs`,
    );
  }
});

test("shape: no duplicate URLs, and the path list mirrors the page list", () => {
  const seen = new Set();
  for (const path of PUBLIC_SEO_PATHS) {
    assert.equal(seen.has(path), false, `${path} is listed more than once`);
    seen.add(path);
  }
  assert.equal(PUBLIC_SEO_PATHS.length, PUBLIC_SEO_PAGES.length);
  assert.deepEqual(PUBLIC_SEO_PATHS, PUBLIC_SEO_PAGES.map((page) => page.path));
});

test("shape: priorities, change frequencies and groups are valid", () => {
  const frequencies = new Set([
    "always",
    "hourly",
    "daily",
    "weekly",
    "monthly",
    "yearly",
    "never",
  ]);
  for (const page of PUBLIC_SEO_PAGES) {
    assert.ok(page.priority > 0 && page.priority <= 1, `${page.path} priority out of range`);
    assert.ok(frequencies.has(page.changeFrequency), `${page.path} has no valid changeFrequency`);
    assert.ok(
      ["home", "hub", "games", "guides", "info"].includes(page.group),
      `${page.path} has an unknown group`,
    );
  }
  // Exactly one homepage and one hub, and the homepage leads the document.
  assert.equal(PUBLIC_SEO_PAGES.filter((page) => page.group === "home").length, 1);
  assert.equal(PUBLIC_SEO_PAGES.filter((page) => page.group === "hub").length, 1);
  assert.equal(PUBLIC_SEO_PAGES[0].path, "/");
  assert.equal(PUBLIC_SEO_PAGES[0].priority, 1);
  assert.ok(PUBLIC_SEO_PATHS.includes("/games"), "the canonical hub URL is /games");
});

// ── 2. Generation ─────────────────────────────────────────────────────────

test("generation: game URLs are PROJECTED from the catalog, never hand-listed", () => {
  const inventory = read(SEO_INVENTORY);
  assert.match(
    inventory,
    /GAME_LANDING_PAGES\.map/,
    "the inventory must generate its game entries from the catalog",
  );
  assert.match(inventory, /gameLandingPath\(game\.slug\)/);
});

test("generation: the sitemap route is a projection of the inventory", () => {
  const src = read(SITEMAP_ROUTE);
  assert.match(src, /import \{ PUBLIC_SEO_PAGES \} from "\.\.\/lib\/seoPages"/);
  assert.match(src, /PUBLIC_SEO_PAGES\.map/, "the route must emit the inventory, in order");
  // The base URL still comes from the ONE shared resolver (tests/site-url.test.mjs
  // owns the rest of that contract).
  assert.match(src, /getSiteUrl\(\)/);
  // The fragile architecture this replaced must stay gone.
  assert.doesNotMatch(src, /GAME_PAGES\s*[:=]/, "the manual GAME_PAGES list must not come back");
  assert.deepEqual(
    src.match(/"\/games\/[a-z0-9-]+"/g) ?? [],
    [],
    "the sitemap route must not hand-write game URLs",
  );
  assert.doesNotMatch(src, /from "\.\.\/db\/schema"/, "table wiring belongs in the inventory");
});

test("generation: EVERY game landing page is listed — Mini Golf and Sudoku Duel included", () => {
  const listed = new Set(PUBLIC_SEO_PATHS);
  const missing = GAME_LANDING_SLUGS.filter((slug) => !listed.has(gameLandingPath(slug)));
  assert.deepEqual(missing, [], "a game with a public landing page is missing from the sitemap");

  // Named explicitly: an omission here should report the game, not a 21-string diff.
  for (const slug of MUST_BE_PRESENT) {
    assert.ok(listed.has(`/games/${slug}`), `/games/${slug} must be in the sitemap`);
  }

  // Exactly one URL per game, and the hub is not one of them.
  const gamePaths = PUBLIC_SEO_PATHS.filter((path) => path.startsWith("/games/"));
  assert.equal(gamePaths.length, GAME_LANDING_SLUGS.length);
  assert.equal(PUBLIC_SEO_PAGES.filter((page) => page.group === "games").length, GAME_LANDING_SLUGS.length);
});

test("generation: EVERY guide is listed — the index and all twelve articles", () => {
  const listed = new Set(PUBLIC_SEO_PATHS);
  assert.ok(listed.has(GUIDES_INDEX_PATH), `${GUIDES_INDEX_PATH} must be in the sitemap`);
  for (const slug of GUIDE_SLUGS) {
    assert.ok(listed.has(guidePath(slug)), `${guidePath(slug)} must be in the sitemap`);
  }
  // Exactly one index and one entry per guide, all in the guides group.
  const guidePaths = PUBLIC_SEO_PAGES.filter((page) => page.group === "guides").map(
    (page) => page.path,
  );
  assert.equal(
    guidePaths.length,
    GUIDE_SLUGS.length + 1,
    "the guides group must hold the index plus one entry per guide",
  );
  assert.equal(new Set(guidePaths).size, guidePaths.length, "a guide is listed twice");
});

test("generation: freshness hints are well-formed and never gate a URL", () => {
  const games = PUBLIC_SEO_PAGES.filter((page) => page.group === "games");
  for (const page of games) {
    if (!page.freshness) continue;
    assert.ok(page.freshness.table, `${page.path} freshness needs a table`);
    assert.ok(page.freshness.column, `${page.path} freshness needs a column`);
  }
  // The two UNO-family URLs share one match table; the hint is scoped to each
  // page, so neither can be dropped by the other's absence.
  for (const path of ["/games/uno", "/games/neon-flush"]) {
    assert.ok(PUBLIC_SEO_PATHS.includes(path), `${path} must be listed`);
  }
});

// ── 3. Exclusions ─────────────────────────────────────────────────────────

test("exclusions: no authenticated, private or API URL is listed", () => {
  const banned = [
    /^\/api(\/|$)/,
    /^\/admin(\/|$)/,
    /^\/profil(\/|$)/,
    /^\/settings$/,
    /^\/sync$/,
    /^\/welcome(\/|$)/,
    /^\/sign-in(\/|$)/,
    /^\/sign-up(\/|$)/,
    /^\/complete-profile$/,
    /^\/mfa-required$/,
    /^\/access-denied$/,
    /^\/maintenance$/,
    /^\/thank-you$/,
    /^\/sentry-example-page$/,
    /^\/evaluation(\/|$)/,
  ];
  for (const path of PUBLIC_SEO_PATHS) {
    for (const pattern of banned) {
      assert.doesNotMatch(path, pattern, `${path} is a private/authenticated URL`);
    }
  }
});

test("exclusions: no /play lobby and no /casino alias is listed", () => {
  for (const path of PUBLIC_SEO_PATHS) {
    assert.doesNotMatch(
      path,
      /\/play$/,
      `${path} is the noindex authenticated lobby — the landing page is the indexable URL`,
    );
    assert.ok(
      !path.startsWith("/casino"),
      `${path} is in the app namespace; the canonical public namespace is /games`,
    );
  }
});

test("canonical: no listed URL is itself a redirect", () => {
  const config = read("next.config.js");
  const start = config.indexOf("async redirects()");
  const end = config.indexOf("async headers()", start);
  assert.ok(start !== -1 && end > start, "could not locate the redirect table in next.config.js");

  const sources = [...config.slice(start, end).matchAll(/source:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sources.length >= 10, `expected the redirect table, parsed ${sources.length} sources`);

  for (const path of PUBLIC_SEO_PATHS) {
    assert.equal(
      sources.includes(path),
      false,
      `${path} 308-redirects, so listing it would send crawlers through a redirect`,
    );
  }
  // The specific alias this rule exists for.
  assert.ok(sources.includes("/casino"), "/casino → /games is the alias that must stay out");
});

test("exclusions: every excluded path is a real route with a stated reason", () => {
  const routes = new Set(staticRoutes());
  for (const [path, reason] of Object.entries(EXCLUDED_FROM_SITEMAP)) {
    assert.ok(routes.has(path), `${path} is excluded but no page renders it`);
    assert.equal(PUBLIC_SEO_PATHS.includes(path), false, `${path} cannot be listed and excluded`);
    assert.equal(typeof reason, "string");
    assert.ok(reason.trim().length >= 20, `${path} needs a real reason, not a placeholder`);
  }
});

// ── 4. Coverage — the drift guard ─────────────────────────────────────────

test("coverage: every static route is listed, excluded, or noindex", () => {
  const listed = new Set(PUBLIC_SEO_PATHS);
  const excluded = new Set(Object.keys(EXCLUDED_FROM_SITEMAP));

  const unexplained = [];
  for (const path of staticRoutes()) {
    if (listed.has(path) || excluded.has(path)) continue;
    // A page that declares `robots: { index: false }` has already answered the
    // question — the lobbies, the account/admin/auth pages and the match
    // instances all do this, so they need no entry in the inventory.
    if (/index:\s*false/.test(read(routeFile(path)))) continue;
    unexplained.push(path);
  }

  assert.deepEqual(
    unexplained,
    [],
    "these routes are public and indexable but are neither in the sitemap nor excluded with a reason",
  );
});

test("coverage: the sitemap lists nothing that no route renders", () => {
  const routes = new Set([...staticRoutes(), ...rewrittenPaths()]);
  // The exemption above is verified rather than assumed: /games really is a
  // rewrite target, and it really does land on a route that exists.
  assert.ok(
    rewrittenPaths().includes("/games"),
    "/games must be a config rewrite — that is why it has no page file",
  );
  assert.ok(staticRoutes().includes("/casino"), "/games must rewrite to a real route");
  // The guide index is a real page file, not a rewrite — assert it, so a guide
  // path in the sitemap is never justified by an exemption alone.
  assert.ok(staticRoutes().includes(GUIDES_INDEX_PATH), "/guides must be a real route");

  for (const path of PUBLIC_SEO_PATHS) {
    if (path === "/") {
      assert.ok(routes.has("/"), "the homepage route must exist");
      continue;
    }
    // Game landing pages are dynamic (/games/[slug]) and enumerated by
    // GAME_LANDING_SLUGS, which the generation tests above already check.
    if (GAME_LANDING_SLUGS.some((slug) => gameLandingPath(slug) === path)) continue;
    // Guide articles are dynamic (/guides/[slug]) and enumerated by GUIDE_SLUGS
    // for the same reason — the generation test above owns that contract.
    if (GUIDE_SLUGS.some((slug) => guidePath(slug) === path)) continue;
    assert.ok(
      routes.has(path),
      `${path} is in the sitemap but no static route renders it`,
    );
  }
});

test("coverage: /help and /about are not invented", () => {
  const routes = new Set(staticRoutes());
  for (const path of ["/help", "/about"]) {
    assert.equal(routes.has(path), false, `${path} exists now — decide its SEO role explicitly`);
    assert.equal(PUBLIC_SEO_PATHS.includes(path), false, `${path} does not exist and must not be listed`);
  }
  assert.ok(PUBLIC_SEO_PATHS.includes("/faq"), "/faq is GRYND's help surface");
});

/** The page file that renders a static route path. */
function routeFile(path) {
  const rel = path === "/" ? "" : path.slice(1);
  const dir = rel ? join(APP_DIR, ...rel.split("/")) : APP_DIR;
  for (const ext of ["js", "jsx", "ts", "tsx"]) {
    const candidate = join(dir, `page.${ext}`);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      /* try the next extension */
    }
  }
  throw new Error(`no page file renders ${path}`);
}
