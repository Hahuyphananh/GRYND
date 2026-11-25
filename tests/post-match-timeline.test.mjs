/**
 * post-match-timeline.test.mjs
 *
 * The post-match "Mistake Finder" is money-adjacent: it is the GRYND PRO
 * feature, and every marker it shows is a claim about how the player played.
 * So the rules are pinned without a browser or a database:
 *
 *   1. Events come from the STORED logs only — ordered by their real
 *      timestamps, with the per-seat think time the rows actually contain.
 *   2. A "wasted move" requires the review's own rating or tag. A move is never
 *      called wasted because it looks odd.
 *   3. A "time-loss spike" requires a pause of at least 5s AND at least 3x the
 *      opponent's median pace (own median if there is no opponent log).
 *   4. Lead changes are tracked over foundation-card counts derived from the
 *      move kinds; ties are not a lead.
 *   5. Free players get basics only: the route answers `locked: true` with no
 *      events, and never spends a free account's analysis allowance.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_MARKERS,
  TIME_LOSS_MIN_MS,
  buildMatchTimeline,
  foundationStep,
  seatBasicStats,
} from "../src/lib/solitaire-duel/postMatchTimeline.ts";

const read = (rel) => readFileSync(rel, "utf8");

const START = 1_700_000_000_000;
const at = (ms) => START + ms;
const move = (ply, kind, ms, extra = {}) => ({
  ply,
  kind,
  atMs: at(ms),
  move: { kind },
  ...extra,
});

const YOU = "player1";
const THEM = "player2";

function seats({ you = [], them = [] } = {}) {
  return [
    { seat: YOU, label: "You", moves: you, completed: true },
    { seat: THEM, label: "Opponent", moves: them },
  ];
}

test("foundation cards move exactly with the move kind", () => {
  assert.equal(foundationStep("waste-to-foundation"), 1);
  assert.equal(foundationStep("tableau-to-foundation"), 1);
  assert.equal(foundationStep("foundation-to-tableau"), -1);
  assert.equal(foundationStep("draw"), 0);
  assert.equal(foundationStep("tableau-to-tableau"), 0);
});

test("events are ordered by the stored clock and carry real think times", () => {
  const timeline = buildMatchTimeline({
    startedAtMs: START,
    endedAtMs: at(12_000),
    seats: seats({
      you: [move(0, "tableau-to-foundation", 1_000), move(1, "draw", 2_500)],
      them: [move(0, "draw", 1_800), move(1, "waste-to-foundation", 4_000)],
    }),
  });

  assert.deepEqual(
    timeline.events.map((event) => [event.seat, event.atMs]),
    [
      [YOU, 1_000],
      [THEM, 1_800],
      [YOU, 2_500],
      [THEM, 4_000],
    ],
  );
  assert.deepEqual(
    timeline.events.map((event) => event.gapMs),
    [null, null, 1_500, 2_200],
  );
  assert.deepEqual(
    timeline.events.filter((event) => event.seat === YOU).map((event) => event.progressAfter),
    [1, 1],
  );
  assert.equal(timeline.durationMs, 12_000);
  // Scrub indices are contiguous over the SORTED timeline.
  assert.deepEqual(
    timeline.events.map((event) => event.index),
    [0, 1, 2, 3],
  );
});

test("a wasted move needs the review's rating or tag — never a guess", () => {
  const timeline = buildMatchTimeline({
    startedAtMs: START,
    endedAtMs: null,
    seats: seats({
      you: [
        move(0, "draw", 1_000),
        move(1, "tableau-to-tableau", 2_000),
        move(2, "draw", 3_000),
      ],
    }),
    ratings: {
      seat: YOU,
      perMove: [
        { ply: 0, rating: "normal", tags: [] },
        { ply: 1, rating: "mistake", tags: [] },
        { ply: 2, rating: "normal", tags: ["wasted-redeal"] },
      ],
    },
  });

  assert.deepEqual(
    timeline.events.map((event) => event.wasted),
    [false, true, true],
  );
  assert.equal(timeline.summary.wastedMoves, 2);
  assert.ok(
    timeline.markers.every((marker) => marker.kind === "wasted-move"),
    "an unrated log has no rating-driven markers",
  );
});

test("ratings stay on the seat they were computed for", () => {
  // The route only ever passes the VIEWER's analysis, but the builder must not
  // leak a rating onto the other seat if a caller passes the wrong one.
  const timeline = buildMatchTimeline({
    startedAtMs: START,
    endedAtMs: null,
    seats: seats({
      you: [move(0, "draw", 1_000)],
      them: [move(0, "draw", 1_100)],
    }),
    ratings: {
      seat: THEM,
      perMove: [{ ply: 0, rating: "blunder", tags: [] }],
    },
  });

  const you = timeline.events.find((event) => event.seat === YOU);
  const them = timeline.events.find((event) => event.seat === THEM);
  assert.equal(you.wasted, false, "the viewer's move is not rated by their opponent's log");
  assert.equal(them.wasted, true, "a rating follows the seat it was computed for");
  assert.equal(timeline.events.filter((event) => event.seat === YOU)[0].rating, null);
});

test("a time-loss spike is a long pause compared with the opponent", () => {
  const timeline = buildMatchTimeline({
    startedAtMs: START,
    endedAtMs: null,
    seats: seats({
      // Think times 1s and 7s.
      you: [move(0, "draw", 1_000), move(1, "draw", 2_000), move(2, "draw", 9_000)],
      // Opponent thinks in ~1.2s and ~1.6s.
      them: [move(0, "draw", 1_200), move(1, "draw", 2_400), move(2, "draw", 4_000)],
    }),
  });

  const spikes = timeline.markers.filter((marker) => marker.kind === "time-loss");
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].seat, YOU);
  assert.equal(spikes[0].ply, 3, "the third move is the 7s think");
  assert.ok(
    timeline.events.find((event) => event.seat === YOU && event.ply === 3).gapMs >=
      TIME_LOSS_MIN_MS,
  );
});

test("a slow game with no baseline pause is not labelled a time loss", () => {
  const timeline = buildMatchTimeline({
    startedAtMs: START,
    endedAtMs: null,
    seats: seats({
      you: [move(0, "draw", 30_000), move(1, "draw", 31_000)],
      them: [move(0, "draw", 30_500), move(1, "draw", 31_500)],
    }),
  });
  // The first move has no gap at all; both seats are evenly paced afterwards.
  assert.equal(
    timeline.markers.filter((marker) => marker.kind === "time-loss").length,
    0,
  );
});

test("lead changes follow foundation cards and ignore ties", () => {
  const timeline = buildMatchTimeline({
    startedAtMs: START,
    endedAtMs: null,
    seats: seats({
      you: [
        move(0, "tableau-to-foundation", 1_000),
        move(1, "tableau-to-foundation", 3_000),
      ],
      them: [
        move(0, "waste-to-foundation", 2_000),
        move(1, "waste-to-foundation", 4_000),
      ],
    }),
  });

  const leads = timeline.markers.filter((marker) => marker.kind === "lead-change");
  // You lead 1-0, they tie 1-1 (not a lead), you lead 2-1, they tie 2-2.
  assert.equal(leads.length, 2);
  assert.equal(timeline.summary.turningPoints, 2);
  assert.ok(leads.every((marker) => marker.seat === YOU));
});

test("basic stats are derived from the seat's own moves", () => {
  const stats = seatBasicStats({
    seat: YOU,
    label: "You",
    moves: [
      move(0, "tableau-to-foundation", 1_000),
      move(1, "waste-to-foundation", 4_000),
      move(2, "draw", 10_000),
    ],
  });

  assert.equal(stats.moves, 3);
  assert.equal(stats.peakProgress, 2);
  assert.equal(stats.medianMoveMs, 4_500);
  assert.equal(stats.paceMsPerMove, 4_500);
  assert.equal(stats.completed, false);
});

test("an empty log produces no events and no invented markers", () => {
  const timeline = buildMatchTimeline({
    startedAtMs: START,
    endedAtMs: at(5_000),
    seats: [],
  });
  assert.deepEqual(timeline.events, []);
  assert.deepEqual(timeline.markers, []);
  assert.equal(timeline.summary.turningPoints, 0);
  assert.equal(timeline.summary.wastedMoves, 0);
  assert.equal(timeline.summary.timeLossSpikes, 0);
  assert.equal(timeline.durationMs, 5_000);
});

test("the marker list stays a readable picker", () => {
  const you = [];
  for (let i = 0; i < MAX_MARKERS + 30; i += 1) {
    you.push(move(i, "tableau-to-foundation", i * 10_000));
  }
  const timeline = buildMatchTimeline({
    startedAtMs: START,
    endedAtMs: null,
    seats: seats({ you }),
    ratings: {
      seat: YOU,
      perMove: you.map((entry) => ({ ply: entry.ply, rating: "blunder", tags: [] })),
    },
  });
  assert.ok(timeline.summary.wastedMoves > MAX_MARKERS);
  assert.equal(timeline.markers.length, MAX_MARKERS);
});

// ── The wired-up route ──────────────────────────────────────────────────────

const ROUTE = read(
  "src/app/api/solitaire-duel/match/[matchId]/timeline/route.ts",
);

test("the timeline route is server-authoritative about PRO", () => {
  assert.match(ROUTE, /requirePracticePlayer\(\)/);
  assert.match(ROUTE, /fetchMatch\(\{ userId, matchId \}\)/);
  assert.match(ROUTE, /getMembershipTier\(userId\)\) === "pro"/);
  assert.match(ROUTE, /locked: true/);
  assert.match(ROUTE, /locked: false/);
  // The timeline (and its analysis) is built only after the PRO branch.
  const lockedAt = ROUTE.indexOf("locked: true");
  const analysisAt = ROUTE.indexOf("loadReviewAnalysis(");
  assert.ok(lockedAt > 0 && analysisAt > lockedAt, "free requests never cost an analysis");
});

test("the route serves only finished matches and gates the board preview", () => {
  assert.match(ROUTE, /TERMINAL_STATUSES\.includes\(match\.status\)/);
  assert.match(ROUTE, /MATCH_STATUS\.CANCELLED/);
  assert.match(ROUTE, /fetchSeatMoves\(String\(match\.id\), seat\)/);
  assert.match(ROUTE, /fetchSeatMoves\(String\(match\.id\), opposingSeat\)/);
  // The deal is only in the PRO preview, i.e. after the free branch returned.
  const lockedAt = ROUTE.indexOf("locked: true");
  const previewAt = ROUTE.indexOf("preview:");
  assert.ok(lockedAt > 0 && previewAt > lockedAt, "the preview follows the PRO gate");
  assert.match(ROUTE, /preview:\s*\{\s*game: "solitaire",\s*deal: match\.deal/);
});

test("the route links the panel to the full match review", () => {
  assert.match(ROUTE, /reviewHref: `\/solitaire\/review\/duel\/\$\{encodeURIComponent/);
});

test("an adapter's progress series drives the timeline (Sudoku cells)", () => {
  const timeline = buildMatchTimeline({
    startedAtMs: START,
    endedAtMs: null,
    progressMax: 60,
    seats: [
      {
        seat: YOU,
        label: "You",
        progress: [5, 9],
        moves: [
          { ...move(0, "place", 1_000), label: "R1C1 = 4" },
          { ...move(1, "place", 2_000), label: "R2C2 = 7" },
        ],
      },
      {
        seat: THEM,
        label: "Opponent",
        progress: [7],
        moves: [{ ...move(0, "place", 1_500), label: "R3C3 = 2" }],
      },
    ],
  });

  assert.equal(timeline.progressMax, 60);
  assert.deepEqual(
    timeline.events.map((event) => event.progressAfter),
    [5, 7, 9],
  );
  assert.deepEqual(
    timeline.events.map((event) => event.moveLabel),
    ["R1C1 = 4", "R3C3 = 2", "R2C2 = 7"],
  );
});

test("a game-judged waste needs the explicit flag, not a guess", () => {
  const timeline = buildMatchTimeline({
    startedAtMs: START,
    endedAtMs: null,
    seats: seats({ you: [move(0, "place", 1_000)] }),
    ratings: {
      seat: YOU,
      perMove: [{ ply: 0, rating: "normal", wasted: true }],
    },
  });

  assert.equal(timeline.events[0].wasted, true);
  assert.equal(timeline.summary.wastedMoves, 1);
  assert.equal(timeline.markers[0].kind, "wasted-move");
});

const SUDOKU_ROUTE = read(
  "src/app/api/sudoku-duel/match/[matchId]/timeline/route.ts",
);

test("the Sudoku adapter gates PRO and never returns the solution", () => {
  assert.match(SUDOKU_ROUTE, /requirePracticePlayer\(\)/);
  assert.match(SUDOKU_ROUTE, /getMembershipTier\(userId\)\) === "pro"/);
  assert.match(SUDOKU_ROUTE, /locked: true/);
  assert.match(SUDOKU_ROUTE, /progressMax/);
  assert.match(SUDOKU_ROUTE, /game: "sudoku"/);
  assert.match(SUDOKU_ROUTE, /correct: solution\[index\] === Number\(action\.value\)/);
  // The solution is read for judging, never serialised as a payload key.
  assert.doesNotMatch(SUDOKU_ROUTE, /\n\s*solution\s*:/);
  // A wrong placement or a cleared correct entry is the game's own waste signal.
  assert.match(SUDOKU_ROUTE, /wasted = true/);
  assert.match(SUDOKU_ROUTE, /held\.delete\(index\)/);
});

test("the Sudoku result screen mounts the same Mistake Finder", () => {
  const page = read("src/app/casino/sudoku-duel/[matchId]/PageClient.tsx");
  assert.match(
    page,
    /import MatchTimeline from "\.\.\/\.\.\/\.\.\/\.\.\/components\/solitaire-duel\/MatchTimeline"/,
  );
  assert.match(page, /<MatchTimeline[\s\S]{0,200}gameKey="sudoku-duel"/);
});

// ── The result-screen mount ────────────────────────────────────────────────

test("the result screen mounts the Mistake Finder with the settled match id", () => {
  const page = read("src/app/casino/solitaire-duel/[matchId]/PageClient.tsx");
  assert.match(page, /import MatchTimeline from "\.\.\/\.\.\/\.\.\/\.\.\/components\/solitaire-duel\/MatchTimeline"/);
  assert.match(page, /<MatchTimeline matchId=\{match \? String\(match\.matchId\) : ""\} \/>/);
  // Inside the result screen's extra content, i.e. only after the match.
  const resultAt = page.indexOf("<PvpResultScreen");
  const mountAt = page.indexOf("<MatchTimeline");
  assert.ok(resultAt > 0 && mountAt > resultAt, "the timeline belongs to the result");
  const extraAt = page.indexOf("extraContent=", resultAt);
  assert.ok(extraAt > 0 && mountAt > extraAt);
});

test("the panel asks the server instead of deciding PRO on the client", () => {
  const component = read("src/components/solitaire-duel/MatchTimeline.tsx");
  assert.match(
    component,
    /const endpoint = gameKey === "sudoku-duel" \? "sudoku-duel" : "solitaire-duel"/,
  );
  assert.match(component, /\/api\/\$\{endpoint\}\/match\/\$\{encodeURIComponent\(matchId\)\}\/timeline/);
  assert.match(component, /data\.pro && data\.timeline/);
  assert.match(component, /data-testid="match-timeline-locked"/);
  assert.match(component, /data-testid="match-timeline-scrub"/);
  assert.match(component, /href="\/upgrade-pro"/);
  assert.ok(
    !/(localStorage|sessionStorage)\s*\./.test(component),
    "PRO is never cached in client storage",
  );
});

test("the scrubber draws a board preview and links to the full review", () => {
  const component = read("src/components/solitaire-duel/MatchTimeline.tsx");
  assert.match(component, /reconstructReviewPosition\(/);
  assert.match(component, /data-testid="match-timeline-preview"/);
  assert.match(component, /data-testid="match-timeline-sudoku-grid"/);
  assert.match(component, /data\.preview/);
  assert.match(component, /data-testid="match-timeline-review-link"/);
  assert.match(component, /href=\{data\.reviewHref\}/);
  // The preview follows the VIEWER's own ply, not the global event index.
  assert.match(component, /event\.seat === yourSeat/);
});
