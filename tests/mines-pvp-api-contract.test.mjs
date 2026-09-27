/**
 * Mines PvP — API contract (shared-board serialization + request shape).
 *
 * The server rules live in `src/lib/mines-pvp/serverStore.js` and are covered
 * by `mines-pvp-flow.test.mjs`. This file pins the API LAYER:
 *
 *   • what the routes accept (only `{ cellIndex }` — never `isMine`, `hint`,
 *     `winner`, `board`)
 *   • what an ACTIVE match exposes (shared reveals + shared clues + both
 *     seats' flags + turn/seat identity) and what it must NEVER expose (the
 *     hidden mine list)
 *   • what a FINISHED match exposes (full board + winnerId + winReason)
 *   • that the AI-turn endpoint consumes the same serializer instead of
 *     echoing the raw row
 *
 * The serializer is pure, so the visibility rules are asserted directly
 * against the real function rather than by pattern-matching source.
 *
 * Run:  node --import tsx --test tests/mines-pvp-api-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  normaliseMatchForViewer,
  scrubPicksForViewer,
} from "../src/lib/mines-pvp/matchView.js";
import { MATCH_STATUS, WIN_REASON } from "../src/lib/mines-pvp/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, "..", rel), "utf8");

const PICK_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/pick/route.js");
const FLAG_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/flag/route.js");
const MATCH_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/route.js");
const AI_ROUTE = read("src/app/api/mines-pvp/match/[matchId]/ai-turn/route.js");

// ── Fixtures ─────────────────────────────────────────────────────────────

const P1 = "user_1";
const P2 = "user_2";
// A 3-mine board: 0, 7, 24 are mines; everything else is safe.
const MINES = [0, 7, 24];
const BOARD = { size: 5, mines: MINES };

function activeMatch(overrides = {}) {
  return {
    id: 42,
    player1Id: P1,
    player2Id: P2,
    isAi: false,
    stakeAmount: "0.00",
    minesCount: 3,
    status: MATCH_STATUS.P1_TURN,
    firstPlayerId: P1,
    currentTurnUserId: P1,
    roundDeadline: new Date("2026-01-01T00:00:20.000Z"),
    board: BOARD,
    picks: [],
    p1Flags: [],
    p2Flags: [],
    p1Pick: null,
    p2Pick: null,
    p1PickIsMine: null,
    p2PickIsMine: null,
    p1AutoPicked: false,
    p2AutoPicked: false,
    p1PickedAt: null,
    p2PickedAt: null,
    result: null,
    winnerId: null,
    winReason: null,
    prizePaid: "0.00",
    houseFee: "0.00",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    endedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

// A reveal by `seat` on `cell` with the server-computed clue.
function reveal({ seat, userId, cell, hint, autoPicked = false }) {
  return {
    userId,
    seat,
    cell,
    isMine: false,
    hint,
    flag: false,
    mercy: false,
    autoPicked,
    pickedAt: "2026-01-01T00:00:01.000Z",
  };
}

// A CLAIM by `seat` on `cell`. Note there is deliberately no verdict.
function claim({ seat, userId, cell }) {
  return {
    userId,
    seat,
    cell,
    isMine: null,
    hint: null,
    flag: true,
    kind: "flag",
    mercy: false,
    autoPicked: false,
    pickedAt: "2026-01-01T00:00:02.000Z",
  };
}

const json = (value) => JSON.stringify(value);

// ════════════════════════════════════════════════════════════════════════
// ACTIVE match — shared board state, hidden mines
// ════════════════════════════════════════════════════════════════════════

test("active match: the hidden board is never serialised", () => {
  const match = activeMatch();
  for (const viewer of [P1, P2]) {
    const view = normaliseMatchForViewer(match, viewer);
    assert.equal(view.board, null, "board must be null while the match is live");
    assert.equal(view.minesCount, 3, "the COUNT is public; the layout is not");
    // The mine layout must not appear anywhere in the payload.
    assert.equal("mines" in view, false);
    assert.equal(json(view).includes("[0,7,24]"), false);
    assert.equal(/"(board|boardSnapshot)":\s*\{/.test(json(view)), false);
  }
});

test("active match: both seats receive the same revealed cells AND clues", () => {
  const match = activeMatch({
    picks: [
      reveal({ seat: "player1", userId: P1, cell: 12, hint: 2 }),
      reveal({ seat: "player2", userId: P2, cell: 13, hint: 1 }),
    ],
    status: MATCH_STATUS.P2_TURN,
    currentTurnUserId: P2,
    p1Pick: 12,
    p2Pick: 13,
    p1PickIsMine: false,
    p2PickIsMine: false,
  });

  for (const viewer of [P1, P2]) {
    const view = normaliseMatchForViewer(match, viewer);
    assert.equal(view.picks.length, 2);
    const byCell = new Map(view.picks.map((p) => [p.cell, p]));
    // P1's reveal carries ITS clue for P2 too (the shared-board requirement).
    assert.equal(byCell.get(12).hint, 2);
    assert.equal(byCell.get(13).hint, 1);
    assert.equal(byCell.get(12).seat, "player1");
    assert.equal(byCell.get(13).seat, "player2");
    // ...and never the mine verdict while the match is live.
    for (const p of view.picks) assert.equal(p.isMine, false);
  }
});

test("active match: turn, deadline and seat identity are all exposed", () => {
  const match = activeMatch({
    status: MATCH_STATUS.P2_TURN,
    currentTurnUserId: P2,
    firstPlayerId: P1,
  });
  const asP1 = normaliseMatchForViewer(match, P1);
  assert.equal(asP1.currentTurnUserId, P2);
  assert.equal(asP1.player1Id, P1);
  assert.equal(asP1.player2Id, P2);
  assert.equal(asP1.viewerIsPlayer1, true);
  assert.equal(asP1.isViewerTurn, false);
  assert.equal(asP1.status, MATCH_STATUS.P2_TURN);
  assert.ok(asP1.roundDeadline instanceof Date);

  const asP2 = normaliseMatchForViewer(match, P2);
  assert.equal(asP2.viewerIsPlayer1, false);
  assert.equal(asP2.isViewerTurn, true);
});

test("active match: both players' flag claims are public and independent", () => {
  const match = activeMatch({
    status: MATCH_STATUS.P1_TURN,
    picks: [claim({ seat: "player1", userId: P1, cell: 17 })],
    p1Flags: [17],
    // The same cell may be claimed by both seats.
    p2Flags: [17, 19],
  });
  for (const viewer of [P1, P2]) {
    const view = normaliseMatchForViewer(match, viewer);
    assert.deepEqual(view.p1Flags, [17]);
    assert.deepEqual(view.p2Flags, [17, 19]);
  }
  // A claim exposes no verdict and no clue.
  const entry = normaliseMatchForViewer(match, P1).picks[0];
  assert.equal(entry.flag, true);
  assert.equal(entry.hint, null);
  assert.equal(entry.isMine, false);
});

test("active match: flag claims do not count as discovered safe cells", () => {
  const match = activeMatch({
    picks: [
      reveal({ seat: "player1", userId: P1, cell: 12, hint: 2 }),
      claim({ seat: "player2", userId: P2, cell: 18 }),
    ],
    p2Flags: [18],
  });
  const view = normaliseMatchForViewer(match, P1);
  // 25 - 3 mines = 22 safe cells; ONE safe reveal so far (the claim is not one).
  assert.equal(view.safeTilesRemaining, 21);
  assert.equal(view.pickCount, 2, "claims still consume a turn and are counted");
});

test("active match: the viewer's own auto-pick shows, the opponent's is scrubbed", () => {
  const match = activeMatch({
    picks: [
      reveal({ seat: "player1", userId: P1, cell: 12, hint: 2, autoPicked: true }),
      reveal({ seat: "player2", userId: P2, cell: 13, hint: 1, autoPicked: true }),
    ],
  });
  const asP1 = normaliseMatchForViewer(match, P1);
  assert.equal(asP1.picks[0].autoPicked, true, "own AFK state is visible");
  assert.equal(asP1.picks[1].autoPicked, false, "opponent's AFK state is not");
});

test("waiting / ready / cancelled matches stay scrubbed too", () => {
  for (const status of [
    MATCH_STATUS.WAITING,
    MATCH_STATUS.READY,
    MATCH_STATUS.CANCELLED,
  ]) {
    const view = normaliseMatchForViewer(activeMatch({ status }), P1);
    assert.equal(view.board, null, `${status} must not leak the board`);
  }
  assert.equal(normaliseMatchForViewer(null, P1), null);
});

// ════════════════════════════════════════════════════════════════════════
// FINISHED match — full reveal + winner/winReason
// ════════════════════════════════════════════════════════════════════════

test("finished match: board, verdicts, winnerId and winReason are all revealed", () => {
  const match = activeMatch({
    status: MATCH_STATUS.FINISHED,
    picks: [
      reveal({ seat: "player1", userId: P1, cell: 12, hint: 2 }),
      { ...claim({ seat: "player2", userId: P2, cell: 7 }), isMine: null },
    ],
    p2Flags: [7],
    winnerId: P2,
    winReason: WIN_REASON.ALL_MINES_FLAGGED,
    result: "player2",
    currentTurnUserId: null,
    roundDeadline: null,
    endedAt: new Date("2026-01-01T00:00:30.000Z"),
    prizePaid: "10.00",
    houseFee: "1.00",
  });

  const view = normaliseMatchForViewer(match, P2);
  assert.deepEqual(view.board, BOARD, "the settled board is revealed");
  assert.equal(view.winnerId, P2);
  assert.equal(view.winReason, WIN_REASON.ALL_MINES_FLAGGED);
  assert.equal(view.result, "player2");
  // The winner sees the pot; the loser sees zeros (no payout leak).
  assert.equal(view.prizePaid, 10);
  assert.equal(view.houseFee, 1);
  assert.equal(normaliseMatchForViewer(match, P1).prizePaid, 0);
  assert.equal(normaliseMatchForViewer(match, P1).houseFee, 0);
});

test("finished match: a mine hit exposes the detonated cell's verdict", () => {
  const match = activeMatch({
    status: MATCH_STATUS.FINISHED,
    picks: [
      reveal({ seat: "player1", userId: P1, cell: 12, hint: 2 }),
      {
        userId: P1,
        seat: "player1",
        cell: 7,
        isMine: true,
        hint: null,
        flag: false,
        autoPicked: false,
        pickedAt: "2026-01-01T00:00:03.000Z",
      },
    ],
    winnerId: P2,
    winReason: WIN_REASON.MINE_HIT,
  });
  const view = normaliseMatchForViewer(match, P2);
  const hit = view.picks.find((p) => p.cell === 7);
  assert.equal(hit.isMine, true);
  assert.equal(view.winReason, WIN_REASON.MINE_HIT);
  assert.equal(view.winnerId, P2);
});

// ════════════════════════════════════════════════════════════════════════
// scrubPicksForViewer — the low-level per-entry contract
// ════════════════════════════════════════════════════════════════════════

test("scrubPicksForViewer: drops malformed entries and normalises cells", () => {
  const picks = scrubPicksForViewer(
    [null, "nope", { cell: "12", seat: "player1", userId: P1, hint: "2" }, 7],
    P1,
    false,
  );
  assert.equal(picks.length, 1);
  assert.equal(picks[0].cell, 12);
  assert.equal(picks[0].hint, 2);
  assert.equal(scrubPicksForViewer(null, P1, false).length, 0);
});

// ════════════════════════════════════════════════════════════════════════
// Request contract — the server decides everything authoritative
// ════════════════════════════════════════════════════════════════════════

test("the pick route accepts ONLY { cellIndex } and trusts no client result", () => {
  assert.match(PICK_ROUTE, /const cellIndex = Number\(body\?\.cellIndex\)/);
  // Nothing else is read off the body.
  assert.doesNotMatch(PICK_ROUTE, /body\?\.(isMine|hint|winner|board|flags|winnerId|winReason)/);
  assert.doesNotMatch(PICK_ROUTE, /body\.(isMine|hint|winner|board)/);
  // The response is a thin acknowledgement; it never echoes board state.
  assert.doesNotMatch(PICK_ROUTE, /board:/);
  assert.match(PICK_ROUTE, /normalisePickResult/);
});

test("the flag route accepts ONLY { cellIndex } and trusts no client verdict", () => {
  assert.match(FLAG_ROUTE, /const cellIndex = Number\(body\?\.cellIndex\)/);
  assert.doesNotMatch(FLAG_ROUTE, /body\?\.(isMine|hint|winner|board|flags|winnerId|winReason)/);
  assert.doesNotMatch(FLAG_ROUTE, /body\.(isMine|hint|winner|board)/);
  // It reports the caller's own claim set, never a correctness verdict.
  assert.match(FLAG_ROUTE, /p1Flags: flagsForSeat\(match, "player1"\)/);
  assert.match(FLAG_ROUTE, /p2Flags: flagsForSeat\(match, "player2"\)/);
  assert.doesNotMatch(FLAG_ROUTE, /isMine:/);
});

test("the match GET takes no body and serialises through the shared viewer", () => {
  assert.match(MATCH_ROUTE, /import \{ normaliseMatchForViewer \}/);
  assert.match(MATCH_ROUTE, /normaliseMatchForViewer\(enrichedMatch, userId\)/);
  assert.doesNotMatch(MATCH_ROUTE, /await req\.json\(\)/);
  assert.doesNotMatch(MATCH_ROUTE, /board:/, "the board decision lives in matchView");
});

test("a rejected action (e.g. a finished match) is surfaced, never swallowed", () => {
  for (const [label, src] of [
    ["pick", PICK_ROUTE],
    ["flag", FLAG_ROUTE],
  ]) {
    assert.match(src, /if \(result\.error\)/, `${label} must surface store errors`);
    assert.match(
      src,
      /status: result\.status \|\| 400/,
      `${label} must map the store's status onto the response`,
    );
    // No success body is emitted on the error path.
    assert.doesNotMatch(
      src,
      /if \(result\.error\) \{[\s\S]{0,200}?success: true/,
      `${label} must not answer success on the error path`,
    );
  }
  // The store remains the authority: any action outside a pickable state
  // (finished / cancelled / waiting / ready) is refused outright.
  const STORE_SRC = read("src/lib/mines-pvp/serverStore.js");
  assert.match(STORE_SRC, /PICKABLE_STATES\.has\(match\.status\)/);
  assert.match(STORE_SRC, /Match is not awaiting a pick/);
});

test("the AI-turn endpoint returns the SCRUBBED viewer payload, not the raw row", () => {
  assert.match(AI_ROUTE, /import \{ normaliseMatchForViewer \}/);
  assert.match(AI_ROUTE, /match: normaliseMatchForViewer\(result\.match, userId\)/);
  // The raw row (board + every isMine) must never be echoed back.
  assert.doesNotMatch(AI_ROUTE, /match: result\.match/);
  assert.doesNotMatch(AI_ROUTE, /match: match,/);
});

// ════════════════════════════════════════════════════════════════════════
// Realtime — existing room + event, fired after every successful action
// ════════════════════════════════════════════════════════════════════════

test("every mutation route broadcasts the existing match-updated event", () => {
  for (const [label, src] of [
    ["pick", PICK_ROUTE],
    ["flag", FLAG_ROUTE],
  ]) {
    assert.match(src, /import \{ broadcastMatchUpdate \}/, `${label} must broadcast`);
    assert.match(src, /broadcastMatchUpdate\(matchId, \{/, `${label} must broadcast`);
    // The broadcast is only a wake-up hint; listeners refetch /status.
    assert.doesNotMatch(src, /broadcastMatchUpdate\(\s*matchId,\s*\{[\s\S]{0,200}?board/, `${label} must not broadcast board data`);
  }
  // The AI turn notifies the same room so a viewer refetches promptly.
  assert.match(AI_ROUTE, /broadcastMatchUpdate\(matchId, \{/);
});
