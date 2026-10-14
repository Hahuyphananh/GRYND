/**
 * GRYND PRO statistics — the maths, the metrics' honesty, and the Pro gate.
 *
 * The dashboard reads the platform's own settlement journals
 * (`rating_events` / `trophy_events`) and the rank snapshots written by
 * migration 0216. Those journals need a database, so this suite pins:
 *
 *   1. the PURE analytics (src/lib/stats/performance.ts) — win rate with draws
 *      excluded, per-game grouping, the Elo/trophy/Overall-Elo curves, date and
 *      game filters, daily downsampling and recent form — against hand-checked
 *      fixtures, including the property that makes the Overall Elo history real
 *      rather than invented (its last point equals today's aggregate);
 *   2. the CONTRACT around the data: the migration is additive, journaled and
 *      indexed; the snapshot writer is idempotent per (player, day) and ranks
 *      players exactly the way the Overall Elo board orders them; the API is
 *      server-gated and returns NO analytics to a non-member;
 *   3. that nothing free was gated in the process.
 *
 * Run: node --import tsx --test tests/pro-stats.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildOverallEloSeries,
  buildRatingSeries,
  buildTrophySeries,
  dedupeEvents,
  filterByDateRange,
  filterByGame,
  recentForm,
  seriesChange,
  summarizeResults,
  toDailySeries,
  toResultEvents,
} from "../src/lib/stats/performance.ts";
import { overallEloFromRatings } from "../src/lib/elo.js";

const read = (path) => fs.readFileSync(path, "utf8");

const at = (monthDay) => `2026-${String(monthDay).padStart(5, "0")}T12:00:00.000Z`;

/** One settled result, the way the SQL layer hands it over. */
const event = (overrides = {}) => ({
  gameKey: "chess",
  matchId: "m1",
  outcome: "win",
  at: at("1-01"),
  rating: 1016,
  trophies: 30,
  ...overrides,
});

test("win rate excludes draws and is null until something is decided", () => {
  const summary = summarizeResults([
    event({ matchId: "1", outcome: "win" }),
    event({ matchId: "2", outcome: "loss" }),
    event({ matchId: "3", outcome: "draw" }),
    event({ matchId: "4", outcome: "win" }),
  ]);

  assert.equal(summary.matches, 4);
  assert.equal(summary.wins, 2);
  assert.equal(summary.losses, 1);
  assert.equal(summary.draws, 1);
  assert.equal(summary.decided, 3);
  // 2 wins of 3 DECIDED matches — the draw is reported, never counted.
  assert.equal(summary.winRate, 66.67);

  const allDraws = summarizeResults([
    event({ matchId: "1", outcome: "draw" }),
    event({ matchId: "2", outcome: "draw" }),
  ]);
  assert.equal(allDraws.draws, 2);
  assert.equal(allDraws.decided, 0);
  assert.equal(allDraws.winRate, null, "no decided match must never read as 0%");

  assert.equal(summarizeResults([]).winRate, null);
});

test("unreadable results are dropped, and a match is counted once", () => {
  const rows = [
    { gameKey: "chess", matchId: "a", outcome: "win", at: at("2-02"), rating: 1030, trophies: 40 },
    // Same match again (the two journals both carry it) — must not double count.
    { gameKey: "chess", matchId: "a", outcome: "win", at: at("2-02"), rating: 1030, trophies: 40 },
    // Unknown outcome, missing match id, unreadable date: all dropped.
    { gameKey: "chess", matchId: "b", outcome: "victory", at: at("2-03"), rating: 1040 },
    { gameKey: "chess", outcome: "win", at: at("2-04"), rating: 1050 },
    { gameKey: "chess", matchId: "c", outcome: "loss", at: "not-a-date", rating: 990 },
  ];

  const events = toResultEvents(rows);
  assert.equal(events.length, 1);
  assert.equal(events[0].matchId, "a");

  assert.equal(
    dedupeEvents([event({ matchId: "x" }), event({ matchId: "x" })]).length,
    1,
  );
});

test("events come back chronological, and the filters are inclusive", () => {
  const events = toResultEvents([
    { gameKey: "chess", matchId: "later", outcome: "win", at: at("3-10"), rating: 1030 },
    { gameKey: "chess", matchId: "earlier", outcome: "loss", at: at("3-01"), rating: 1010 },
    { gameKey: "pool", matchId: "other", outcome: "win", at: at("3-05"), rating: 1005 },
  ]);

  assert.deepEqual(
    events.map((entry) => entry.matchId),
    ["earlier", "other", "later"],
  );

  // Game filter — "all" and null keep everything.
  assert.equal(filterByGame(events, "pool").length, 1);
  assert.equal(filterByGame(events, "all").length, 3);
  assert.equal(filterByGame(events, null).length, 3);

  // Date range — both bounds inclusive.
  const windowed = filterByDateRange(events, { from: at("3-01"), to: at("3-05") });
  assert.deepEqual(windowed.map((entry) => entry.matchId), ["earlier", "other"]);
  assert.equal(filterByDateRange(events, { from: at("3-05") }).length, 2);
  assert.equal(filterByDateRange(events, { to: at("3-01") }).length, 1);
  assert.equal(filterByDateRange(events, {}).length, 3);
});

test("the rating curve only plots matches that actually have a rating", () => {
  const events = toResultEvents([
    // A placement table: trophies only, no Elo row at all.
    { gameKey: "tower-arena", matchId: "t1", outcome: "win", at: at("4-01"), trophies: 30 },
    { gameKey: "chess", matchId: "c1", outcome: "win", at: at("4-02"), rating: 1016, trophies: 30 },
    { gameKey: "chess", matchId: "c2", outcome: "loss", at: at("4-03"), rating: 1004, trophies: 0 },
  ]);

  const series = buildRatingSeries(filterByGame(events, "chess"));
  assert.deepEqual(series.map((point) => point.value), [1016, 1004]);
  assert.equal(seriesChange(series), -12);
  assert.equal(seriesChange([{ at: at("4-02"), value: 1016 }]), null);

  // A trophy-only game has no Elo curve to draw.
  assert.deepEqual(buildRatingSeries(filterByGame(events, "tower-arena")), []);
});

test("trophy curve is that game's count, or the cross-game total", () => {
  const events = toResultEvents([
    { gameKey: "chess", matchId: "c1", outcome: "win", at: at("5-01"), rating: 1016, trophies: 30 },
    { gameKey: "pool", matchId: "p1", outcome: "win", at: at("5-02"), rating: 1010, trophies: 20 },
    { gameKey: "chess", matchId: "c2", outcome: "loss", at: at("5-03"), rating: 1000, trophies: 0 },
  ]);

  assert.deepEqual(
    buildTrophySeries(filterByGame(events, "chess"), "chess").map((point) => point.value),
    [30, 0],
  );

  // No game filter: the TOTAL, i.e. each game's latest count summed.
  assert.deepEqual(
    buildTrophySeries(events, null).map((point) => point.value),
    [30, 50, 20],
  );
});

/** Ten rated matches in one game ⇒ that game is established (PROVISIONAL_GAMES). */
function ratedMatches({
  gameKey,
  count,
  from = 1000,
  step = 10,
  prefix,
  start = 1,
  month = 6,
}) {
  return Array.from({ length: count }, (_, index) => ({
    gameKey,
    matchId: `${prefix}${index + 1}`,
    outcome: index % 3 === 2 ? "draw" : "win",
    at: `2026-${String(month).padStart(2, "0")}-${String(start + index).padStart(2, "0")}T12:00:00.000Z`,
    rating: from + step * (index + 1),
    trophies: 10 * (index + 1),
  }));
}

test("the Overall Elo history is rebuilt from real results, not today's number", () => {
  const rows = [
    // Three games are made established one after another (10 rated matches
    // each), then chess is played 5 more times.
    ...ratedMatches({ gameKey: "chess", count: 10, prefix: "c", start: 1 }),
    ...ratedMatches({ gameKey: "pool", count: 10, step: -5, prefix: "p", start: 11 }),
    ...ratedMatches({ gameKey: "uno", count: 10, step: 2, prefix: "u", start: 21 }),
    ...ratedMatches({ gameKey: "chess", count: 5, from: 1100, prefix: "c-late-", start: 1, month: 7 }),
  ];
  const series = buildOverallEloSeries(toResultEvents(rows));

  // Nothing is plotted until the player has 3 ESTABLISHED games (this is the
  // 30th rated match) — a provisional rating never counts — and every point
  // after that reflects the ratings known at that instant.
  assert.equal(series.length, 6, "the 30th match plus the five after it");
  assert.ok(series.every((point) => point.eligibleGames === 3));

  // The last point equals TODAY'S aggregate — the same number the profile
  // badge shows — which is what makes this history real rather than invented.
  const current = [
    { rating: 1150, gamesRated: 15 },
    { rating: 950, gamesRated: 10 },
    { rating: 1020, gamesRated: 10 },
  ];
  assert.equal(
    series[series.length - 1].overallElo,
    overallEloFromRatings(current).overallElo,
  );
  assert.equal(overallEloFromRatings(current).overallElo, 1040);

  // Two established games only: no overall rating, so no points at all.
  const twoGames = toResultEvents([
    ...ratedMatches({ gameKey: "chess", count: 10, prefix: "c" }),
    ...ratedMatches({ gameKey: "pool", count: 10, prefix: "p" }),
  ]);
  assert.deepEqual(buildOverallEloSeries(twoGames), []);
});

test("the daily downsample keeps one point per day and the current value", () => {
  const points = [
    { at: at("7-01"), value: 1 },
    { at: "2026-07-01T18:00:00.000Z", value: 2 },
    { at: at("7-02"), value: 3 },
  ];
  assert.deepEqual(toDailySeries(points), [
    { at: "2026-07-01T18:00:00.000Z", value: 2 },
    { at: at("7-02"), value: 3 },
  ]);

  // The final point is never dropped, even mid-day.
  const sameDay = [
    { at: at("7-01"), value: 1 },
    { at: "2026-07-01T23:00:00.000Z", value: 9 },
  ];
  assert.deepEqual(toDailySeries(sameDay), [{ at: "2026-07-01T23:00:00.000Z", value: 9 }]);
});

test("recent form reads the newest matches first", () => {
  const events = toResultEvents([
    { gameKey: "chess", matchId: "1", outcome: "loss", at: at("8-01"), rating: 990 },
    { gameKey: "chess", matchId: "2", outcome: "win", at: at("8-02"), rating: 1010 },
    { gameKey: "chess", matchId: "3", outcome: "win", at: at("8-03"), rating: 1020 },
    { gameKey: "chess", matchId: "4", outcome: "draw", at: at("8-04"), rating: 1020 },
  ]);

  const form = recentForm(events, 3);
  assert.deepEqual(form.outcomes, ["draw", "win", "win"]);
  assert.equal(form.winRate, 100, "the draw is excluded from a 2-of-2 rate");
  assert.deepEqual(form.streak, { outcome: "draw", length: 1 });

  const all = recentForm(events, 10);
  assert.equal(all.outcomes.length, 4);
  assert.equal(all.winRate, 66.67);
  assert.equal(recentForm([], 10).streak, null);
});

// ── The snapshot table: additive, indexed, idempotent per day ───────────────

const MIGRATION = read("src/db/migrations/0216_player_rank_snapshots.sql");
const SCHEMA = read("src/db/schema.ts");
const QUERIES = read("src/lib/stats/queries.ts");

test("migration 0216 adds the rank snapshot table without touching anything else", () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS "player_rank_snapshots"/);
  assert.match(MIGRATION, /"bucket" date NOT NULL/);
  assert.match(MIGRATION, /"overall_rank" integer/);
  assert.match(MIGRATION, /ON DELETE CASCADE/);

  // Duplicate guard for (player, day) + the player/timestamp read index.
  assert.match(
    MIGRATION,
    /CREATE UNIQUE INDEX IF NOT EXISTS "player_rank_snapshots_user_bucket_unique"[\s\S]*?\("user_id", "bucket"\)/,
  );
  assert.match(MIGRATION, /CREATE INDEX IF NOT EXISTS "player_rank_snapshots_bucket_idx"/);

  // Additive only: no DROP, no DELETE, no ALTER of an existing table.
  assert.ok(!/\bDROP\b/i.test(MIGRATION), "the migration must not drop anything");
  assert.ok(!/DELETE FROM/i.test(MIGRATION), "the migration must not delete rows");
  assert.ok(!/ALTER TABLE/i.test(MIGRATION), "no existing table may be altered");

  // It must be journaled or the migrator never runs it.
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const entry = journal.entries.find((e) => e.tag === "0216_player_rank_snapshots");
  assert.ok(entry, "0216 must be registered in _journal.json");
  assert.equal(entry.idx, journal.entries.indexOf(entry));
  // Ordered, not necessarily last: drizzle runs journalled entries in `when`
  // order, so 0216 must land AFTER the migrations it follows — but a later
  // migration of an unrelated feature must not fail this test.
  const previous = journal.entries[entry.idx - 1];
  assert.ok(previous, "0216 must not be the first journal entry");
  assert.ok(entry.when > previous.when, "0216 must be applied after the migration it follows");

  // Drizzle schema mirrors the table (same unique index name).
  assert.match(SCHEMA, /export const playerRankSnapshots = pgTable\(\s*"player_rank_snapshots"/);
  assert.match(SCHEMA, /unique\("player_rank_snapshots_user_bucket_unique"\)/);
});

test("the snapshot writer is idempotent per player and day", () => {
  // Both the per-player capture and the whole-population sweep upsert on the
  // same key, so a re-run (or the two racing) cannot duplicate a player's day.
  const conflicts = QUERIES.match(/ON CONFLICT \(user_id, bucket\) DO UPDATE/g) ?? [];
  assert.equal(conflicts.length, 2, "the capture and the sweep both upsert");
  assert.ok(!/INSERT INTO player_rank_snapshots[\s\S]*?ON CONFLICT DO NOTHING/.test(QUERIES));

  // Buckets are UTC days, so "the same day" means the same thing everywhere.
  assert.match(QUERIES, /export function utcDayBucket/);
  assert.match(QUERIES, /toISOString\(\)\.slice\(0, 10\)/);
});

test("snapshot ranks match the Overall Elo board order, from the same rule", () => {
  // The board (src/lib/rating.js) orders by the UNROUNDED average rating and
  // then by user id. The sweep must use exactly that ordering, or a stored rank
  // could disagree with the rank the leaderboard shows.
  assert.match(QUERIES, /ROW_NUMBER\(\) OVER \(\s*ORDER BY e\.overall_rating DESC, e\.user_id ASC\s*\)/);
  assert.match(QUERIES, /AVG\(r\.rating\)::numeric AS overall_rating/);
  assert.match(QUERIES, /e2\.overall_rating = m\.overall_rating AND e2\.user_id < m\.user_id/);

  const target = read("src/lib/rating.js");
  assert.match(target, /ORDER BY e\.overall_rating DESC, u\.id ASC/);

  // Eligibility comes from the platform's constants, never a second copy.
  assert.match(QUERIES, /PROVISIONAL_GAMES/);
  assert.match(QUERIES, /OVERALL_MIN_GAMES/);
  const elo = read("src/lib/elo.js");
  assert.match(elo, /export const PROVISIONAL_GAMES = 10/);
  assert.match(elo, /export const OVERALL_MIN_GAMES = 3/);
});

test("the dashboard reads the journals, and never counts a match twice", () => {
  // Both journals feed the numbers: a placement table (Crash Arena, Tower
  // Arena, Roulette PvP) has no Elo row at all, so reading one journal alone
  // would undercount the platform's real results.
  assert.match(QUERIES, /FROM rating_events e/);
  assert.match(QUERIES, /FROM trophy_events t/);
  assert.match(QUERIES, /UNION ALL/);
  // …and the collapse is one row per match, Elo row preferred.
  assert.match(QUERIES, /DISTINCT ON \(game_key, match_id\)/);
  assert.match(QUERIES, /ORDER BY game_key, match_id, \(rating IS NULL\), created_at DESC/);
  // The trophy values are joined back onto that single row.
  assert.match(QUERIES, /LEFT JOIN trophy_events t/);

  // Aggregates and pagination happen in SQL, not in JavaScript over a capped
  // list: a chart cap must not be able to make the headline totals wrong.
  assert.match(QUERIES, /GROUP BY GROUPING SETS \(\(\), \(game_key\)\)/);
  assert.match(QUERIES, /LIMIT \$\{safeLimit\} OFFSET \$\{safeOffset\}/);
});

// ── Access control ─────────────────────────────────────────────────────────

const ROUTE = read("src/app/api/stats/performance/route.ts");
const PAGE = read("src/app/stats/page.tsx");
const DASHBOARD = read("src/components/stats/PerformanceDashboard.tsx");
const LOCKED = read("src/components/stats/ProAnalyticsLocked.tsx");

test("the analytics API is gated on the server, per request", () => {
  // Signed-out callers get nothing.
  assert.match(ROUTE, /const \{ userId \} = await auth\(\)/);
  assert.match(ROUTE, /if \(!userId\)[\s\S]*?status: 401/);

  // Membership comes from the platform's authoritative check…
  assert.match(ROUTE, /getMembershipTier/);
  assert.match(ROUTE, /=== "pro"/);

  // …and NEVER from anything the client sends. No pro/premium flag may be read
  // from the query string, a header or a body.
  // (Comments are stripped first: the route DOCUMENTS that no such flag exists,
  // and naming a flag in a comment is not reading it.)
  const routeCode = ROUTE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/searchParams\.get\(["'](pro|premium|isPro)["']\)/.test(routeCode));
  assert.ok(!/headers\.get\(["'](x-pro|x-premium|pro)["']\)/i.test(routeCode));
  assert.ok(!/isPro|isPremium/.test(routeCode), "no client-claimable entitlement flag");

  // A non-member response carries the upsell and NO analytics.
  const lockedStart = ROUTE.indexOf("if (!pro) {");
  const lockedEnd = ROUTE.indexOf("const payload = await getPerformanceDashboard");
  assert.ok(lockedStart > 0 && lockedEnd > lockedStart, "the locked branch must exist");
  // Comments stripped again: the branch explains WHICH metrics it withholds,
  // and naming them in a comment is not returning them.
  const lockedBlock = ROUTE.slice(lockedStart, lockedEnd)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(lockedBlock, /locked: true/);
  assert.match(lockedBlock, /upgradeUrl: "\/upgrade-pro"/);
  for (const metric of ["summary", "perGame", "series", "recent", "rankHistory"]) {
    assert.ok(
      !lockedBlock.includes(metric),
      `the locked response must not include ${metric}`,
    );
  }

  // Per-user data is never shared or cached publicly.
  assert.match(ROUTE, /"Cache-Control": "private, no-store"/);
  // …and the surface is rate limited like the other read APIs.
  assert.match(ROUTE, /consumeRateLimit/);
});

test("the /stats page decides membership server-side and stays out of the index", () => {
  assert.match(PAGE, /getMembershipTier/);
  assert.match(PAGE, /await auth\(\)/);
  assert.match(PAGE, /robots: \{ index: false, follow: false \}/);
  assert.match(PAGE, /export const dynamic = "force-dynamic"/);
  // An unreadable subscription table means "not a member".
  assert.match(PAGE, /pro = false/);
});

test("the dashboard renders the upgrade prompt instead of the analytics when locked", () => {
  assert.match(DASHBOARD, /const locked = Boolean\(data\?\.locked\) \|\| !pro;/);
  assert.match(DASHBOARD, /if \(locked\)[\s\S]*?<ProAnalyticsLocked/);
  // The locked prompt shows no figures, only frames and copy.
  assert.ok(!/formatNumber|formatRate/.test(LOCKED), "the locked prompt must not format data");
  assert.match(LOCKED, /\/upgrade-pro/);

  // The client never decides entitlement itself.
  assert.ok(!/isPro|premium/.test(DASHBOARD));
  // …and it asks the server for the filtered slice rather than filtering a
  // full payload itself.
  assert.match(DASHBOARD, /useApiResource<Payload>\(/);
  assert.match(DASHBOARD, /`\/api\/stats\/performance\?\$\{query\}`/);
});

test("free reads are untouched", () => {
  // The basic statistics endpoint every player already uses keeps no
  // membership gate: the dashboard is additive, not a replacement.
  const userStats = read("src/app/api/user-stats/route.js");
  assert.ok(!/getMembershipTier|isPremiumMember/.test(userStats));
  assert.match(userStats, /await auth\(\)/);

  // The rank/wins boards and the profile link stay as they are.
  assert.match(read("src/app/api/leaderboard/overall/route.js"), /fetchRatingLeaderboard|overall/i);
  assert.match(read("src/app/profil/PageClient.jsx"), /href="\/stats"/);
});

// ── Copy ───────────────────────────────────────────────────────────────────

test("every dashboard string is translated in all three languages", async () => {
  const { t } = await import("../src/lib/appTextTranslations.js");
  const keys = [
    "stats.title",
    "stats.subtitle",
    "stats.range.all",
    "stats.range.7d",
    "stats.range.365d",
    "stats.filters.game",
    "stats.filters.all_games",
    "stats.filters.range",
    "stats.outcome.win",
    "stats.outcome.loss",
    "stats.outcome.draw",
    "stats.tile.matches",
    "stats.tile.last_played",
    "stats.tile.record",
    "stats.tile.record_hint",
    "stats.tile.win_rate",
    "stats.tile.win_rate_hint",
    "stats.tile.form",
    "stats.tile.form_streak",
    "stats.tile.form_hint",
    "stats.chart.rating_title",
    "stats.chart.rating_sub",
    "stats.chart.rating_pick",
    "stats.chart.rating_series",
    "stats.chart.rating_axis",
    "stats.chart.no_points",
    "stats.chart.overall_title",
    "stats.chart.overall_sub",
    "stats.chart.overall_series",
    "stats.chart.overall_axis",
    "stats.chart.overall_empty",
    "stats.chart.trophy_title",
    "stats.chart.trophy_sub",
    "stats.chart.trophy_sub_total",
    "stats.chart.trophy_series",
    "stats.chart.trophy_axis",
    "stats.chart.rank_title",
    "stats.chart.rank_sub",
    "stats.chart.rank_empty_sub",
    "stats.chart.rank_series",
    "stats.chart.rank_axis",
    "stats.chart.rank_empty",
    "stats.capped",
    "stats.pergame.title",
    "stats.pergame.note",
    "stats.pergame.empty",
    "stats.pergame.game",
    "stats.pergame.matches",
    "stats.pergame.record",
    "stats.pergame.win_rate",
    "stats.pergame.rating",
    "stats.pergame.trophies",
    "stats.recent.title",
    "stats.recent.empty",
    "stats.recent.elo",
    "stats.recent.trophies",
    "stats.recent.load_more",
    "stats.recent.versus",
    "stats.notes.sources",
    "stats.notes.unsettled",
    "stats.notes.rank_window",
    "stats.notes.today",
    "stats.notes.eligibility",
    "stats.generated_at",
    "stats.back_to_profile",
    "stats.locked.title",
    "stats.locked.body",
    "stats.locked.point_record",
    "stats.locked.point_pergame",
    "stats.locked.point_elo",
    "stats.locked.point_rank",
    "stats.locked.cta",
    "stats.locked.signin",
    "stats.locked.free_note",
    "stats.locked.eligibility",
    "profile.stats.advanced_badge",
    "profile.stats.advanced",
    "profile.stats.advanced_open",
  ];

  for (const lang of ["en", "fr", "es"]) {
    for (const key of keys) {
      const value = t(lang, key);
      assert.ok(
        typeof value === "string" && value.length > 0 && value !== key,
        `${lang} is missing ${key}`,
      );
    }
  }

  // The rank chart must SAY which direction is better — a rank axis that does
  // not is the classic way a ranking graph misleads.
  for (const lang of ["en", "fr", "es"]) {
    assert.match(t(lang, "stats.chart.rank_axis"), /1/);
  }
});



