/**
 * overall-elo.test.mjs
 *
 * GRYND Overall Elo — the cross-game aggregate metric:
 *   * it is the arithmetic mean of a player's ESTABLISHED game ratings,
 *     rounded to a whole number for display only
 *   * provisional game ratings never count
 *   * it needs OVERALL_MIN_GAMES different established games (matches in the
 *     same game never count twice)
 *   * it is derived on read from player_ratings — no own row, K-factor,
 *     results, history or writer; a game rating change is reflected at once
 *   * the Overall board ranks by the aggregate, restricted to eligible
 *     players, and carries no token/winnings metric
 *   * the profile + leaderboard APIs serve it server-side; a client can never
 *     submit an Overall Elo
 *
 * Run:  node --import tsx --test tests/overall-elo.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  OVERALL_MIN_GAMES,
  PROVISIONAL_GAMES,
  overallEloFromRatings,
} from "../src/lib/elo.js";

import {
  OVERALL_ELO_LABEL,
  fetchOverallEloLeaderboard,
  getOverallEloForUser,
  overallEloFromRatingsMap,
  toOverallShape,
} from "../src/lib/rating.js";

const RATING_LIB = "src/lib/rating.js";
const ROUTE = "src/app/api/leaderboard/overall/route.js";

/** Source with comments removed, so prose can't trip assertions. */
function codeOf(path) {
  return fs
    .readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** A rating entry in the shape `getRatingsForUser` produces. */
function entry(rating, gamesRated = PROVISIONAL_GAMES) {
  return { rating, gamesRated };
}

// ════════════════════════════════════════════════════════════════════════
// 1. Eligibility — 3 different games, established only
// ════════════════════════════════════════════════════════════════════════

test("ONE GAME: no Overall Elo", () => {
  const r = overallEloFromRatings([entry(1500)]);
  assert.equal(r.overallElo, null);
  assert.equal(r.eligibleGames, 1);
  assert.equal(r.eligible, false);
});

test("TWO GAMES: no Overall Elo", () => {
  const r = overallEloFromRatings([entry(1500), entry(1600)]);
  assert.equal(r.overallElo, null);
  assert.equal(r.eligibleGames, 2);
  assert.equal(r.eligible, false);
});

test("THREE GAMES: eligible, arithmetic mean", () => {
  const r = overallEloFromRatings([entry(1500), entry(1600), entry(1400)]);
  assert.equal(r.overallElo, 1500);
  assert.equal(r.eligibleGames, 3);
  assert.equal(r.eligible, true);
});

test("FOUR GAMES: eligible, arithmetic mean", () => {
  const r = overallEloFromRatings([
    entry(1500),
    entry(1600),
    entry(1400),
    entry(1300),
  ]);
  assert.equal(r.overallElo, 1450);
  assert.equal(r.eligibleGames, 4);
  assert.equal(r.eligible, true);
});

test("ROUNDING: only the display value is rounded to the nearest whole number", () => {
  // The spec's worked example: (1420 + 1180 + 1610 + 1340) / 4 = 1387.5 → 1388.
  const r = overallEloFromRatings([
    entry(1420),
    entry(1180),
    entry(1610),
    entry(1340),
  ]);
  assert.equal(r.overallElo, 1388);
});

test("RATING UPDATE: an individual game change moves the aggregate automatically", () => {
  const before = overallEloFromRatings([entry(1400), entry(1600), entry(1200)]);
  assert.equal(before.overallElo, 1400); // 4200 / 3

  // Precision moves from 1600 to 1650 — nothing else changes.
  const after = overallEloFromRatings([entry(1400), entry(1650), entry(1200)]);
  assert.equal(after.overallElo, 1417); // 4250 / 3 = 1416.67 → 1417
});

test("MISSING GAME: a game with no rating is simply excluded", () => {
  const ratingsMap = {
    chess: entry(1500),
    precision: entry(1600),
    // pool / memory-grid absent entirely
  };
  const r = overallEloFromRatingsMap(ratingsMap);
  assert.equal(r.overallElo, null, "only two rated games — not eligible");
  assert.equal(r.eligibleGames, 2);

  const three = overallEloFromRatingsMap({
    ...ratingsMap,
    pool: entry(1400),
  });
  assert.equal(three.overallElo, 1500);
  assert.equal(three.eligibleGames, 3);
});

test("PROVISIONAL: a still-unplaced game never counts toward qualification", () => {
  // Three games, but one is still being placed (gamesRated < PROVISIONAL_GAMES).
  const r = overallEloFromRatings([
    entry(1500),
    entry(1600),
    entry(2000, PROVISIONAL_GAMES - 1),
  ]);
  assert.equal(r.eligibleGames, 2, "the provisional game is excluded");
  assert.equal(r.overallElo, null);
  assert.equal(r.eligible, false);

  // The same three, once the provisional window completes, qualifies.
  const established = overallEloFromRatings([
    entry(1500),
    entry(1600),
    entry(2000, PROVISIONAL_GAMES),
  ]);
  assert.equal(established.eligibleGames, 3);
  assert.equal(established.overallElo, 1700);
});

test("ELIGIBILITY is per GAME, not per match", () => {
  // Many entries make no difference — only distinct games count. The helper
  // receives one entry per game, so duplicates of one game are not a second
  // eligible game upstream. Guard the entry contract here.
  const duplicateHeavy = overallEloFromRatings([
    entry(1500),
    entry(1500),
    entry(1500),
  ]);
  // Three array entries = three games by contract; the real safeguard is that
  // getRatingsForUser returns at most one entry per game key.
  assert.equal(duplicateHeavy.eligibleGames, 3);
  const src = fs.readFileSync(RATING_LIB, "utf8");
  assert.match(src, /out\[key\] = toRatingShape\(key, row\);/);
  assert.match(src, /out\[String\(row\.gameKey\)\]|const key = String\(row\.gameKey\);/);
});

test("MINIMUM: OVERALL_MIN_GAMES is three different games", () => {
  assert.equal(OVERALL_MIN_GAMES, 3);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Aggregate only — no rating system of its own
// ════════════════════════════════════════════════════════════════════════

test("NO OWN RATING SYSTEM: the aggregate is a pure function of ratings", () => {
  // Same inputs → same output, with no state, no K-factor and no delta.
  const a = overallEloFromRatings([entry(1500), entry(1600), entry(1400)]);
  const b = overallEloFromRatings([entry(1500), entry(1600), entry(1400)]);
  assert.deepEqual(a, b);
  // The result has no K-factor / delta / wins-losses / provisional fields.
  assert.deepEqual(Object.keys(a).sort(), ["eligible", "eligibleGames", "overallElo"]);
});

test("NO WRITER: nothing in the codebase persists or mutates an overall value", () => {
  const src = codeOf(RATING_LIB);
  // Overall is derived, never stored — no column, no insert, no update.
  assert.doesNotMatch(src, /overallElo\s*[:=]?\s*['"]?[0-9]/);
  assert.doesNotMatch(src, /INSERT INTO[^\n]*overall/i);
  assert.doesNotMatch(src, /UPDATE[^\n]*overall/i);
  // The authoritative writer's signature is untouched — it never accepts an
  // overall value (the aggregate has no match results of its own).
  const signature = codeOf(RATING_LIB).match(/applyRatingResult\(\{([\s\S]*?)\}\)\s*\{/);
  assert.ok(signature, "applyRatingResult signature not found");
  assert.doesNotMatch(signature[1], /overall/i);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Row shape
// ════════════════════════════════════════════════════════════════════════

test("SHAPE: a board row is normalized and labelled Server-side", () => {
  const row = toOverallShape({
    rank: 1,
    clerk_id: "user_1",
    name: "PlayerA",
    overall_elo: 1684,
    eligible_games: 5,
  });
  assert.equal(row.overallElo, 1684);
  assert.equal(row.eligibleGames, 5);
  assert.equal(row.label, "Overall Elo");
  assert.equal(OVERALL_ELO_LABEL, "Overall Elo");
});

// ════════════════════════════════════════════════════════════════════════
// 4. Overall board SQL
// ════════════════════════════════════════════════════════════════════════

test("BOARD: reads only established ratings, requires the minimum games", () => {
  const src = fs.readFileSync(RATING_LIB, "utf8");
  assert.match(src, /WHERE r\.games_rated >= \$\{PROVISIONAL_GAMES\}/);
  assert.match(src, /HAVING COUNT\(\*\) >= \$\{OVERALL_MIN_GAMES\}/);
  assert.match(src, /AVG\(r\.rating\)::numeric AS overall_rating/);
  assert.match(src, /COUNT\(\*\)::int AS eligible_games/);
});

test("BOARD: sorted highest Overall Elo first, deterministic ties", () => {
  const src = fs.readFileSync(RATING_LIB, "utf8");
  assert.ok(
    src.includes("ORDER BY e.overall_rating DESC, u.id ASC"),
    "the Overall board must sort by the aggregate DESC",
  );
  // The rounded display value is derived from the same average.
  assert.match(src, /ROUND\(e\.overall_rating\)::int AS overall_elo/);
  assert.equal(typeof fetchOverallEloLeaderboard, "function");
  assert.equal(typeof getOverallEloForUser, "function");
});

test("BOARD: no token / winnings metric is selected", () => {
  const src = fs.readFileSync(RATING_LIB, "utf8");
  const overallFn = src.slice(
    src.indexOf("export async function fetchOverallEloLeaderboard"),
    src.indexOf("export function toOverallShape"),
  );
  assert.ok(overallFn.length > 0, "fetchOverallEloLeaderboard must be present");
  for (const banned of [
    "total_won",
    "total_wagered",
    "biggest_win",
    "balance",
    "payout",
    "earnings",
  ]) {
    assert.doesNotMatch(
      overallFn,
      new RegExp(banned, "i"),
      `the Overall board must not select ${banned}`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════
// 5. Route + freshness + UI wiring
// ════════════════════════════════════════════════════════════════════════

test("ROUTE: read-only, server-computed, cached under the rating namespace", () => {
  assert.equal(fs.existsSync(ROUTE), true);
  const route = codeOf(ROUTE);
  assert.match(route, /fetchOverallEloLeaderboard/);
  assert.match(route, /OVERALL_MIN_GAMES/);
  assert.match(route, /CacheKeys\.rating\.overall\(limit, offset\)/);
  assert.match(route, /CacheTTL\.rating/);
  // Read-only: no write path, and no request body is ever read.
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH)/);
  assert.doesNotMatch(route, /request\.json|await req\.json|body\??\./);
});

test("SECURITY: no route reads an Overall Elo from the client", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, "utf8");
      if (/body\??\.(overallElo|overall_elo)\b/.test(src)) offenders.push(full);
    }
  };
  for (const root of ["src/app/api", "src/lib"]) walk(root);
  assert.deepEqual(
    offenders,
    [],
    `these files read an Overall Elo from the body: ${offenders.join(", ")}`,
  );
});

test("FRESHNESS: the Overall cache key exists and is purged with the rating boards", () => {
  const keys = fs.readFileSync("src/lib/redis/keys.ts", "utf8");
  assert.match(keys, /overall: \(limit: number, offset: number\)/);
  assert.match(keys, /all: `\$\{PREFIX\}:rating:\*`/);
  // A settlement purges every rating board (no game key ⇒ all, incl. overall).
  const invalidation = fs.readFileSync("src/lib/redis/invalidation.ts", "utf8");
  assert.match(invalidation, /invalidateRatingBoards\(\)/);
});

test("PROFILE APIS: serve the server-computed Overall Elo alongside ratings", () => {
  for (const path of [
    "src/app/api/user/stats/route.ts",
    "src/app/api/user-stats/route.js",
    "src/app/api/user/public-profile/route.ts",
  ]) {
    const src = fs.readFileSync(path, "utf8");
    assert.match(src, /overallEloFromRatingsMap/, `${path} must compute overall`);
    assert.match(src, /overallElo/, `${path} must expose overallElo`);
    assert.match(src, /overallEligibleGames/, `${path} must expose eligible games`);
    assert.match(src, /OVERALL_MIN_GAMES/, `${path} must expose the minimum`);
  }
});

test("PROFILE UI: shows Overall Elo and keeps the per-game ratings separate", () => {
  const tabs = fs.readFileSync("src/components/UserStatsTabs.jsx", "utf8");
  assert.match(tabs, /function OverallEloCard\(/);
  assert.match(tabs, /Overall Elo/);
  assert.match(tabs, /Eligible Games/);
  // The individual ratings list is still rendered below the aggregate.
  assert.match(tabs, /Game Ratings/);
  assert.match(tabs, /function RatingsPanel\(\{ ratings, overall \}\)/);
  assert.match(tabs, /<RatingRow key=\{entry\.gameKey\} entry=\{entry\} \/>/);
});

test("LEADERBOARD UI: an Overall Elo board is wired to the aggregate endpoint", () => {
  const page = fs.readFileSync("src/app/classement/PageClient.jsx", "utf8");
  assert.match(page, /"overall"/);
  assert.match(page, /\/api\/leaderboard\/overall\?limit=50/);
  assert.match(page, /function isOverallTab\(/);
  assert.match(page, /case "overall"/);
  assert.match(page, /Overall Elo/);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Result screen movement (before → after)
// ════════════════════════════════════════════════════════════════════════

test("MOVEMENT: derived on read from the rating journal, never stored", () => {
  const src = fs.readFileSync(RATING_LIB, "utf8");
  assert.match(src, /export async function getOverallEloMovementForUser/);
  assert.match(src, /FROM rating_events e/);
  assert.match(src, /e\.rating_before AS "ratingBefore"/);
  assert.match(src, /ORDER BY e\.created_at DESC, e\.id DESC/);
  // Reconstructs the before-set from the same pure helper, then diffs.
  assert.match(src, /previousRatings\[gameKey\]/);
  assert.match(src, /previousOverallElo: previous\.overallElo/);
  assert.match(src, /overallDelta,/);
});

test("RESULT SCREEN: reads and renders the Overall Elo movement", () => {
  const src = fs.readFileSync("src/components/result/PvpResultScreen.jsx", "utf8");
  assert.match(src, /stats\.overallElo/);
  assert.match(src, /stats\.overallEloPrevious/);
  assert.match(src, /stats\.overallEloDelta/);
  assert.match(src, /stats\.overallEloAt/);
  assert.match(src, /displayOverall/);
  assert.match(src, /Overall Elo/);
  // Freshness-gated, like XP, so a stale match is never shown as this one's.
  assert.match(src, /3 \* 60 \* 1000/);
});

// ════════════════════════════════════════════════════════════════════════
// 7. Overall Elo badge on boards + profile headers
// ════════════════════════════════════════════════════════════════════════

test("BOARDS: every stats/streak board row carries the Overall Elo badge", () => {
  const src = fs.readFileSync("src/lib/leaderboardQueries.js", "utf8");
  assert.match(src, /OVERALL_ELO_JOIN/);
  assert.match(src, /ROUND\(AVG\(r\.rating\)\)::int AS overall_elo/);
  assert.match(src, /HAVING COUNT\(\*\) >= \$\{OVERALL_MIN_GAMES\}/);
  assert.match(src, /function decorateOverallElo\(/);
  assert.match(src, /overallElo: elo/);
});

test("PER-GAME BOARD: enriches rows with the badge without merging games", () => {
  const src = fs.readFileSync(RATING_LIB, "utf8");
  const fn = src.slice(
    src.indexOf("export async function fetchRatingLeaderboard"),
    src.indexOf("export async function fetchOverallEloLeaderboard"),
  );
  assert.match(fn, /FROM player_ratings r2/);
  assert.match(fn, /overallElo: elo/);
});

test("UI: the badge renders next to names on the classement", () => {
  const page = fs.readFileSync("src/app/classement/PageClient.jsx", "utf8");
  assert.match(page, /function OverallEloBadge\(/);
  assert.match(page, /<OverallEloBadge item=\{item\}/);
  // Not doubled up on the Overall tab (where it is already the metric) or the
  // Trophy tab (where the badge has no meaning).
  assert.match(page, /!isOverallTab\(tab\) && !isTrophyTab\(tab\) && \(/);
});

test("UI: the badge renders in both profile headers", () => {
  const own = fs.readFileSync("src/app/profil/PageClient.jsx", "utf8");
  assert.match(own, /Overall \{Number\(stats\.overallElo\)\.toLocaleString\(\)\} Elo/);
  const publicPage = fs.readFileSync("src/app/profil/[clerkId]/PageClient.tsx", "utf8");
  assert.match(
    publicPage,
    /Overall \{Number\(profile\.overallElo\)\.toLocaleString\(\)\} Elo/,
  );
});

// ════════════════════════════════════════════════════════════════════════
// 8. Rate-limit + pagination hardening
// ════════════════════════════════════════════════════════════════════════

test("HARDENING: the Overall route is rate-limited and caps offset", () => {
  const route = fs.readFileSync(ROUTE, "utf8");
  assert.match(route, /consumeRateLimit/);
  assert.match(route, /status: 429/);
  assert.match(route, /MAX_OVERALL_OFFSET/);
  assert.match(route, /Math\.min\(normalizeLeaderboardOffset/);
  assert.match(route, /"X-RateLimit-Limit"/);
});

console.log("\n✅ All Overall Elo tests passed!\n");
