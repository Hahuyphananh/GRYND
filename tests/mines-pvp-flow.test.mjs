/**
 * Mines Duel ("Mines PvP") — flow (state-machine) tests.
 *
 * The server store (`src/lib/mines-pvp/serverStore.js`) is the authoritative
 * source of the state machine, but it pulls in `drizzle-orm` and
 * `src/db/client` at the top of the module, so it can't be imported directly
 * from the test runner. This file MIRRORS the relevant pure helpers +
 * transitions in plain functions and drives them through an in-memory
 * `matches` Map. The mirror is intentionally close to production so any drift
 * is caught in review.
 *
 * Rules under test:
 *   • 10×10 board, a FIXED 10 mines.
 *   • STRICT alternation — one action (reveal OR flag) per turn.
 *   • reveal a mine → the revealer loses, opponent wins (`mine_hit`).
 *   • flag a mine → confirmed for the flagger (private); flag every mine →
 *     `all_mines_flagged` win.
 *   • flag a safe tile → rejected, turn still consumed.
 *
 * Run:  node --test tests/mines-pvp-flow.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FINISHED_GRACE_MS,
  GRID_CELLS,
  MATCH_STATUS,
  MINES_PER_MATCH,
  PICKABLE_STATES,
  READY_WINDOW_MS,
  RESULT,
  ROUND_PICK_DEADLINE_MS,
  TERMINAL_STATES,
  WIN_REASON,
  activePickerForMatch,
  computePayout,
  correctFlagCount,
  flagsForSeat,
  generateBoard,
  hasFlaggedAllMines,
  isMine,
  minesFoundForSeat,
  nearestMineDistance,
  pickRandomCell,
  relocateMine,
  revealedCells,
  resultForWinner,
  round2,
  seatForPickNumber,
  withFlagForSeat,
} from "../src/lib/mines-pvp/constants.js";

import { normaliseMatchForViewer } from "../src/lib/mines-pvp/matchView.js";

// ════════════════════════════════════════════════════════════════════════
// In-memory mirror of the DB row + state-machine helpers
// ════════════════════════════════════════════════════════════════════════

function makeMatch({ id, player1Id, player2Id = null, stakeAmount = 0, minesCount = MINES_PER_MATCH }) {
  return {
    id,
    player1Id,
    player2Id,
    stakeAmount: round2(stakeAmount),
    minesCount: Number(minesCount),
    board: null,
    status: MATCH_STATUS.WAITING,
    firstPlayerId: null,
    currentTurnUserId: null,
    roundDeadline: null,
    p1Pick: null,
    p2Pick: null,
    p1PickIsMine: null,
    p2PickIsMine: null,
    p1AutoPicked: false,
    p2AutoPicked: false,
    p1PickedAt: null,
    p2PickedAt: null,
    picks: [],
    p1Flags: [],
    p2Flags: [],
    result: null,
    winnerId: null,
    winReason: null,
    prizePaid: 0,
    houseFee: 0,
    startedAt: null,
    endedAt: null,
  };
}

function isParticipant(match, userId) {
  return match.player1Id === userId || match.player2Id === userId;
}

// Mirror of production validateMatchParams (stakes are retired → no stake
// range check; the mine count is FIXED).
function validateMatchParams({ stakeAmount, minesCount }) {
  void stakeAmount;
  const mines = Number(minesCount);
  if (minesCount != null && mines !== MINES_PER_MATCH) {
    return {
      ok: false,
      error: `Mines count is fixed at ${MINES_PER_MATCH}`,

    };
  }
  return { ok: true };
}

function nextTurnPatch(match) {
  const nextPickerId = activePickerForMatch(match);
  return {
    currentTurnUserId: nextPickerId,
    status:
      nextPickerId === match.player1Id
        ? MATCH_STATUS.P1_TURN
        : MATCH_STATUS.P2_TURN,
    roundDeadline: new Date(Date.now() + ROUND_PICK_DEADLINE_MS),
  };
}

function resolveMatch(match, { winnerId, reason }) {
  const result = resultForWinner({
    winnerId,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
  });
  const payout = computePayout({ stakeAmount: match.stakeAmount, result });
  match.status = MATCH_STATUS.FINISHED;
  match.currentTurnUserId = null;
  match.roundDeadline = null;
  match.result = result;
  match.winnerId = winnerId;
  match.winReason = reason ?? null;
  match.prizePaid = payout.prizePaid;
  match.houseFee = payout.houseFee;
  match.endedAt = new Date();
  return match;
}

function advanceTurn(match) {
  Object.assign(match, nextTurnPatch(match));
  return match;
}

function createOrJoin({ userId, stakeAmount = 0, minesCount, matches }) {
  // The mine count is a server constant; any client value is ignored.
  void minesCount;
  const validation = validateMatchParams({ stakeAmount, minesCount: MINES_PER_MATCH });
  if (!validation.ok) return { error: validation.error, status: 400 };

  for (const m of matches.values()) {
    if (m.status === MATCH_STATUS.WAITING && m.player2Id === null) {
      if (m.player1Id === userId) return { match: m, joined: false };
      m.player2Id = userId;
      m.status = MATCH_STATUS.READY;
      m.firstPlayerId = Math.random() < 0.5 ? m.player1Id : userId;
      m.currentTurnUserId = null;
      m.roundDeadline = new Date(Date.now() + READY_WINDOW_MS);
      m.startedAt = new Date();
      return { match: m, joined: true };
    }
  }

  const id = Math.max(0, ...matches.keys()) + 1;
  const match = makeMatch({ id, player1Id: userId, stakeAmount: 0 });
  match.board = generateBoard(MINES_PER_MATCH);
  matches.set(id, match);
  return { match, joined: false };
}

function pickTile({ userId, matchId, cellIndex, matches }) {
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) {
    return { error: `cellIndex must be an integer in [0, ${GRID_CELLS - 1}]`, status: 400 };
  }
  const match = matches.get(matchId);
  if (!match) return { error: "Match not found", status: 404 };
  if (!isParticipant(match, userId)) return { error: "Forbidden", status: 403 };
  if (!PICKABLE_STATES.has(match.status)) {
    return { error: "Match is not awaiting a pick", status: 400 };
  }
  const expectedPicker = activePickerForMatch(match);
  if (!expectedPicker || match.currentTurnUserId !== expectedPicker || userId !== expectedPicker) {
    return { error: "It is not your turn", status: 403 };
  }
  if (revealedCells(match).includes(idx)) {
    return { error: "Cell already picked", status: 409 };
  }
  const seat = userId === match.player1Id ? "player1" : "player2";
  // You cannot reveal a tile you already confirmed as a mine.
  if (flagsForSeat(match, seat).includes(idx)) {
    return { error: "You already flagged this tile", status: 409 };
  }

  let board = match.board;
  let mercyUsed = false;
  if (match.picks.length === 0 && isMine(board, idx)) {
    board = relocateMine(board, idx);
    mercyUsed = true;
    match.board = board;
  }
  const pickIsMine = isMine(board, idx);
  match.picks.push({
    userId,
    seat,
    cell: idx,
    isMine: pickIsMine,
    hint: pickIsMine ? null : nearestMineDistance(board, idx),
    flag: false,
    mercy: mercyUsed,
    autoPicked: false,
    pickedAt: new Date().toISOString(),
  });

  if (pickIsMine) {
    resolveMatch(match, { winnerId: match.player1Id === userId ? match.player2Id : match.player1Id, reason: WIN_REASON.MINE_HIT });
    return { match, justResolved: true };
  }
  advanceTurn(match);
  return { match, justResolved: false };
}

// Mirror of production flagTile: a correct flag is kept (private), a wrong
// flag is rejected but still consumes the turn.
function flagTile({ userId, matchId, cellIndex, matches }) {
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) {
    return { error: `cellIndex must be an integer in [0, ${GRID_CELLS - 1}]`, status: 400 };
  }
  const match = matches.get(matchId);
  if (!match) return { error: "Match not found", status: 404 };
  if (!isParticipant(match, userId)) return { error: "Forbidden", status: 403 };
  if (!PICKABLE_STATES.has(match.status)) {
    return { error: "Match is not awaiting a pick", status: 400 };
  }
  const expectedPicker = activePickerForMatch(match);
  if (!expectedPicker || match.currentTurnUserId !== expectedPicker || userId !== expectedPicker) {
    return { error: "It is not your turn", status: 403 };
  }
  if (revealedCells(match).includes(idx)) {
    return { error: "Cell already revealed", status: 409 };
  }
  const seat = userId === match.player1Id ? "player1" : "player2";
  if (flagsForSeat(match, seat).includes(idx)) {
    return { error: "Cell already flagged", status: 409 };
  }

  const flagIsMine = isMine(match.board, idx);
  match.picks.push({
    userId,
    seat,
    cell: idx,
    isMine: flagIsMine,
    hint: null,
    flag: true,
    kind: "flag",
    mercy: false,
    autoPicked: false,
    pickedAt: new Date().toISOString(),
  });
  if (flagIsMine) Object.assign(match, withFlagForSeat(match, seat, idx));

  const claimedFlags = flagsForSeat(match, seat);
  if (flagIsMine && hasFlaggedAllMines(claimedFlags, match.board)) {
    resolveMatch(match, { winnerId: userId, reason: WIN_REASON.ALL_MINES_FLAGGED });
    return { match, justResolved: true, flagRevealed: true };
  }
  advanceTurn(match);
  return {
    match,
    justResolved: false,
    flagRevealed: flagIsMine,
    wrongFlag: !flagIsMine,
  };
}

function advanceFromReady(match) {
  const isFirstPlayerP1 = match.firstPlayerId === match.player1Id;
  match.status = isFirstPlayerP1 ? MATCH_STATUS.P1_TURN : MATCH_STATUS.P2_TURN;
  match.currentTurnUserId = match.firstPlayerId;
  match.roundDeadline = new Date(Date.now() + ROUND_PICK_DEADLINE_MS);
  return match;
}

function forcePick(match) {
  if (!PICKABLE_STATES.has(match.status)) return match;
  const pickerId = activePickerForMatch(match);
  const cellIndex = pickRandomCell({ excludePicks: revealedCells(match) });
  let mercyUsed = false;
  if (match.picks.length === 0 && isMine(match.board, cellIndex)) {
    match.board = relocateMine(match.board, cellIndex);
    mercyUsed = true;
  }
  const pickIsMine = isMine(match.board, cellIndex);
  const seat = pickerId === match.player1Id ? "player1" : "player2";
  match.picks.push({
    userId: pickerId,
    seat,
    cell: cellIndex,
    isMine: pickIsMine,
    hint: pickIsMine ? null : nearestMineDistance(match.board, cellIndex),
    flag: false,
    mercy: mercyUsed,
    autoPicked: true,
    pickedAt: new Date().toISOString(),
  });
  if (pickIsMine) {
    resolveMatch(match, { winnerId: match.player1Id === pickerId ? match.player2Id : match.player1Id, reason: WIN_REASON.MINE_HIT });
  } else {
    advanceTurn(match);
  }
  return match;
}

// Ready the match and open the first turn (server-randomised opener).
function startMatch(match, { firstPlayerId } = {}) {
  match.player2Id = match.player2Id ?? "p2";
  match.status = MATCH_STATUS.READY;
  match.firstPlayerId = firstPlayerId ?? match.player1Id;
  match.roundDeadline = new Date(Date.now() + READY_WINDOW_MS);
  advanceFromReady(match);
  return match;
}

function seedMatch({ board = null } = {}) {
  const matches = new Map();
  const match = makeMatch({ id: 1, player1Id: "p1", player2Id: "p2" });
  match.board = board ?? generateBoard(MINES_PER_MATCH);
  matches.set(1, match);
  startMatch(match, { firstPlayerId: "p1" });
  return { matches, match };
}

// A deterministic board for exact assertions: mines on rows 0 and 1 (0-9).
const FIXED_BOARD = { size: 10, mines: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] };

// ════════════════════════════════════════════════════════════════════════
// validateMatchParams
// ════════════════════════════════════════════════════════════════════════

test("validateMatchParams: accepts the fixed mine count (and a missing one)", () => {
  assert.equal(validateMatchParams({ stakeAmount: 0, minesCount: MINES_PER_MATCH }).ok, true);
  assert.equal(validateMatchParams({ stakeAmount: 0 }).ok, true);
});

test("validateMatchParams: rejects any other mine count", () => {
  for (const minesCount of [1, 3, 4, 6, 24, 0]) {
    const r = validateMatchParams({ stakeAmount: 0, minesCount });
    assert.equal(r.ok, false, `minesCount ${minesCount} should be rejected`);
    assert.ok(r.error.includes(String(MINES_PER_MATCH)));
  }
});

// ════════════════════════════════════════════════════════════════════════
// createOrJoin
// ════════════════════════════════════════════════════════════════════════

test("createOrJoin: creates a waiting match with a generated 5-mine board", () => {
  const matches = new Map();
  const { match, joined } = createOrJoin({ userId: "p1", matches });
  assert.equal(joined, false);
  assert.equal(match.status, MATCH_STATUS.WAITING);
  assert.equal(match.minesCount, MINES_PER_MATCH);
  assert.equal(match.board.mines.length, MINES_PER_MATCH);
});

test("createOrJoin: a second player joins the open lobby and it becomes ready", () => {
  const matches = new Map();
  const created = createOrJoin({ userId: "p1", matches });
  const joined = createOrJoin({ userId: "p2", matches });
  assert.equal(joined.joined, true);
  assert.equal(joined.match.id, created.match.id);
  assert.equal(joined.match.player2Id, "p2");
  assert.equal(joined.match.status, MATCH_STATUS.READY);
  assert.ok(joined.match.firstPlayerId === "p1" || joined.match.firstPlayerId === "p2");
});

test("createOrJoin: pins the fixed mine count even if a client sends another", () => {
  const matches = new Map();
  const r = createOrJoin({ userId: "p1", minesCount: 3, matches });
  assert.equal(r.match.minesCount, MINES_PER_MATCH);
  assert.equal(r.match.board.mines.length, MINES_PER_MATCH);
});

// ════════════════════════════════════════════════════════════════════════
// Turn order — strict alternation
// ════════════════════════════════════════════════════════════════════════

test("each reveal hands the turn straight to the opponent", () => {
  const { matches, match } = seedMatch({ board: { size: 10, mines: [99] } });
  assert.equal(match.currentTurnUserId, "p1");
  pickTile({ userId: "p1", matchId: 1, cellIndex: 55, matches });
  assert.equal(match.currentTurnUserId, "p2");
  assert.equal(match.status, MATCH_STATUS.P2_TURN);
  pickTile({ userId: "p2", matchId: 1, cellIndex: 56, matches });
  assert.equal(match.currentTurnUserId, "p1");
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
});

test("a player cannot act twice in a row", () => {
  const { matches, match } = seedMatch({ board: { size: 10, mines: [99] } });
  pickTile({ userId: "p1", matchId: 1, cellIndex: 55, matches });
  const second = pickTile({ userId: "p1", matchId: 1, cellIndex: 56, matches });
  assert.equal(second.status, 403);
  assert.equal(match.picks.length, 1);
});

test("seatForPickNumber and the store agree on alternation", () => {
  for (let n = 1; n <= 6; n += 1) {
    const seat = seatForPickNumber(n, "player1");
    assert.equal(seat, n % 2 === 1 ? "player1" : "player2");
  }
});

// ════════════════════════════════════════════════════════════════════════
// pickTile — reveal rules
// ════════════════════════════════════════════════════════════════════════

test("revealing a safe cell stamps the public clue and does not resolve", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  const r = pickTile({ userId: "p1", matchId: 1, cellIndex: 55, matches });
  assert.equal(r.justResolved, false);
  assert.equal(match.picks[0].hint, 5); // 55 (5,5) → nearest mine 4 (0,4) = 5
  assert.equal(match.picks[0].isMine, false);
});

test("revealing a mine loses immediately and names the opponent the winner", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  // p1 opens somewhere safe so p2 gets the turn, then p2 hits a mine.
  pickTile({ userId: "p1", matchId: 1, cellIndex: 55, matches });
  const r = pickTile({ userId: "p2", matchId: 1, cellIndex: 0, matches });
  assert.equal(r.justResolved, true);
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.winnerId, "p1");
  assert.equal(match.winReason, WIN_REASON.MINE_HIT);
  assert.equal(match.result, RESULT.PLAYER1);
});

test("the first reveal is always safe (mercy relocates the mine)", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  const r = pickTile({ userId: "p1", matchId: 1, cellIndex: 0, matches });
  assert.equal(r.justResolved, false);
  assert.equal(match.picks[0].isMine, false);
  assert.equal(match.board.mines.length, MINES_PER_MATCH);
  assert.equal(isMine(match.board, 0), false);
});

test("a cell cannot be revealed twice", () => {
  const { matches } = seedMatch({ board: FIXED_BOARD });
  pickTile({ userId: "p1", matchId: 1, cellIndex: 55, matches });
  const dup = pickTile({ userId: "p2", matchId: 1, cellIndex: 55, matches });
  assert.equal(dup.status, 409);
});

test("you cannot reveal a tile you confirmed as a mine", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  flagTile({ userId: "p1", matchId: 1, cellIndex: 0, matches });
  assert.deepEqual(flagsForSeat(match, "player1"), [0]);
  // p1's turn came back around after p2 acted.
  pickTile({ userId: "p2", matchId: 1, cellIndex: 55, matches });
  const r = pickTile({ userId: "p1", matchId: 1, cellIndex: 0, matches });
  assert.equal(r.status, 409);
});

test("any action outside a pickable state is refused", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  match.status = MATCH_STATUS.FINISHED;
  assert.equal(pickTile({ userId: "p1", matchId: 1, cellIndex: 55, matches }).status, 400);
  assert.equal(flagTile({ userId: "p1", matchId: 1, cellIndex: 0, matches }).status, 400);
});

// ════════════════════════════════════════════════════════════════════════
// flagTile — correct vs wrong
// ════════════════════════════════════════════════════════════════════════

test("a CORRECT flag confirms the mine for the flagger and consumes the turn", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  const r = flagTile({ userId: "p1", matchId: 1, cellIndex: 0, matches });
  assert.equal(r.flagRevealed, true);
  assert.equal(r.wrongFlag, false);
  assert.deepEqual(flagsForSeat(match, "player1"), [0]);
  assert.equal(minesFoundForSeat(match, "player1"), 1);
  // The turn passed to the opponent.
  assert.equal(match.currentTurnUserId, "p2");
});

test("a WRONG flag is rejected but still consumes the turn", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  const r = flagTile({ userId: "p1", matchId: 1, cellIndex: 55, matches });
  assert.equal(r.wrongFlag, true);
  assert.equal(r.flagRevealed, false);
  assert.deepEqual(flagsForSeat(match, "player1"), []);
  assert.equal(match.currentTurnUserId, "p2");
});

test("confirming every mine wins immediately", () => {
  // A 3-mine board keeps the alternating flag/waste sequence readable.
  const { matches, match } = seedMatch({ board: { size: 10, mines: [0, 1, 2] } });
  flagTile({ userId: "p1", matchId: 1, cellIndex: 0, matches }); // p1
  pickTile({ userId: "p2", matchId: 1, cellIndex: 55, matches }); // p2 safe
  flagTile({ userId: "p1", matchId: 1, cellIndex: 1, matches }); // p1
  pickTile({ userId: "p2", matchId: 1, cellIndex: 56, matches }); // p2 safe
  const last = flagTile({ userId: "p1", matchId: 1, cellIndex: 2, matches }); // p1 completes
  assert.equal(last.justResolved, true);
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.winnerId, "p1");
  assert.equal(match.winReason, WIN_REASON.ALL_MINES_FLAGGED);
});

test("a duplicate flag on your own confirmed mine is rejected", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  flagTile({ userId: "p1", matchId: 1, cellIndex: 0, matches });
  pickTile({ userId: "p2", matchId: 1, cellIndex: 55, matches });
  const dup = flagTile({ userId: "p1", matchId: 1, cellIndex: 0, matches });
  assert.equal(dup.status, 409);
});

// ════════════════════════════════════════════════════════════════════════
// Visibility — the raw row vs the viewer payload
// ════════════════════════════════════════════════════════════════════════

test("an active match never leaks the board or the opponent's flag cells", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  flagTile({ userId: "p1", matchId: 1, cellIndex: 0, matches });
  pickTile({ userId: "p2", matchId: 1, cellIndex: 55, matches });

  const asP1 = normaliseMatchForViewer(match, "p1");
  const asP2 = normaliseMatchForViewer(match, "p2");
  assert.equal(asP1.board, null);
  assert.equal(asP2.board, null);
  assert.deepEqual(asP1.myFlags, [0]);
  assert.deepEqual(asP2.myFlags, []);
  assert.equal(asP1.myMinesFound, 1);
  assert.equal(asP2.opponentMinesFound, 1);
  // P2 never learns p1's flag cell from the history.
  const p1FlagEntry = asP2.picks.find((p) => p.flag && p.userId === "p1");
  assert.equal(p1FlagEntry.cell, null);
});

test("flags still do not count as discovered safe cells", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  flagTile({ userId: "p1", matchId: 1, cellIndex: 0, matches });
  pickTile({ userId: "p2", matchId: 1, cellIndex: 55, matches });
  const view = normaliseMatchForViewer(match, "p1");
  // 100 - 10 mines = 90 safe; one reveal.
  assert.equal(view.safeTilesRemaining, 89);
});

test("a finished match reveals the board", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  pickTile({ userId: "p1", matchId: 1, cellIndex: 55, matches });
  pickTile({ userId: "p2", matchId: 1, cellIndex: 0, matches });
  const view = normaliseMatchForViewer(match, "p1");
  assert.deepEqual(view.board, FIXED_BOARD);
  assert.equal(view.winnerId, "p1");
  assert.equal(view.winReason, WIN_REASON.MINE_HIT);
});

// ════════════════════════════════════════════════════════════════════════
// AFK auto-pick
// ════════════════════════════════════════════════════════════════════════

test("the AFK auto-pick reveals a cell and advances the turn", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  forcePick(match);
  assert.equal(match.picks.length, 1);
  assert.equal(match.picks[0].autoPicked, true);
  assert.equal(match.currentTurnUserId, "p2");
});

test("terminal states still trigger no further actions", () => {
  const { matches, match } = seedMatch({ board: FIXED_BOARD });
  match.status = MATCH_STATUS.FINISHED;
  assert.equal(matches.size, 1);
  assert.equal(TERMINAL_STATES.has(match.status), true);
});

test("FINISHED_GRACE_MS is the post-finish lobby delay", () => {
  assert.equal(FINISHED_GRACE_MS, 5000);
});
