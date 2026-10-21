/**
 * Lane Rush — history + result integration tests.
 *
 * The history API and page serve TWO schemas from one table:
 *   * race rows (`game_state_version = 1`) — confirmed cumulative points;
 *   * preserved glass-bridge rows (`game_state_version = 0`) — rows crossed,
 *     broken tiles and public memory flags.
 *
 * These tests pin the contract that lets both render without crashing and
 * without showing 0/10 progress for a race. Like the repo's other PvP suites
 * there is no DB here, so the assertions are exact source contracts read from
 * the real route/page files.
 *
 * Run:  node --import tsx --test tests/lane-rush-history.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Normalise CRLF so multi-line structural assertions work on any OS.
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const route = read("src/app/api/lane-rush-duel/history/route.js");
const page = read("src/app/casino/lane-runner/history/PageClient.jsx");

test("history only lists FINISHED matches the viewer played", () => {
  assert.ok(
    route.includes('eq(laneRushDuelMatches.status, "finished")'),
    "unfinished and cancelled rows never appear",
  );
  assert.ok(
    route.includes("eq(laneRushDuelMatches.player1Id, clerkId)") &&
      route.includes("eq(laneRushDuelMatches.player2Id, clerkId)"),
    "both seats see the match",
  );
});

test("history stamps the mode from the persisted state version", () => {
  assert.ok(
    route.includes("const isRace = Number(row.gameStateVersion) === 1;"),
    "the version column is the only mode authority",
  );
  assert.ok(
    route.includes('mode: isRace ? "race" : "duel"'),
    "the client can tell the two schemas apart",
  );
  assert.ok(
    route.includes("gameStateVersion: Number(row.gameStateVersion) || 0"),
    "a legacy row reports version 0, never a guessed race",
  );
});

test("race rows report confirmed points, legacy rows keep bridge progress", () => {
  assert.ok(
    route.includes("row.p1Points : row.p2Points") &&
      route.includes("row.p2Points : row.p1Points"),
    "points are read from the viewer's seat",
  );
  assert.ok(
    route.includes("const myRow = Number(viewerIsPlayer1 ? row.p1Row : row.p2Row) || 0;"),
    "legacy progress is still returned",
  );
  assert.ok(
    route.includes("myPoints,") && route.includes("oppPoints,"),
    "both race scores ride the payload",
  );
});

test("history tolerates a legacy row with the older bridge columns", () => {
  assert.ok(
    route.includes("Array.isArray(row.broken) ? row.broken.length : 0"),
    "a null/absent broken column cannot throw",
  );
  assert.ok(
    route.includes("(viewerIsPlayer1 ? row.p1Flags : row.p2Flags) || []") &&
      route.includes("(viewerIsPlayer1 ? row.p2Flags : row.p1Flags) || []"),
    "absent flags fall back to an empty list",
  );
});

test("result and payout mapping is unchanged for both schemas", () => {
  assert.ok(
    route.includes('const isDraw = row.result === "draw" || !row.winnerId;'),
    "a row without a winner is a draw",
  );
  assert.ok(
    route.includes("const isWin = !isDraw && row.winnerId === clerkId;"),
    "a win is the stored winner id",
  );
  assert.ok(
    route.includes("payout: isWin ? prize : isDraw ? stake : 0"),
    "payout is prize on a win, stake refund on a draw, 0 on a loss",
  );
});

test("the history page renders points for a race and rows for a legacy match", () => {
  assert.ok(
    page.includes('{g.mode === "race" ? ('),
    "the race branch is explicit, not inferred from missing fields",
  );
  assert.ok(
    page.includes("{Number(g.myPoints) || 0}") &&
      page.includes("{Number(g.oppPoints) || 0}"),
    "a race shows its confirmed score",
  );
  assert.ok(
    page.includes("{Number(g.myRow) || 0}/10") &&
      page.includes("{Number(g.oppRow) || 0}/10"),
    "a legacy row still shows rows crossed",
  );
  assert.ok(
    !/myPoints \|\| 0\}\/10/.test(page),
    "race points are never rendered as rows",
  );
});

test("the history page targets the same win score as the engine", () => {
  assert.ok(
    page.includes('import { WIN_SCORE } from "../../../../lib/lane-rush/rules";'),
    "the target comes from the rulebook",
  );
  assert.ok(
    page.includes(">= WIN_SCORE"),
    "the target highlight uses that constant",
  );
  assert.ok(
    !page.includes(">= 1000"),
    "no hardcoded target can drift from rules.ts",
  );
});
