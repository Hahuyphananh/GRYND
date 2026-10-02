/**
 * leaderboard-record-sanity.test.mjs
 *
 * A hand-seeded user_stats row (e.g. wins=5000, losses=0, total_bets=413) must
 * never rank on a board. applyLeaderboardCounters is the only writer of
 * user_stats.wins/losses/total_bets and always moves them together, so
 * `wins + losses <= total_bets` holds for every app-written row; the boards
 * skip rows that violate it instead of rewriting anyone's data.
 *
 * Run:  node --import tsx --test tests/leaderboard-record-sanity.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { recordSanityClause } from "../src/lib/leaderboardQueries.js";

const read = (path) => fs.readFileSync(path, "utf8");

/** Minimal stand-in for the information_schema column cache. */
const columns = ({ stats = [], users = [] } = {}) => ({
  user_stats: new Set(stats),
  users: new Set(users),
});

const FULL = columns({ stats: ["wins", "losses", "total_bets"] });

test("the guard expresses the wins + losses <= total_bets invariant", () => {
  const clause = recordSanityClause(FULL);
  assert.match(clause, /s\.wins/);
  assert.match(clause, /s\.losses/);
  assert.match(clause, /s\.total_bets/);
  assert.match(clause, /COALESCE\(s\.wins, 0\)\s*\+\s*COALESCE\(s\.losses, 0\)\)\s*<=\s*COALESCE\(s\.total_bets, 0\)/);
  assert.match(clause, /<=/);
  // Non-negative counters too, so a negative record can't rank either.
  assert.match(clause, />=\s*0/);
});

test("the guard fails open when it cannot prove a violation", () => {
  // No total_bets column: nothing to compare against, so don't hide anyone.
  assert.equal(recordSanityClause(columns({ stats: ["wins", "losses"] })), "");
  assert.equal(recordSanityClause(columns({ stats: ["wins", "total_bets"] })), "");
  assert.equal(recordSanityClause(columns({ stats: ["wins"] })), "");
  assert.equal(recordSanityClause(columns({})), "");
});

test("the guard is applied to every board that routes through fetchRankedRows", () => {
  const src = read("src/lib/leaderboardQueries.js");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  // Composed alongside the category's own WHERE, not instead of it.
  assert.match(
    code,
    /const conditions = \[whereClause, recordSanityClause\(columns\)\]\.filter\(Boolean\)/,
  );
  assert.match(code, /WHERE \$\{conditions\.join\(" AND "\)\}/);
  // The old, unguarded interpolation must be gone.
  assert.doesNotMatch(code, /WHERE \$\{whereClause\}/);

  // Both the all-time and weekly boards go through fetchRankedRows.
  const fetchRankedRowsUses = code.match(/fetchRankedRows\(\{ \.\.\.config/);
  assert.ok(
    fetchRankedRowsUses,
    "fetchAllTimeLeaderboard / fetchWeeklyLeaderboard must call fetchRankedRows",
  );
});

test("only one writer exists, so the invariant can't be broken by a game hook", () => {
  // Guards the assumption the exclusion rule rests on: user_stats.wins/losses
  // move ONLY in leaderboardCounters.js, always next to total_bets. rating.js
  // and trophyStore.js write `wins` on their OWN tables (player_ratings /
  // player_trophies), which the record boards don't read.
  const counters = read("src/lib/leaderboardCounters.js");
  assert.match(counters, /wins = user_stats\.wins \+ CASE/);
  assert.match(counters, /total_bets = user_stats\.total_bets \+ 1/);

  for (const path of ["src/lib/rating.js", "src/lib/trophyStore.js"]) {
    const src = read(path);
    assert.doesNotMatch(
      src,
      /INSERT INTO user_stats|UPDATE user_stats/,
      `${path} must not write user_stats directly`,
    );
  }
});
