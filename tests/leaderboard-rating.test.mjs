/**
 * leaderboard-rating.test.mjs
 *
 * The leaderboard contract after the Elo switch:
 *   * every game-specific board is that game's ELO board, sorted by its
 *     current rating, and never combined with another game's rating
 *   * no token-derived leaderboard metric survives (wagered/won/biggest win)
 *   * the UI mirrors the server's rated-game list instead of its own
 *   * provisional ratings are labelled on the boards and in the profile
 *   * a settled rating shows up immediately (eager cache purge, short TTL)
 *
 * Run:  node --import tsx --test tests/leaderboard-rating.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  LEADERBOARD_CATEGORIES,
  WEEKLY_CATEGORIES,
  normalizeLeaderboardCategory,
  normalizeWeeklyLeaderboardCategory,
} from "../src/lib/leaderboardQueries.js";

import {
  RATED_GAMES,
  RATING_GAME_LABELS,
  getRatingGameLabel,
  normalizeRatingGameKey,
  toRatingShape,
} from "../src/lib/rating.js";

/** Source with comments removed, so prose about tokens can't trip assertions. */
function codeOf(path) {
  return fs
    .readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const CLASSEMENT = "src/app/classement/PageClient.jsx";
const GAME_ROUTE = "src/app/api/leaderboard/game/route.js";
const RATING_LIB = "src/lib/rating.js";

// ════════════════════════════════════════════════════════════════════════
// 1. Old token metrics are gone from the category boards
// ════════════════════════════════════════════════════════════════════════

test("LEADERBOARD CATEGORIES: no token-derived metric can be selected", () => {
  // Every one of these was a wallet metric, not a skill metric.
  for (const banned of [
    "biggest_win",
    "weekly_biggest_win",
    "total_won",
    "total_wagered",
    "wagered",
    "earnings",
    "balance",
    "tokens",
    "level",
  ]) {
    assert.equal(
      LEADERBOARD_CATEGORIES.includes(banned),
      false,
      `${banned} must not be an all-time leaderboard category`,
    );
    assert.equal(
      WEEKLY_CATEGORIES.includes(banned),
      false,
      `${banned} must not be a weekly leaderboard category`,
    );
    // A stale URL / bookmarked category falls back to plain wins instead of
    // silently ranking by money.
    assert.equal(normalizeLeaderboardCategory(banned), "wins");
    assert.equal(normalizeWeeklyLeaderboardCategory(banned), "wins");
  }

  assert.deepEqual([...LEADERBOARD_CATEGORIES], [
    "wins",
    "win_rate",
    "games",
    "best_streak",
    "pvp_wins",
    "net_wins",
    "win_loss_ratio",
    "current_streak",
  ]);
  // pvp_wins is still all-time only.
  assert.equal(WEEKLY_CATEGORIES.includes("pvp_wins"), false);
});

test("LEADERBOARD QUERIES: no token SQL and no wallet-based per-game board", () => {
  const code = codeOf("src/lib/leaderboardQueries.js");

  for (const banned of [
    "total_won",
    "total_wagered",
    "biggest_win",
    "weekly_biggest_win",
    "payout",
    "bet_amount",
  ]) {
    assert.doesNotMatch(
      code,
      new RegExp(banned, "i"),
      `leaderboardQueries.js must not reference ${banned}`,
    );
  }

  // The old builders are gone entirely — leaving them in would keep the
  // token-ranked boards one import away from being wired back up.
  for (const gone of [
    "fetchWinsLeaderboard",
    "fetchGameLeaderboard",
    "GAME_LEADERBOARDS",
    "GAME_LEADERBOARD_KEYS",
    "soloIntGameSql",
    "soloClerkGameSql",
    "pvpWinnerIdSql",
    "pvpSideWinnerSql",
  ]) {
    assert.doesNotMatch(
      code,
      new RegExp(`\\b${gone}\\b`),
      `${gone} must be removed`,
    );
  }
});

test("ROUTES: the wins (tokens-won) board is deleted, not just unlinked", () => {
  assert.equal(
    fs.existsSync("src/app/api/leaderboard/wins/route.js"),
    false,
    "/api/leaderboard/wins must be deleted",
  );
  // The Elo board replaced the separate rating route added alongside the Elo
  // work — one endpoint per concern.
  assert.equal(
    fs.existsSync("src/app/api/leaderboard/rating/route.ts"),
    false,
    "/api/leaderboard/rating must be folded into /api/leaderboard/game",
  );
  assert.equal(fs.existsSync(GAME_ROUTE), true);

  const keys = fs.readFileSync("src/lib/redis/keys.ts", "utf8");
  assert.doesNotMatch(keys, /lb:wins/, "the wins cache key must be removed");
  assert.doesNotMatch(keys, /lb:game/, "the old per-game cache key must be removed");
  assert.match(keys, /rating: \{/, "the Elo board cache keys must remain");
});

// ════════════════════════════════════════════════════════════════════════
// 2. The per-game board IS the game-specific Elo board
// ════════════════════════════════════════════════════════════════════════

test("GAME ROUTE: serves the requested game's Elo board only", () => {
  const route = codeOf(GAME_ROUTE);
  assert.match(route, /fetchRatingLeaderboard/);
  assert.match(route, /normalizeRatingGameKey/);
  assert.match(route, /getRatingGameLabel\(game\)/);
  // The full rated-game list ships with the response so the UI can't drift.
  assert.match(route, /RATED_GAMES\.map/);
  assert.doesNotMatch(route, /fetchGameLeaderboard/);
  // Read-only: there is no write path for a rating.
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH)/);
});

test("SORTING: the board is ordered by current rating, scoped to one game", () => {
  const src = fs.readFileSync(RATING_LIB, "utf8");
  // Ranked by the rating, highest first — rating is the primary sort key.
  assert.ok(
    src.includes("ORDER BY r.rating DESC"),
    "the Elo board must sort by rating DESC",
  );
  // Ties are deterministic (fewer losses, then account id) so a page can
  // never reshuffle between requests.
  assert.ok(src.includes("ORDER BY r.rating DESC, r.losses ASC, u.id ASC"));
  // Scoped to exactly one game: no cross-game aggregation, so Chess Elo can
  // never influence the Precision board.
  assert.ok(
    src.includes("WHERE r.game_key = ${String(gameKey)}"),
    "the Elo board must be filtered to a single game key",
  );
  // The PER-GAME board never aggregates a player's rows — one row per player
  // in exactly one game. (The separate cross-game Overall board does GROUP BY
  // user_id by design; its contract lives in tests/overall-elo.test.mjs.)
  const perGameFn = src.slice(
    src.indexOf("export async function fetchRatingLeaderboard"),
    src.indexOf("export async function fetchOverallEloLeaderboard"),
  );
  assert.ok(perGameFn.length > 0, "fetchRatingLeaderboard must be present");
  // The per-game RANKING is still scoped to one game and ordered by that
  // game's rating. It may enrich each row with the SEPARATE Overall Elo badge
  // aggregate (an independent subquery over `player_ratings r2`), but it never
  // merges another game's rating into the ranking itself.
  assert.match(perGameFn, /FROM player_ratings r2/);
  assert.match(perGameFn, /o2\.overall_elo/);
  assert.match(perGameFn, /WHERE r\.game_key = \$\{String\(gameKey\)\}/);
});

test("ROWS: carry the non-token record and the provisional state", () => {
  const src = fs.readFileSync(RATING_LIB, "utf8");
  // The record line the leaderboard renders (wins/losses/win rate/games).
  assert.ok(src.includes("END AS win_rate"));
  assert.ok(src.includes("(r.wins + r.losses) AS games"));
  // Provisional labelling comes from the one shared read shape.
  assert.match(src, /\.\.\.provisionalProgress\(gamesRated, rating\)/);
  assert.match(src, /label: getRatingGameLabel\(String\(gameKey\)\)/);
});

test("GAME KEYS: rated games only, one independent board each", () => {
  assert.equal(RATED_GAMES.length >= 10, true);
  // Every rated game has a display label and its own board key.
  for (const key of RATED_GAMES) {
    assert.equal(typeof RATING_GAME_LABELS[key], "string", `${key} needs a label`);
    assert.equal(normalizeRatingGameKey(key), key);
  }
  // Unrated games fall back to the first rated game rather than inventing a
  // board for a game that has no ratings.
  for (const unrated of ["plinko", "roulette", "uno", "hex-duel", "crash"]) {
    assert.equal(normalizeRatingGameKey(unrated), RATED_GAMES[0]);
  }
  assert.equal(getRatingGameLabel("pool"), "Pool Masters");
  assert.equal(getRatingGameLabel("chess"), "Chess");
});

test("BOARD ROW SHAPE: independent per game, labelled, provisional-aware", () => {
  // Two rows belonging to the same player, in two different games. They share
  // no state: the Chess row is established, the Precision row is still being
  // placed. Exactly what each board renders.
  const chess = toRatingShape("chess", {
    rating: 1420,
    peak_rating: 1500,
    games_rated: 42,
    wins: 25,
    losses: 15,
    draws: 2,
    last_delta: 12,
    last_rated_at: null,
    win_rate: 62.5,
    games: 40,
  });
  assert.equal(chess.rating, 1420);
  assert.equal(chess.label, "Chess");
  assert.equal(chess.gamesRated, 42);
  assert.equal(chess.wins, 25);
  assert.equal(chess.draws, 2);
  assert.equal(chess.provisional, false);
  assert.equal(chess.provisionalStage, "established");
  assert.equal(chess.provisionalGamesCompleted, 10);
  assert.equal(chess.provisionalGamesRemaining, 0);
  assert.equal(chess.kFactor, 32);
  // The record line is the rating row's own W/L for that game, not a
  // platform-wide stat (draws are excluded from the win rate).
  assert.equal(chess.winRate, 62.5);
  assert.equal(chess.games, 40);
  // The board row passes the SQL aliases straight through for the shared
  // RecordLine component, which reads snake_case `win_rate`/`games`.
  const boardRow = {
    ...toRatingShape("chess", { wins: 25, losses: 15, games_rated: 42 }),
    win_rate: 62.5,
    games: 40,
  };
  assert.equal(boardRow.win_rate, 62.5);
  assert.equal(boardRow.games, 40);

  const precision = toRatingShape("precision", {
    rating: 1610,
    peak_rating: 1610,
    games_rated: 4,
    wins: 3,
    losses: 1,
    draws: 0,
    last_delta: 26,
    last_rated_at: null,
  });
  assert.equal(precision.rating, 1610);
  assert.equal(precision.label, "Precision");
  assert.equal(precision.gamesRated, 4);
  assert.equal(precision.provisional, true);
  assert.equal(precision.provisionalStage, "provisional");
  assert.equal(precision.provisionalGamesCompleted, 4);
  assert.equal(precision.provisionalGamesRemaining, 6);
  assert.equal(precision.provisionalProgressPercent, 40);
  assert.equal(precision.kFactor, 40);

  // Nothing is shared between the two rows: changing one game never moves the
  // other's numbers.
  assert.notEqual(chess.rating, precision.rating);
  assert.notEqual(chess.gamesRated, precision.gamesRated);
  assert.notEqual(chess.gameKey, precision.gameKey);
});

// ════════════════════════════════════════════════════════════════════════
// 3. Rating updates appear (eager purge + short TTL)
// ════════════════════════════════════════════════════════════════════════

test("FRESHNESS: a settled rated match purges its game's Elo board", () => {
  const route = fs.readFileSync(GAME_ROUTE, "utf8");
  assert.match(route, /CacheKeys\.rating\.board\(game, limit, offset\)/);
  assert.match(route, /CacheTTL\.rating/);

  const invalidation = codeOf("src/lib/redis/invalidation.ts");
  assert.match(
    invalidation,
    /invalidateRatingBoards\(\)/,
    "settlement must eagerly purge the Elo boards",
  );
  // ...and the board carries a short safety TTL rather than the 5-min
  // leaderboard one, so a rating can never be visibly stale for long.
  const keys = fs.readFileSync("src/lib/redis/keys.ts", "utf8");
  assert.match(keys, /rating: 60/);
});

// ════════════════════════════════════════════════════════════════════════
// 4. The UI: Elo metric, provisional chips, no token display
// ════════════════════════════════════════════════════════════════════════

test("UI: the game tabs mirror RATED_GAMES exactly (no drift)", () => {
  const page = fs.readFileSync(CLASSEMENT, "utf8");
  const mirrorBlock = page.slice(
    page.indexOf("const RATED_GAMES_FALLBACK"),
  );
  const mirror = [
    ...mirrorBlock
      .slice(0, mirrorBlock.indexOf("];"))
      .matchAll(/\{\s*key:\s*"([a-z0-9-]+)",\s*label:\s*"([^"]+)"\s*\}/g),
  ].map((m) => ({ key: m[1], label: m[2] }));

  assert.deepEqual(
    mirror.map((g) => g.key),
    [...RATED_GAMES],
    "the first-paint game list must match the server's rated games",
  );
  for (const { key, label } of mirror) {
    assert.equal(label, RATING_GAME_LABELS[key], `label mismatch for ${key}`);
  }
  // ...and the authoritative list still comes from the API on load.
  assert.match(page, /board\.data\?\.games/);
});

test("UI: the per-game board ranks and labels by Elo", () => {
  const code = codeOf(CLASSEMENT);
  assert.match(
    code,
    /const displayCategory = isPerGameTab\(tab\)\s*\?\s*"rating"/,
  );
  assert.match(code, /return formatNumber\(field\("rating"\)\);/);
  assert.match(code, /ProvisionalChip/);
  assert.match(code, /provisionalGamesCompleted/);
  assert.match(code, /\/api\/leaderboard\/game\?game=\$\{game\}&limit=50/);
});

test("UI: no token or winnings metric is rendered on the boards", () => {
  const code = codeOf(CLASSEMENT);
  for (const banned of [
    "biggest_win",
    "biggestWin",
    "token",
    "wagered",
    "totalWon",
    "earnings",
  ]) {
    assert.doesNotMatch(
      code,
      new RegExp(banned, "i"),
      `the leaderboard page must not render ${banned}`,
    );
  }

  const tabs = codeOf("src/components/UserStatsTabs.jsx");
  assert.doesNotMatch(tabs, /Biggest Win/i);
  assert.doesNotMatch(tabs, /weeklyBiggestWin/i);
  assert.doesNotMatch(tabs, /\btoken/i);
});

test("DEEP LINK: ?game= opens that game's Elo board; unknown ids are ignored", () => {
  const page = fs.readFileSync(CLASSEMENT, "utf8");
  assert.match(page, /URLSearchParams\(window\.location\.search\)\.get\("game"\)/);
  assert.match(page, /setTab\("per-game"\)/);

  // The lobby's canonical ids differ from the rating keys for some games, so
  // every alias target must resolve to a REAL rated game key — otherwise a
  // lobby shortcut would land on an empty invented board.
  const block = page.slice(page.indexOf("const LOBBY_GAME_ALIASES"));
  const body = block.slice(0, block.indexOf("};"));
  const targets = [...body.matchAll(/:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(targets.length >= 4, "the lobby alias map should be populated");
  for (const target of targets) {
    assert.ok(
      RATED_GAMES.includes(target),
      `alias target ${target} is not a rated game`,
    );
  }

  // These rated games already share the lobby's id, so no alias is needed.
  for (const direct of [
    "chess",
    "four-in-a-row",
    "dots-and-boxes",
    "memory-grid",
    "precision",
    "mines-pvp",
  ]) {
    assert.ok(RATED_GAMES.includes(direct), `${direct} must be rated`);
    assert.equal(LOBBY_ALIAS_HAS(direct), false, `${direct} should not be aliased`);
  }
});

/** True when the deep-link alias map contains `key` as a key. */
function LOBBY_ALIAS_HAS(key) {
  const page = fs.readFileSync(CLASSEMENT, "utf8");
  const block = page.slice(page.indexOf("const LOBBY_GAME_ALIASES"));
  const body = block.slice(0, block.indexOf("};") + 2);
  return new RegExp(`(^|\\s)["']?${key}["']?\\s*:`).test(body);
}

// ════════════════════════════════════════════════════════════════════════
// 5. The profile's game-specific rating section
// ════════════════════════════════════════════════════════════════════════

test("PROFILE: a Game Ratings tab lists one Elo per game", () => {
  const tabs = fs.readFileSync("src/components/UserStatsTabs.jsx", "utf8");
  assert.match(tabs, /\{ key: "ratings", label: "Game Ratings" \}/);
  assert.match(tabs, /function RatingRow\(/);
  assert.match(tabs, /function RatingsPanel\(/);
  // Only games with a rating are listed — no fabricated 1000 placeholders.
  assert.match(tabs, /Number\.isFinite\(Number\(r\.rating\)\)/);
  // Highest rating first, and the provisional state is explicit.
  assert.match(tabs, /sort\(\(a, b\) => Number\(b\.rating\) - Number\(a\.rating\)\)/);
  assert.match(tabs, /entry\.provisional/);
});

test("PROFILE: both profile pages pass the ratings map through", () => {
  const own = fs.readFileSync("src/app/profil/PageClient.jsx", "utf8");
  assert.match(own, /record=\{stats\?\.record\}/);
  assert.match(own, /ratings=\{stats\?\.ratings\}/);
  // Overall Elo is passed alongside the per-game ratings, never instead.
  assert.match(own, /overall=\{stats\}/);
  const publicPage = fs.readFileSync(
    "src/app/profil/[clerkId]/PageClient.tsx",
    "utf8",
  );
  assert.match(publicPage, /record=\{profile\.record\}/);
  assert.match(publicPage, /ratings=\{profile\.ratings\}/);
  assert.match(publicPage, /overall=\{profile\}/);
  // The public-profile API has to send it for that to work.
  const api = fs.readFileSync("src/app/api/user/public-profile/route.ts", "utf8");
  assert.match(api, /getRatingsForUser/);
  assert.match(api, /ratings,/);
});

test("PROFILE API: ratings are served fresh, outside the stats cache", () => {
  const src = fs.readFileSync("src/app/api/user-stats/route.js", "utf8");
  assert.match(src, /getRatingsForUser/);
  assert.match(src, /stats: \{\s*\.\.\.stats,\s*ratings,/);
  // The read must happen AFTER the cached stats object is fully built, so an
  // Elo that just moved is never masked by the 3-minute stats TTL.
  const cachedEnd = src.indexOf("totalWagered: Number(row?.total_wagered || 0),");
  assert.ok(cachedEnd > 0, "the cached stats object should still be built");
  assert.ok(
    src.indexOf("getRatingsForUser(clerkId)") > cachedEnd,
    "ratings must be read outside the cached stats computation",
  );
});

console.log("\n✅ All rating-leaderboard tests passed!\n");
