// src/lib/seoPages.ts
//
// THE PUBLIC SEO PAGE INVENTORY — the single source of truth for what
// src/app/sitemap.ts emits.
//
// ── Why this module exists ────────────────────────────────────────────────
//
// The sitemap used to own a hand-written list of ~21 game objects, each
// pairing a literal "/games/<slug>" with the DB table that backs it. Adding a
// game meant editing the sitemap — and forgetting to do so silently dropped a
// public page from the crawl. That is exactly what happened: Mini Golf, Sudoku
// Duel, Speed Typing, Tic-Tac-Toe and Solitaire Duel all shipped before they
// were added to that list by hand.
//
// The page inventory now lives here, and the GAME ENTRIES ARE GENERATED from
// the game catalog (GAME_LANDING_PAGES in src/lib/gameLandingPages.ts) that the
// landing-page refactor introduced. A game that has a public landing page is in
// the sitemap because the landing page exists — not because somebody
// remembered to add a line. `tests/sitemap.test.mjs` asserts that equality, and
// also asserts that every route in src/app is either listed here or
// deliberately excluded, so neither a new public page nor a private one can
// drift in unnoticed.
//
// ── What belongs in a sitemap ─────────────────────────────────────────────
//
// Only CANONICAL, PUBLIC, INDEXABLE URLs. Concretely, a URL is listed iff:
//
//   * it is public (no session required — see isPublicRoute in src/proxy.ts),
//   * it is NOT noindex (the authenticated lobbies at /casino/* and the private
//     account/admin/auth pages all declare `robots: { index: false }`),
//   * and it is the CANONICAL form of the page, never a redirect or an alias.
//
// That last rule is why the hub is listed as /games and not /casino:
// /casino/:path* 308-redirects to /games/:path* (next.config.js), so listing
// the alias would send every crawler through a redirect. It is also why the
// authenticated gameplay URLs (/games/<slug>/play) are absent — they are
// noindex by design, and the indexable page for each game is the landing page.
//
// `/help` and `/about` do not exist in this repo and are deliberately NOT
// invented here; /faq is the help surface.

import type { MetadataRoute } from "next";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import {
  chessGames,
  diceFlushRooms,
  dotsAndBoxesGames,
  fourInARowGames,
  hexDuelGames,
  kenoPvpMatches,
  laneRunnerGames,
  memoryGridMatches,
  miniGolfMatches,
  minesGames,
  oddsGames,
  poolMatches,
  precisionMatches,
  rpsPvpGames,
  solitaireDuelMatches,
  speedTypingMatches,
  sudokuDuelMatches,
  ticTacToeMatches,
  towerArenaMatches,
  unoGames,
  userStats,
} from "../db/schema";
import { GAME_LANDING_PAGES, gameLandingPath } from "./gameLandingPages";
import { GUIDES, GUIDES_INDEX_PATH, guidePath } from "./guides";

type ChangeFrequency = NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;

/**
 * Which heading a URL belongs under. Used by the tests and by the grouped
 * report, so the three families can never silently blur together.
 */
export type SeoPageGroup = "home" | "hub" | "games" | "guides" | "info";

export type SeoPage = {
  /** Path only — the origin is applied once, by the sitemap route. */
  path: string;
  group: SeoPageGroup;
  changeFrequency: ChangeFrequency;
  priority: number;
  /**
   * The DB table + column whose newest row means "this page last changed".
   * OPTIONAL on purpose: a page with no meaningful database representation
   * simply carries no `lastmod`, which is better than inventing one.
   */
  freshness?: { table: AnyPgTable; column: AnyPgColumn };
};

// ── Freshness hints ───────────────────────────────────────────────────────
// keyed by the game's landing-page slug. Deliberately a SEPARATE map from the
// page list: a game with no entry here is still listed, it just has no
// DB-derived `lastmod`. That is what keeps this map from becoming a second
// manual gate on which games appear in the sitemap.
const GAME_FRESHNESS: Record<string, { table: AnyPgTable; column: AnyPgColumn }> = {
  "mines-pvp": { table: minesGames, column: minesGames.createdAt },
  "dice-flush": { table: diceFlushRooms, column: diceFlushRooms.createdAt },
  keno: { table: kenoPvpMatches, column: kenoPvpMatches.createdAt },
  rps: { table: rpsPvpGames, column: rpsPvpGames.createdAt },
  chess: { table: chessGames, column: chessGames.createdAt },
  "four-in-a-row": { table: fourInARowGames, column: fourInARowGames.createdAt },
  "dots-and-boxes": { table: dotsAndBoxesGames, column: dotsAndBoxesGames.createdAt },
  "pool-masters": { table: poolMatches, column: poolMatches.createdAt },
  precision: { table: precisionMatches, column: precisionMatches.createdAt },
  "hex-duel": { table: hexDuelGames, column: hexDuelGames.createdAt },
  "lane-runner": { table: laneRunnerGames, column: laneRunnerGames.createdAt },
  "tower-arena": { table: towerArenaMatches, column: towerArenaMatches.createdAt },
  odds: { table: oddsGames, column: oddsGames.createdAt },
  "mini-golf": { table: miniGolfMatches, column: miniGolfMatches.createdAt },
  "memory-grid": { table: memoryGridMatches, column: memoryGridMatches.createdAt },
  "speed-typing": { table: speedTypingMatches, column: speedTypingMatches.createdAt },
  "tic-tac-toe": { table: ticTacToeMatches, column: ticTacToeMatches.createdAt },
  "sudoku-duel": { table: sudokuDuelMatches, column: sudokuDuelMatches.createdAt },
  "solitaire-duel": { table: solitaireDuelMatches, column: solitaireDuelMatches.createdAt },
  // Neon Flush and UNO are two public URLs served by the same lobby and the
  // same match table, so both take their freshness from it.
  "neon-flush": { table: unoGames, column: unoGames.createdAt },
  uno: { table: unoGames, column: unoGames.createdAt },
};

// ── The page inventory ────────────────────────────────────────────────────

const HOME_PAGES: SeoPage[] = [
  {
    path: "/",
    group: "home",
    changeFrequency: "daily",
    priority: 1,
    freshness: { table: userStats, column: userStats.updatedAt },
  },
];

const HUB_PAGES: SeoPage[] = [
  // The canonical hub. `/casino` is the 308 alias (see EXCLUDED_FROM_SITEMAP).
  { path: "/games", group: "hub", changeFrequency: "daily", priority: 0.9 },
];

/**
 * One entry per public game landing page, GENERATED from the game catalog.
 *
 * This is the whole point of the module: the sitemap can no longer omit a game,
 * because there is nothing to omit — the list is a projection of the catalog.
 */
const GAME_PAGES: SeoPage[] = GAME_LANDING_PAGES.map((game) => ({
  path: gameLandingPath(game.slug),
  group: "games" as const,
  changeFrequency: "weekly" as const,
  priority: 0.8,
  freshness: GAME_FRESHNESS[game.slug],
}));

/**
 * The guides library (src/lib/guides.ts) — the index first, then one entry per
 * guide, GENERATED from the guide catalogue.
 *
 * Generated for the same reason the game entries are: adding a guide to the
 * catalogue publishes its URL without anyone remembering to edit this file, so
 * a new guide cannot silently miss the crawl. There is no `freshness` hint —
 * a guide is prose that changes only when it is edited, and there is no
 * database row that means "this guide changed".
 */
const GUIDE_PAGES: SeoPage[] = [
  { path: GUIDES_INDEX_PATH, group: "guides", changeFrequency: "monthly", priority: 0.6 },
  ...GUIDES.map((guide) => ({
    path: guidePath(guide.slug),
    group: "guides" as const,
    changeFrequency: "yearly" as const,
    priority: 0.5,
  })),
];

/**
 * Public informational pages, highest-value first.
 *
 * Every one of these is public (no session) and indexable (no `noindex`), which
 * `tests/sitemap.test.mjs` verifies from the route's own metadata rather than
 * trusting this comment.
 */
const INFO_PAGES: SeoPage[] = [
  {
    path: "/classement",
    group: "info",
    changeFrequency: "weekly",
    priority: 0.7,
    // The ladder moves whenever a player's stats do.
    freshness: { table: userStats, column: userStats.updatedAt },
  },
  // The reviews page is built for rich results (it emits review JSON-LD), so it
  // is a genuine search surface rather than an app page.
  { path: "/reviews", group: "info", changeFrequency: "weekly", priority: 0.6 },
  // The GRYND PRO offer: a public commercial landing page.
  { path: "/upgrade-pro", group: "info", changeFrequency: "monthly", priority: 0.6 },
  { path: "/contact", group: "info", changeFrequency: "monthly", priority: 0.5 },
  { path: "/faq", group: "info", changeFrequency: "monthly", priority: 0.4 },
  { path: "/terms", group: "info", changeFrequency: "monthly", priority: 0.3 },
  { path: "/privacy-policy", group: "info", changeFrequency: "monthly", priority: 0.3 },
  { path: "/security-policy", group: "info", changeFrequency: "monthly", priority: 0.3 },
  { path: "/fair-play", group: "info", changeFrequency: "monthly", priority: 0.3 },
  { path: "/accessibility", group: "info", changeFrequency: "monthly", priority: 0.3 },
];

/** Every URL the sitemap emits, in a stable order. */
export const PUBLIC_SEO_PAGES: SeoPage[] = [
  ...HOME_PAGES,
  ...HUB_PAGES,
  ...GAME_PAGES,
  ...GUIDE_PAGES,
  ...INFO_PAGES,
];

/** Just the paths, for tests and tooling. */
export const PUBLIC_SEO_PATHS: string[] = PUBLIC_SEO_PAGES.map((page) => page.path);

/**
 * Public routes that deliberately get NO sitemap entry, with the reason.
 *
 * These are reachable pages, not 404s — they are simply not search surfaces.
 * Keeping the reasons here (rather than in a comment in the sitemap) means
 * `tests/sitemap.test.mjs` can require every public, indexable static route to
 * be either listed above or explained here. A route that is neither is a
 * decision somebody has not made yet, and the test says so.
 *
 * The routes that DO belong in this category but are absent from it are absent
 * because their own page metadata already marks them `robots: { index: false }`
 * — the authenticated lobbies, the account/admin/auth pages, the match
 * instance pages. The test derives those automatically, so they need no entry.
 */
export const EXCLUDED_FROM_SITEMAP: Record<string, string> = {
  "/casino":
    "308 alias of /games — the canonical hub URL is /games, and a sitemap must list canonical URLs only",
  "/casino/chess/ai":
    "free AI practice board — a playable route with no unique content, and already disallowed in robots.txt",
  "/casino/rps/play-ai": "free AI practice board — a playable route, not a search surface",
  "/casino/four-in-a-row/play-ai": "free AI practice board — a playable route, not a search surface",
  "/casino/hex-duel/multiplayer": "live matchmaking surface — nothing for a crawler to index",
  "/casino/hex-duel/history": "per-player match history — user-specific data, never a landing page",
  "/casino/lane-runner/history": "per-player match history — user-specific data, never a landing page",
  "/casino/precision/test": "single-player timing sandbox with no unique content",
};

/**
 * NOTE on the guides library: `/guides` and every `/guides/<slug>` ARE listed
 * above (GUIDE_PAGES). The dynamic segment /guides/[slug] is skipped by the
 * sitemap test's static-route discovery on purpose, and its slug space is
 * enumerated from GUIDE_SLUGS exactly as the game landing pages are from
 * GAME_LANDING_SLUGS.
 */

/** True when a path is one of the URLs the sitemap emits. */
export function isPublicSeoPath(path: string): boolean {
  return PUBLIC_SEO_PATHS.includes(path);
}
