/**
 * GRYND PRO statistics — the QUERY LAYER, against a real PostgreSQL.
 *
 * tests/pro-stats.test.mjs pins the pure maths and the contracts by reading
 * source. This suite runs the other half: `src/lib/stats/queries.ts` against an
 * actual server, so a wrong column, a broken join, a mis-ordered
 * `DISTINCT ON`, an ON CONFLICT that hits the wrong index or a parameter that
 * binds as the wrong type fails here instead of in production.
 *
 * HOW IT STAYS SAFE
 * -----------------
 * It never touches the application's tables. Setup creates a throwaway schema
 * (`pro_stats_verify`), builds miniature `users` / `rating_events` /
 * `trophy_events` / `player_ratings` / `player_trophies` /
 * `player_rank_snapshots` tables in it, seeds a hand-computed fixture, and
 * points the app's own pool at that schema alone via the connection string's
 * libpq `options` parameter (`-c search_path=pro_stats_verify`). Unqualified
 * names in the query layer therefore resolve to the fixture, and the schema is
 * dropped in `after()`. Nothing is read from, or written to, a real table.
 *
 * The fixture is deliberately realistic: every duel match has a row in BOTH
 * journals (the two writers settle the same match), and the placement table has
 * a trophy row only — so the suite proves a match is counted once, with its
 * trophy value attached, and that a trophy-only game is still counted.
 *
 * Run: npm run test:pro-stats-db   (needs DATABASE_URL, e.g. --env-file=.env.local)
 * Skips — never fails — when no database is configured.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "pg";

const MIGRATION_FILE = "src/db/migrations/0216_player_rank_snapshots.sql";

const SCHEMA = "pro_stats_verify";
const CONNECTION = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const enabled = Boolean(CONNECTION);

/**
 * Strip `sslmode` from the URL, the way src/db/pool.ts does: `pg` merges the
 * connection string OVER the explicit `ssl` option, and a pooled provider
 * (Supabase) serves a self-signed leaf that `sslmode=require` refuses.
 */
const sanitized = CONNECTION.replace(/([?&])sslmode=[^&]*(&|$)/g, (_m, prefix, suffix) =>
  suffix === "&" ? prefix : "",
);

// ── The fixture ────────────────────────────────────────────────────────────
//
//  ME     — 31 settled results: 10 Chess, 10 Pool, 10 Uno (each duel in both
//           journals) plus one trophy-only Tower Arena table.
//  RIVAL  — established in the same three games at a higher average, so ME is
//           rank 2, never rank 1 by accident.
//  EMPTY  — an account that has never played, for the empty states.
const ME = 9001;
const RIVAL = 9002;
const EMPTY = 9003;
const CLERK_ME = "pro-stats-verify-me";
const CLERK_RIVAL = "pro-stats-verify-rival";
const CLERK_EMPTY = "pro-stats-verify-empty";

/**
 * The rated schedule. `outcomes` are literal so the expected totals below are
 * arithmetic a reader can check by eye, and `rating` ends exactly on the value
 * seeded into `player_ratings` — which is the property that makes the Overall
 * Elo history's last point equal today's aggregate.
 */
const PLAN = [
  {
    gameKey: "chess",
    prefix: "chess-",
    startDay: 1,
    outcomes: ["win", "win", "win", "win", "win", "win", "win", "win", "loss", "draw"],
    rating: (index) => 1000 + 15 * (index + 1), // …1,150
  },
  {
    gameKey: "pool",
    prefix: "pool-",
    startDay: 11,
    outcomes: ["win", "loss", "win", "loss", "win", "loss", "win", "loss", "win", "loss"],
    rating: (index) => 1000 - 5 * (index + 1), // …950
  },
  {
    gameKey: "uno",
    prefix: "uno-",
    startDay: 21,
    outcomes: ["win", "win", "draw", "win", "win", "draw", "win", "win", "draw", "win"],
    rating: (index) => 1000 + 2 * (index + 1), // …1,020
  },
];

/** Trophy rule (src/lib/trophies.js): win +30, loss −30, draw 0, floored at 0. */
function trophyRun(outcomes) {
  let total = 0;
  return outcomes.map((outcome) => {
    if (outcome === "win") total += 30;
    else if (outcome === "loss") total = Math.max(0, total - 30);
    return total;
  });
}

function buildFixture() {
  const events = [];

  for (const plan of PLAN) {
    const trophies = trophyRun(plan.outcomes);
    plan.outcomes.forEach((outcome, index) => {
      const day = String(plan.startDay + index).padStart(2, "0");
      events.push({
        gameKey: plan.gameKey,
        matchId: `${plan.prefix}${index + 1}`,
        outcome,
        ratingAfter: plan.rating(index),
        trophiesAfter: trophies[index],
        at: `2026-03-${day}T12:00:00.000Z`,
      });
    });
  }

  // A placement table: trophies only, no Elo row anywhere (the real shape of
  // Crash Arena / Tower Arena / Roulette PvP settlement).
  events.push({
    gameKey: "tower-arena",
    matchId: "arena-1",
    outcome: "win",
    ratingAfter: null,
    trophiesAfter: 30,
    at: "2026-03-31T12:00:00.000Z",
  });

  return events;
}

const EVENTS = buildFixture();

async function insertRows(client, table, columns, rows, casts = {}) {
  if (!rows.length) return;
  const params = [];
  const tuples = rows.map(
    (row) =>
      `(${columns
        .map((column) => {
          params.push(row[column]);
          return `$${params.length}${casts[column] ? `::${casts[column]}` : ""}`;
        })
        .join(", ")})`,
  );
  await client.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`,
    params,
  );
}

let admin = null; // raw connection used ONLY to build/tear down the fixture schema

async function createFixture() {
  const host = (() => {
    try {
      return new URL(sanitized).hostname;
    } catch {
      return "";
    }
  })();
  admin = new Client({
    connectionString: sanitized,
    ssl: /localhost|127\.0\.0\.1|::1/.test(host) ? undefined : { rejectUnauthorized: false },
  });
  await admin.connect();

  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  // Unqualified names now resolve to the fixture, so the REAL migration file
  // below can be executed verbatim.
  await admin.query(`SET search_path TO ${SCHEMA}`);

  // Miniature mirrors of the real tables — only the columns the query layer
  // reads, with the real types (timestamp without time zone, varchar keys).
  // `users` comes first: migration 0216 references it.
  await admin.query(`
    CREATE TABLE ${SCHEMA}.users (
      id integer PRIMARY KEY,
      clerk_id text NOT NULL,
      name text,
      selected_icon text
    );
    CREATE TABLE ${SCHEMA}.rating_events (
      user_id integer NOT NULL,
      game_key varchar(64) NOT NULL,
      match_id varchar(128) NOT NULL,
      opponent_id integer,
      outcome varchar(8) NOT NULL,
      rating_after integer NOT NULL,
      delta integer NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, game_key, match_id)
    );
    CREATE TABLE ${SCHEMA}.trophy_events (
      user_id integer NOT NULL,
      game_key varchar(64) NOT NULL,
      match_id varchar(128) NOT NULL,
      opponent_id integer,
      outcome varchar(8) NOT NULL,
      trophies_after integer NOT NULL,
      delta integer NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, game_key, match_id)
    );
    CREATE TABLE ${SCHEMA}.player_ratings (
      user_id integer NOT NULL,
      game_key varchar(64) NOT NULL,
      rating integer NOT NULL,
      games_rated integer NOT NULL,
      PRIMARY KEY (user_id, game_key)
    );
    CREATE TABLE ${SCHEMA}.player_trophies (
      user_id integer NOT NULL,
      game_key varchar(64) NOT NULL,
      trophies integer NOT NULL,
      PRIMARY KEY (user_id, game_key)
    );
  `);

  // `player_rank_snapshots` is created by RUNNING THE REAL MIGRATION FILE, not
  // by a copy of its DDL: if the file is not valid SQL, references a column
  // that does not exist or forgets the unique index the upsert needs, this
  // fails here. (It is additive and IF NOT EXISTS throughout, so replaying it
  // against the fixture is safe.)
  await admin.query(fs.readFileSync(MIGRATION_FILE, "utf8"));

  await insertRows(
    admin,
    `${SCHEMA}.users`,
    ["id", "clerk_id", "name", "selected_icon"],
    [
      { id: ME, clerk_id: CLERK_ME, name: "Verifier", selected_icon: "default" },
      { id: RIVAL, clerk_id: CLERK_RIVAL, name: "Rival", selected_icon: "default" },
      { id: EMPTY, clerk_id: CLERK_EMPTY, name: "Newcomer", selected_icon: "default" },
    ],
  );

  // Both journals carry every duel match (as the two settlement writers do).
  await insertRows(
    admin,
    `${SCHEMA}.rating_events`,
    ["user_id", "game_key", "match_id", "opponent_id", "outcome", "rating_after", "delta", "created_at"],
    EVENTS.filter((event) => event.ratingAfter !== null).map((event) => ({
      user_id: ME,
      game_key: event.gameKey,
      match_id: event.matchId,
      opponent_id: RIVAL,
      outcome: event.outcome,
      rating_after: event.ratingAfter,
      delta: 0,
      created_at: event.at,
    })),
    { created_at: "timestamp" },
  );

  await insertRows(
    admin,
    `${SCHEMA}.trophy_events`,
    ["user_id", "game_key", "match_id", "opponent_id", "outcome", "trophies_after", "delta", "created_at"],
    EVENTS.map((event) => ({
      user_id: ME,
      game_key: event.gameKey,
      match_id: event.matchId,
      opponent_id: RIVAL,
      outcome: event.outcome,
      trophies_after: event.trophiesAfter,
      delta: event.outcome === "win" ? 30 : event.outcome === "loss" ? -30 : 0,
      created_at: event.at,
    })),
    { created_at: "timestamp" },
  );

  // Current values. The duel games end on the same rating their last journal
  // row recorded (a consistency the real writers also maintain), so the Overall
  // Elo curve's final point must equal the aggregate computed from these rows.
  await insertRows(
    admin,
    `${SCHEMA}.player_ratings`,
    ["user_id", "game_key", "rating", "games_rated"],
    [
      { user_id: ME, game_key: "chess", rating: 1150, games_rated: 15 },
      { user_id: ME, game_key: "pool", rating: 950, games_rated: 10 },
      { user_id: ME, game_key: "uno", rating: 1020, games_rated: 10 },
      { user_id: RIVAL, game_key: "chess", rating: 1200, games_rated: 12 },
      { user_id: RIVAL, game_key: "pool", rating: 1100, games_rated: 12 },
      { user_id: RIVAL, game_key: "uno", rating: 1100, games_rated: 12 },
    ],
  );

  await insertRows(
    admin,
    `${SCHEMA}.player_trophies`,
    ["user_id", "game_key", "trophies"],
    [
      { user_id: ME, game_key: "chess", trophies: 210 },
      { user_id: ME, game_key: "pool", trophies: 0 },
      { user_id: ME, game_key: "uno", trophies: 210 },
      { user_id: ME, game_key: "tower-arena", trophies: 30 },
    ],
  );

  // Point the app's OWN pool at the fixture schema — and at nothing else.
  const url =
    CONNECTION +
    (CONNECTION.includes("?") ? "&" : "?") +
    "options=" +
    encodeURIComponent(`-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url;
  process.env.POSTGRES_URL = url;
}

before(async () => {
  if (!enabled) return;
  await createFixture();
});

after(async () => {
  if (admin) {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  }
});

/** The app modules are imported lazily so nothing connects before `before()`. */
async function queries() {
  return import("../src/lib/stats/queries.ts");
}

const skip = enabled ? false : "DATABASE_URL is not configured";

test("migration 0216 runs on PostgreSQL and creates the indexed snapshot table", { skip }, async () => {
  const { rows: indexes } = await admin.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`,
    [SCHEMA],
  );
  assert.ok(
    indexes.some((row) => row.indexname === "player_rank_snapshots_user_bucket_unique"),
    "the (user_id, bucket) duplicate guard must exist",
  );
  assert.ok(
    indexes.some((row) => row.indexname === "player_rank_snapshots_bucket_idx"),
    "the per-day sweep needs its own index",
  );

  const { rows: constraints } = await admin.query(
    `SELECT confrelid::regclass::text AS ref, confdeltype
     FROM pg_constraint WHERE conname = 'player_rank_snapshots_user_id_fkey'`,
  );
  assert.equal(constraints.length, 1, "the snapshot row must reference a user");
  assert.equal(constraints[0].ref, "users");
  assert.equal(constraints[0].confdeltype, "c", "ON DELETE CASCADE");
});

test("the dashboard totals are exact, and a match in both journals counts once", { skip }, async () => {
  const { getPerformanceDashboard } = await queries();
  const payload = await getPerformanceDashboard({ clerkId: CLERK_ME });

  // 10 + 10 + 10 duels (one row kept per match, though both journals carry it)
  // plus the trophy-only table = 31 — not 61.
  assert.equal(payload.summary.matches, 31);
  assert.equal(payload.summary.wins, 21); // 8 + 5 + 7 + the table win
  assert.equal(payload.summary.losses, 6); // 1 + 5
  assert.equal(payload.summary.draws, 4); // 1 + 3
  assert.equal(payload.summary.decided, 27);
  // 21 / 27 — draws are reported, never in the denominator.
  assert.equal(payload.summary.winRate, 77.78);
  assert.equal(payload.summary.firstAt.slice(0, 10), "2026-03-01");
  assert.equal(payload.summary.lastAt.slice(0, 10), "2026-03-31");

  // The series was rebuilt from every match, and the cap did not bite.
  assert.equal(payload.series.rowsUsed, 31);
  assert.equal(payload.series.capped, false);

  // `recent` is newest-first and paginated in SQL.
  assert.equal(payload.recent.length, 10);
  assert.equal(payload.recent[0].gameKey, "tower-arena");
  assert.equal(payload.recent[0].opponentName, "Rival");
  assert.equal(payload.recent[0].trophyDelta, 30);

  assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("per-game rows carry the record, the current rating and the trophies", { skip }, async () => {
  const { getPerformanceDashboard } = await queries();
  const payload = await getPerformanceDashboard({ clerkId: CLERK_ME });

  const byGame = Object.fromEntries(payload.perGame.map((row) => [row.gameKey, row]));
  assert.deepEqual(Object.keys(byGame).sort(), ["chess", "pool", "tower-arena", "uno"]);

  assert.equal(byGame.chess.matches, 10);
  assert.equal(byGame.chess.wins, 8);
  assert.equal(byGame.chess.draws, 1);
  assert.equal(byGame.chess.winRate, 88.89); // 8 of 9 decided
  assert.equal(byGame.chess.rating, 1150);
  assert.equal(byGame.chess.trophies, 210);
  assert.match(byGame.chess.label, /chess/i, "the label is resolved server-side");

  assert.equal(byGame.pool.winRate, 50);
  assert.equal(byGame.uno.winRate, 100, "three draws do not count against the rate");
  assert.equal(byGame.uno.decided, 7);

  // The trophy-only table: no Elo at all, so its rating is null and never a
  // fabricated 1000.
  assert.equal(byGame["tower-arena"].rating, null);
  assert.equal(byGame["tower-arena"].trophies, 30);
  assert.equal(byGame["tower-arena"].winRate, 100);

  // Most-played first.
  assert.equal(payload.perGame[payload.perGame.length - 1].gameKey, "tower-arena");
});

test("the Elo, trophy and Overall Elo curves are rebuilt from the recorded results", { skip }, async () => {
  const { getPerformanceDashboard } = await queries();

  const chess = await getPerformanceDashboard({ clerkId: CLERK_ME, filters: { game: "chess" } });
  assert.deepEqual(
    chess.series.rating.map((point) => point.value),
    [1015, 1030, 1045, 1060, 1075, 1090, 1105, 1120, 1135, 1150],
  );
  assert.equal(chess.series.ratingChange, 135);
  // The curve is the SELECTED game's own count.
  assert.equal(chess.series.trophy.at(-1).value, 210);
  assert.equal(chess.series.trophyChange, 180); // 30 → 210

  const all = await getPerformanceDashboard({ clerkId: CLERK_ME });
  // Per-game Elo has no meaning without a game selected — the client asks for
  // one, so nothing is drawn here.
  assert.deepEqual(all.series.rating, []);
  assert.equal(all.series.ratingChange, null);
  assert.equal(all.series.game, null);

  // Cross-game trophies = each game's latest count, summed — the same rule the
  // platform's own total uses (210 + 0 + 210 + 30).
  assert.equal(all.series.trophy.at(-1).value, 450);

  // Overall Elo exists only once 3 games are ESTABLISHED (10 rated matches
  // each): the 30th match is the first point, and its value is the mean of the
  // ratings known then — which is today's aggregate too, because the fixture
  // ends on exactly those ratings.
  assert.equal(all.series.overallElo.length, 1);
  assert.equal(all.series.overallElo[0].overallElo, 1040);
  assert.equal(all.series.overallElo[0].eligibleGames, 3);
  assert.equal(all.series.overallElo[0].at.slice(0, 10), "2026-03-30");
  assert.equal(all.series.overallEloChange, null, "one point is not a trend");
});

test("date and game filters prune in SQL and stay inclusive", { skip }, async () => {
  const { getPerformanceDashboard } = await queries();

  const recent = await getPerformanceDashboard({
    clerkId: CLERK_ME,
    filters: { from: "2026-03-21T00:00:00.000Z" },
  });
  assert.equal(recent.summary.matches, 11); // the 10 Uno duels + the table
  assert.equal(recent.summary.wins, 8);
  assert.equal(recent.summary.draws, 3);
  assert.equal(recent.summary.winRate, 100, "nothing was lost in the window");
  assert.equal(recent.summary.firstAt.slice(0, 10), "2026-03-21");

  const bounded = await getPerformanceDashboard({
    clerkId: CLERK_ME,
    filters: { from: "2026-03-01T00:00:00.000Z", to: "2026-03-10T23:59:59.999Z" },
  });
  assert.equal(bounded.summary.matches, 10);
  assert.equal(bounded.summary.wins, 8);
  assert.equal(bounded.perGame.length, 1);
  assert.equal(bounded.perGame[0].gameKey, "chess");

  const combined = await getPerformanceDashboard({
    clerkId: CLERK_ME,
    filters: { game: "uno", from: "2026-03-25T00:00:00.000Z" },
  });
  assert.equal(combined.summary.matches, 6); // 25th–30th inclusive
  assert.equal(combined.summary.wins, 4);
  assert.equal(combined.summary.draws, 2);
  assert.equal(combined.series.trophy.at(-1).value, 210);

  // A window with no results is empty, not an error.
  const none = await getPerformanceDashboard({
    clerkId: CLERK_ME,
    filters: { from: "2027-01-01T00:00:00.000Z" },
  });
  assert.equal(none.summary.matches, 0);
  assert.equal(none.summary.winRate, null);
  assert.deepEqual(none.perGame, []);
  assert.deepEqual(none.series.rating, []);
  assert.deepEqual(none.recent, []);
});

test("recent results paginate in SQL, newest first", { skip }, async () => {
  const { fetchRecentResults, getPerformanceDashboard } = await queries();

  const pageOne = await fetchRecentResults(CLERK_ME, {}, { limit: 5, offset: 0 });
  const pageTwo = await fetchRecentResults(CLERK_ME, {}, { limit: 5, offset: 5 });
  assert.equal(pageOne.length, 5);
  assert.equal(pageTwo.length, 5);
  const idsOne = pageOne.map((entry) => entry.matchId);
  const idsTwo = pageTwo.map((entry) => entry.matchId);
  assert.equal(idsOne.filter((id) => idsTwo.includes(id)).length, 0, "pages must not overlap");

  const ordered = pageOne.map((entry) => entry.at);
  assert.deepEqual(ordered, [...ordered].sort().reverse(), "newest first");

  // The cap is enforced, so a caller cannot ask for an unbounded page.
  const oversized = await getPerformanceDashboard({
    clerkId: CLERK_ME,
    recentLimit: 10_000,
  });
  assert.equal(oversized.recent.length, 31);
});

test("recent form reads the newest matches, draws excluded", { skip }, async () => {
  const { getPerformanceDashboard } = await queries();
  const payload = await getPerformanceDashboard({ clerkId: CLERK_ME });

  assert.deepEqual(payload.recentForm.outcomes, [
    "win", // the table
    "win", "draw", "win", "win", "draw", "win", "win", "draw", "win",
  ]);
  assert.equal(payload.recentForm.winRate, 100);
  assert.deepEqual(payload.recentForm.streak, { outcome: "win", length: 2 });
});

test("an account with no settled match has honest empty states", { skip }, async () => {
  const { getPerformanceDashboard, captureRankSnapshot } = await queries();
  const payload = await getPerformanceDashboard({ clerkId: CLERK_EMPTY });

  assert.equal(payload.summary.matches, 0);
  assert.equal(payload.summary.winRate, null, "0 of 0 is not 0%");
  assert.equal(payload.summary.firstAt, null);
  assert.deepEqual(payload.perGame, []);
  assert.deepEqual(payload.series.rating, []);
  assert.deepEqual(payload.series.trophy, []);
  assert.deepEqual(payload.series.overallElo, []);
  assert.deepEqual(payload.recent, []);
  assert.deepEqual(payload.recentForm.outcomes, []);
  assert.equal(payload.recentForm.streak, null);
  assert.deepEqual(payload.rankHistory, []);

  // Not ranked yet ⇒ nothing is recorded, so no curve can be invented.
  assert.equal(await captureRankSnapshot(CLERK_EMPTY), null);
  assert.deepEqual(payload.eligibility, { provisionalGames: 10, overallMinGames: 3 });
});

test("rank snapshots are recorded per player and day, and rank like the board", { skip }, async () => {
  const { captureRankSnapshot, captureRankSnapshotsForAllRanked, fetchRankHistory, utcDayBucket } =
    await queries();
  const { fetchOverallEloLeaderboard } = await import("../src/lib/rating.js");

  const today = utcDayBucket();
  assert.deepEqual(await fetchRankHistory(CLERK_ME), [], "no history is fabricated");

  const snapshot = await captureRankSnapshot(CLERK_ME, today);
  assert.equal(snapshot.bucket, today);
  assert.equal(snapshot.overallElo, 1040); // mean(1150, 950, 1020)
  assert.equal(snapshot.eligibleGames, 3);
  assert.equal(snapshot.overallRank, 2, "the rival's higher average ranks first");

  // The stored rank agrees with the board the UI already shows.
  const board = await fetchOverallEloLeaderboard({ limit: 10, clerkId: CLERK_ME });
  assert.equal(board.items.length, 2);
  const boardRank = board.items.findIndex((row) => row.clerk_id === CLERK_ME) + 1;
  assert.equal(boardRank, snapshot.overallRank);
  assert.equal(board.me.clerk_id, CLERK_ME);
  assert.equal(Math.round(board.items[0].overallElo), 1133);

  // Idempotent: capturing the same day again refreshes it, never duplicates it.
  const again = await captureRankSnapshot(CLERK_ME, today);
  assert.equal(again.overallRank, 2);
  assert.equal((await fetchRankHistory(CLERK_ME)).length, 1);

  // The daily sweep records everyone ranked, and cannot double a player's day.
  const captured = await captureRankSnapshotsForAllRanked(today);
  assert.ok(captured >= 2, `the sweep must record every ranked player, got ${captured}`);
  const history = await fetchRankHistory(CLERK_ME);
  assert.equal(history.length, 1);
  assert.equal(history[0].overallRank, 2);
  assert.equal(history[0].bucket, today);

  const { rows } = await admin.query(
    `SELECT user_id, bucket, overall_rank FROM ${SCHEMA}.player_rank_snapshots ORDER BY overall_rank`,
  );
  assert.deepEqual(
    rows.map((row) => [row.user_id, row.overall_rank]),
    [
      [RIVAL, 1],
      [ME, 2],
    ],
  );

  // A past bucket is a separate point, so a curve can actually form.
  const yesterday = utcDayBucket(new Date(Date.now() - 86_400_000));
  await captureRankSnapshot(CLERK_ME, yesterday);
  const curve = await fetchRankHistory(CLERK_ME);
  assert.equal(curve.length, 2);
  assert.equal(curve[0].bucket, yesterday, "oldest first");
  assert.equal(curve[1].bucket, today);

  // …and a date range trims the curve.
  assert.equal((await fetchRankHistory(CLERK_ME, { from: today })).length, 1);
  assert.equal((await fetchRankHistory(CLERK_ME, { to: yesterday })).length, 1);
});

test("opening the dashboard refreshes today's snapshot without failing the read", { skip }, async () => {
  const { getPerformanceDashboard, utcDayBucket } = await queries();
  const today = utcDayBucket();

  const payload = await getPerformanceDashboard({
    clerkId: CLERK_RIVAL,
    includeRankCapture: true,
  });

  assert.ok(payload.rankHistory.length >= 1);
  const latest = payload.rankHistory.at(-1);
  assert.equal(latest.bucket, today);
  assert.equal(latest.overallRank, 1);
  assert.equal(latest.overallElo, 1133);
});
