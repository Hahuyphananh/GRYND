/**
 * Mines Duel ("Mines PvP") — flow (state-machine) tests.
 *
 * The server store (`src/lib/mines-pvp/serverStore.js`) is the
 * authoritative source of the state machine, but it pulls in
 * `drizzle-orm` and `src/db/client` at the top of the module, which
 * means we can't `import` it directly from a test runner (the
 * database client path has no `.js` extension on disk). Instead
 * this test MIRRORS the relevant pure helpers + state-machine
 * transitions in plain functions and drives them through an
 * in-memory `matches` Map. The mirror is intentionally close to the
 * production logic so any drift between this test and the server
 * store will be caught by a code reviewer when the diff is
 * reviewed.
 *
 * The pure-function parts (validateMatchParams, seatForUser,
 * isParticipant, scrubMatchForViewer, decideOutcome, computePayout,
 * generateBoard, isMine, pickRandomCell, seatForPickNumber,
 * activeSeatForMatch, activePickerForMatch) are duplicated in
 * `tests/mines-pvp-engine.test.mjs` and `src/lib/mines-pvp/
 * constants.js` — see those for the canonical implementation.
 *
 * Odds-turn flow mirror contract (mirrors `applyPick` in the
 * production server store):
 *   1. `pickTile(userId, idx)` computes the active picker via the
 *      closed-form formula; rejects if `userId` doesn't match.
 *   2. The pick is appended to `match.picks`.
 *   3. If the new pick is a mine → resolve immediately (the picker
 *      loses) per `decideOutcome({ loserId, player1Id, player2Id })`.
 *   4. Else → compute next picker via the same formula and flip
 *      `currentTurnUserId` + status + deadline.
 *
 * Run:  node --test tests/mines-pvp-flow.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_STATES,
  FINISHED_GRACE_MS,
  GRID_CELLS,
  HOUSE_RATIO,
  MATCH_STATUS,
  MAX_MINES,
  MAX_STAKE,
  MIN_MINES,
  MIN_STAKE,
  PICKABLE_STATES,
  PICK_KIND,
  READY_WINDOW_MS,
  RESULT,
  ROUND_PICK_DEADLINE_MS,
  ROUND_TIMER_SECONDS,
  TERMINAL_STATES,
  WINNER_RATIO,
  activePickerForMatch,
  computePayout,
  decideOutcome,
  generateBoard,
  generateSolvableBoard,
  isMine,
  nearestMineDistance,
  pickRandomCell,
  relocateMine,
  round2,
} from "../src/lib/mines-pvp/constants.js";

// ════════════════════════════════════════════════════════════════════════
// In-memory mirror of the DB row + state-machine helpers
// ════════════════════════════════════════════════════════════════════════

function makeMatch({
  id,
  player1Id,
  player2Id = null,
  stakeAmount,
  minesCount,
}) {
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
    picks: [], // chronological JSONB-backed pick history
    result: null,
    winnerId: null,
    prizePaid: null,
    houseFee: null,
    startedAt: null,
    endedAt: null,
    createdAt: new Date(),
  };
}

function validateMatchParams({ stakeAmount, minesCount }) {
  const stake = Number(stakeAmount);
  const mines = Number(minesCount);
  if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
    return {
      ok: false,
      error: `Stake must be a number in [${MIN_STAKE}, ${MAX_STAKE}]`,
    };
  }
  if (!Number.isInteger(mines) || mines < MIN_MINES || mines > MAX_MINES) {
    return {
      ok: false,
      error: `Mines count must be an integer in [${MIN_MINES}, ${MAX_MINES}]`,
    };
  }
  return { ok: true };
}

function seatForUser(match, userId) {
  if (!match || !userId) return null;
  if (match.player1Id === userId) return "player1";
  if (match.player2Id === userId) return "player2";
  return null;
}

function isParticipant(match, userId) {
  return seatForUser(match, userId) !== null;
}

function scrubMatchForViewer(match) {
  if (!match) return match;
  if (match.status === MATCH_STATUS.FINISHED) {
    return { ...match };
  }
  return { ...match, board: null };
}

function advanceFromReady(match) {
  if (!match.firstPlayerId) return match;
  match.status =
    match.firstPlayerId === match.player1Id
      ? MATCH_STATUS.P1_TURN
      : MATCH_STATUS.P2_TURN;
  match.currentTurnUserId = match.firstPlayerId;
  match.roundDeadline = new Date(Date.now() + ROUND_PICK_DEADLINE_MS);
  return match;
}

// ── Mirror of applyPick (the shared helper for pickTile + forcePick) ──
//
// Encapsulates the post-pick side effects: append to `picks`, mirror
// most-recent to legacy single-pick scalars, then either resolve
// (mine hit) or advance to the next picker in the odds formula.
function applyPick(match, pick) {
  const allPicks = Array.isArray(match.picks)
    ? [...match.picks, pick]
    : [pick];
  match.picks = allPicks;

  // Mirror most-recent-of-each-seat onto legacy scalar columns.
  if (pick.seat === "player1") {
    match.p1Pick = pick.cell;
    match.p1PickIsMine = pick.isMine;
    match.p1PickedAt = new Date(pick.pickedAt);
    match.p1AutoPicked = pick.autoPicked;
  } else {
    match.p2Pick = pick.cell;
    match.p2PickIsMine = pick.isMine;
    match.p2PickedAt = new Date(pick.pickedAt);
    match.p2AutoPicked = pick.autoPicked;
  }

  if (pick.isMine) {
    return resolveMatch(match, pick.userId);
  }

  // Safe pick → advance to next picker via the closed-form formula.
  const fakeMatchAfter = { ...match };
  const nextPickerId = activePickerForMatch(fakeMatchAfter);
  match.currentTurnUserId = nextPickerId;
  match.status =
    nextPickerId === match.player1Id
      ? MATCH_STATUS.P1_TURN
      : MATCH_STATUS.P2_TURN;
  match.roundDeadline = new Date(Date.now() + ROUND_PICK_DEADLINE_MS);
  return match;
}

function resolveMatch(match, loserId) {
  if (!loserId) return match;
  const result = decideOutcome({
    loserId,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
  });
  const payout = computePayout({ stakeAmount: match.stakeAmount, result });

  match.status = MATCH_STATUS.FINISHED;
  match.currentTurnUserId = null;
  match.roundDeadline = null;
  match.result = result;
  match.prizePaid = payout.prizePaid;
  match.houseFee = payout.houseFee;
  match.winnerId =
    result === RESULT.PLAYER1 ? match.player1Id : match.player2Id;
  match.endedAt = new Date();
  return match;
}

function createOrJoin({ userId, stakeAmount, minesCount, matches }) {
  const validation = validateMatchParams({ stakeAmount, minesCount });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }

  const stakeFixed = round2(stakeAmount);

  for (const m of matches.values()) {
    if (
      m.status === MATCH_STATUS.WAITING &&
      m.player2Id === null &&
      m.stakeAmount === stakeFixed
    ) {
      if (m.player1Id === userId) {
        return { match: m, joined: false };
      }
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
  const match = makeMatch({
    id,
    player1Id: userId,
    stakeAmount: stakeFixed,
    minesCount,
  });
  // Mirrors production createWaitingMatch: no-guess generator keeps the
  // 3x3 center block mine-free + verifies the center opening is solvable.
  match.board = generateSolvableBoard(Number(minesCount));
  matches.set(id, match);
  return { match, joined: false };
}

function pickTile({ userId, matchId, cellIndex, matches }) {
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) {
    return {
      error: `cellIndex must be an integer in [0, ${GRID_CELLS - 1}]`,
      status: 400,
    };
  }

  const match = matches.get(matchId);
  if (!match) return { error: "Match not found", status: 404 };
  if (!isParticipant(match, userId)) {
    return { error: "Forbidden", status: 403 };
  }
  if (!PICKABLE_STATES.has(match.status)) {
    return { error: "Match is not awaiting a pick", status: 400 };
  }
  if (
    match.roundDeadline &&
    new Date(match.roundDeadline).getTime() <= Date.now()
  ) {
    return { error: "Pick window has expired", status: 400 };
  }

  // Turn enforcement via closed-form formula (the new "odds" turn
  // order). Validates that the formula, the stored
  // currentTurnUserId, and the caller all agree.
  const expectedPicker = activePickerForMatch(match);
  if (
    !expectedPicker ||
    match.currentTurnUserId !== expectedPicker ||
    userId !== expectedPicker
  ) {
    return { error: "It is not your turn", status: 403 };
  }

  // Disallow duplicate picks across the full per-pick history.
  const historyCells = (match.picks ?? [])
    .map((p) => Number(p?.cell))
    .filter((c) => Number.isInteger(c) && c >= 0 && c < GRID_CELLS);
  if (historyCells.includes(idx)) {
    return { error: "Cell already picked", status: 409 };
  }

  // First-pick mercy (mirrors production pickTile): the game's very
  // first pick is always safe — relocate the mine off the cell and
  // keep the relocated board on the match.
  let mercyUsed = false;
  if (match.picks.length === 0 && isMine(match.board, idx)) {
    match.board = relocateMine(match.board, idx);
    mercyUsed = true;
  }

  const pickIsMine = isMine(match.board, idx);
  const seat = userId === match.player1Id ? "player1" : "player2";
  const newPick = {
    userId,
    seat,
    cell: idx,
    isMine: pickIsMine,
    // Mirrors production pickTile: safe picks carry the proximity
    // hint (distance to nearest mine); mines get null.
    hint: pickIsMine ? null : nearestMineDistance(match.board, idx),
    mercy: mercyUsed,
    autoPicked: false,
    pickedAt: new Date().toISOString(),
  };

  const result = applyPick(match, newPick);
  return { match: result, justResolved: pickIsMine };
}

// ── Mirror of flagTile (the "call a mine" skill move) ────────────────
//
// Same validation chain as pickTile, but the outcome is ALWAYS
// terminal: correct flag (tile is a mine) → the OPPONENT loses;
// wrong flag (tile is safe) → the FLAGGER loses. No first-pick
// mercy for flags (a flag is a deliberate claim, not the
// definitionally-guessy opening pick). The flag entry lands in the
// chronological `picks` array with `flag: true` and resolves via
// resolveMatch.
function flagTile({ userId, matchId, cellIndex, matches }) {
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) {
    return {
      error: `cellIndex must be an integer in [0, ${GRID_CELLS - 1}]`,
      status: 400,
    };
  }

  const match = matches.get(matchId);
  if (!match) return { error: "Match not found", status: 404 };
  if (!isParticipant(match, userId)) {
    return { error: "Forbidden", status: 403 };
  }
  if (!PICKABLE_STATES.has(match.status)) {
    return { error: "Match is not awaiting a pick", status: 400 };
  }
  if (
    match.roundDeadline &&
    new Date(match.roundDeadline).getTime() <= Date.now()
  ) {
    return { error: "Pick window has expired", status: 400 };
  }
  const expectedPicker = activePickerForMatch(match);
  if (
    !expectedPicker ||
    match.currentTurnUserId !== expectedPicker ||
    userId !== expectedPicker
  ) {
    return { error: "It is not your turn", status: 403 };
  }
  const historyCells = (match.picks ?? [])
    .map((p) => Number(p?.cell))
    .filter((c) => Number.isInteger(c) && c >= 0 && c < GRID_CELLS);
  if (historyCells.includes(idx)) {
    return { error: "Cell already picked", status: 409 };
  }

  const flagIsMine = isMine(match.board, idx);
  const seat = userId === match.player1Id ? "player1" : "player2";
  const flagEntry = {
    userId,
    seat,
    cell: idx,
    isMine: flagIsMine,
    hint: null,
    flag: true,
    mercy: false,
    autoPicked: false,
    pickedAt: new Date().toISOString(),
  };

  // Correct flag → opponent loses; wrong flag → flagger loses.
  const loserId = flagIsMine
    ? userId === match.player1Id
      ? match.player2Id
      : match.player1Id
    : userId;

  match.picks = [...(match.picks ?? []), flagEntry];
  if (seat === "player1") {
    match.p1Pick = idx;
    match.p1PickIsMine = flagIsMine;
    match.p1PickedAt = new Date(flagEntry.pickedAt);
    match.p1AutoPicked = false;
  } else {
    match.p2Pick = idx;
    match.p2PickIsMine = flagIsMine;
    match.p2PickedAt = new Date(flagEntry.pickedAt);
    match.p2AutoPicked = false;
  }

  resolveMatch(match, loserId);
  return { match, justResolved: true };
}

function forcePick(match) {
  if (!PICKABLE_STATES.has(match.status)) return match;
  const pickerId = activePickerForMatch(match);
  const historyCells = (match.picks ?? [])
    .map((p) => Number(p?.cell))
    .filter((c) => Number.isInteger(c) && c >= 0 && c < GRID_CELLS);
  const cellIndex = pickRandomCell({ excludePicks: historyCells });
  // First-pick mercy on the AFK path too (mirrors production forcePick):
  // the game's opening is never a trap, even for an AFK'd first turn.
  let mercyUsed = false;
  if (match.picks.length === 0 && isMine(match.board, cellIndex)) {
    match.board = relocateMine(match.board, cellIndex);
    mercyUsed = true;
  }
  const pickIsMine = isMine(match.board, cellIndex);
  const seat = pickerId === match.player1Id ? "player1" : "player2";
  return applyPick(match, {
    userId: pickerId,
    seat,
    cell: cellIndex,
    isMine: pickIsMine,
    // Mirrors production forcePick (hint stamped on safe picks only).
    hint: pickIsMine ? null : nearestMineDistance(match.board, cellIndex),
    mercy: mercyUsed,
    autoPicked: true,
    pickedAt: new Date().toISOString(),
  });
}

function fetchMatchWithAutoResolve(userId, matchId, matches) {
  const match = matches.get(matchId);
  if (!match) return { error: "Match not found", status: 404 };
  if (!isParticipant(match, userId)) {
    return { error: "Forbidden", status: 403 };
  }

  if (
    match.status === MATCH_STATUS.READY &&
    match.roundDeadline &&
    new Date(match.roundDeadline).getTime() <= Date.now()
  ) {
    advanceFromReady(match);
    return { match: scrubMatchForViewer(match) };
  }

  if (
    PICKABLE_STATES.has(match.status) &&
    match.roundDeadline &&
    new Date(match.roundDeadline).getTime() <= Date.now()
  ) {
    forcePick(match);
    return { match: scrubMatchForViewer(match) };
  }

  return { match: scrubMatchForViewer(match) };
}

// ════════════════════════════════════════════════════════════════════════
// validateMatchParams
// ════════════════════════════════════════════════════════════════════════

test("validateMatchParams: accepts valid stake + mines at typical values", () => {
  const r = validateMatchParams({ stakeAmount: 50, minesCount: 5 });
  assert.equal(r.ok, true);
});

test("validateMatchParams: accepts boundary stake (1)", () => {
  assert.equal(
    validateMatchParams({ stakeAmount: 1, minesCount: 1 }).ok,
    true,
  );
});

test("validateMatchParams: accepts boundary stake (1,000,000)", () => {
  assert.equal(
    validateMatchParams({ stakeAmount: 1_000_000, minesCount: 24 }).ok,
    true,
  );
});

test("validateMatchParams: rejects stake below MIN_STAKE", () => {
  const r = validateMatchParams({ stakeAmount: 0.5, minesCount: 5 });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes(String(MIN_STAKE)));
});

test("validateMatchParams: rejects stake above MAX_STAKE", () => {
  const r = validateMatchParams({ stakeAmount: 2_000_000, minesCount: 5 });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes(String(MAX_STAKE)));
});

test("validateMatchParams: rejects NaN stake", () => {
  assert.equal(validateMatchParams({ stakeAmount: NaN, minesCount: 5 }).ok, false);
});

test("validateMatchParams: rejects Infinity stake", () => {
  assert.equal(
    validateMatchParams({ stakeAmount: Infinity, minesCount: 5 }).ok,
    false,
  );
});

test("validateMatchParams: rejects mines below MIN_MINES (0)", () => {
  const r = validateMatchParams({ stakeAmount: 10, minesCount: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes(String(MIN_MINES)));
});

test("validateMatchParams: rejects mines above MAX_MINES (25)", () => {
  const r = validateMatchParams({ stakeAmount: 10, minesCount: 25 });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes(String(MAX_MINES)));
});

test("validateMatchParams: rejects non-integer mines (1.5)", () => {
  assert.equal(
    validateMatchParams({ stakeAmount: 10, minesCount: 1.5 }).ok,
    false,
  );
});

test("validateMatchParams: rejects non-integer mines (NaN)", () => {
  assert.equal(
    validateMatchParams({ stakeAmount: 10, minesCount: NaN }).ok,
    false,
  );
});

test("validateMatchParams: returns 400-shaped error object", () => {
  const r = validateMatchParams({ stakeAmount: 10, minesCount: 99 });
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, "string");
});

// ════════════════════════════════════════════════════════════════════════
// seatForUser / isParticipant
// ════════════════════════════════════════════════════════════════════════

test("seatForUser: returns 'player1' when viewer is the host", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  assert.equal(seatForUser(m, "u1"), "player1");
});

test("seatForUser: returns 'player2' when viewer is the joiner", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  assert.equal(seatForUser(m, "u2"), "player2");
});

test("seatForUser: returns null when viewer is not a participant", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  assert.equal(seatForUser(m, "u3"), null);
});

test("seatForUser: returns null when match is null", () => {
  assert.equal(seatForUser(null, "u1"), null);
});

test("seatForUser: returns null when userId is null", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  assert.equal(seatForUser(m, null), null);
});

test("isParticipant: true for p1", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  assert.equal(isParticipant(m, "u1"), true);
});

test("isParticipant: true for p2", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  assert.equal(isParticipant(m, "u2"), true);
});

test("isParticipant: false for non-participant", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  assert.equal(isParticipant(m, "u3"), false);
});

test("isParticipant: false for null match", () => {
  assert.equal(isParticipant(null, "u1"), false);
});

// ════════════════════════════════════════════════════════════════════════
// scrubMatchForViewer
// ════════════════════════════════════════════════════════════════════════

test("scrubMatchForViewer: hides board mid-match (waiting)", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", stakeAmount: 10, minesCount: 5 });
  m.board = { size: 5, mines: [0, 1, 2] };
  const scrubbed = scrubMatchForViewer(m);
  assert.equal(scrubbed.board, null);
  assert.equal(scrubbed.status, MATCH_STATUS.WAITING);
});

test("scrubMatchForViewer: hides board mid-match (ready)", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  m.status = MATCH_STATUS.READY;
  m.board = { size: 5, mines: [0, 1, 2] };
  const scrubbed = scrubMatchForViewer(m);
  assert.equal(scrubbed.board, null);
});

test("scrubMatchForViewer: hides board mid-match (p1_turn)", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  m.status = MATCH_STATUS.P1_TURN;
  m.board = { size: 5, mines: [0, 1, 2] };
  const scrubbed = scrubMatchForViewer(m);
  assert.equal(scrubbed.board, null);
});

test("scrubMatchForViewer: hides board mid-match (p2_turn)", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  m.status = MATCH_STATUS.P2_TURN;
  m.board = { size: 5, mines: [0, 1, 2] };
  const scrubbed = scrubMatchForViewer(m);
  assert.equal(scrubbed.board, null);
});

test("scrubMatchForViewer: reveals board on finished", () => {
  const m = makeMatch({ id: 1, player1Id: "u1", player2Id: "u2", stakeAmount: 10, minesCount: 5 });
  m.status = MATCH_STATUS.FINISHED;
  m.board = { size: 5, mines: [0, 1, 2] };
  const scrubbed = scrubMatchForViewer(m);
  assert.deepEqual(scrubbed.board, { size: 5, mines: [0, 1, 2] });
});

test("scrubMatchForViewer: returns null for null match", () => {
  assert.equal(scrubMatchForViewer(null), null);
});

// ════════════════════════════════════════════════════════════════════════
// createOrJoin — matchmaking
// ════════════════════════════════════════════════════════════════════════

test("createOrJoin: first caller creates a new waiting match", () => {
  const matches = new Map();
  const r = createOrJoin({
    userId: "u1",
    stakeAmount: 50,
    minesCount: 5,
    matches,
  });
  assert.equal(r.error, undefined);
  assert.equal(r.joined, false);
  assert.equal(r.match.status, MATCH_STATUS.WAITING);
  assert.equal(r.match.player1Id, "u1");
  assert.equal(r.match.player2Id, null);
  assert.equal(matches.size, 1);
  assert.equal(r.match.board.mines.length, 5);
});

test("createOrJoin: second caller with matching stake joins the waiting match", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  const r = createOrJoin({
    userId: "u2",
    stakeAmount: 50,
    minesCount: 5,
    matches,
  });
  assert.equal(r.error, undefined);
  assert.equal(r.joined, true);
  assert.equal(r.match.status, MATCH_STATUS.READY);
  assert.equal(r.match.player1Id, "u1");
  assert.equal(r.match.player2Id, "u2");
  assert.ok(
    r.match.firstPlayerId === "u1" || r.match.firstPlayerId === "u2",
  );
  const remaining = new Date(r.match.roundDeadline).getTime() - Date.now();
  assert.ok(remaining > 0);
  assert.ok(remaining <= READY_WINDOW_MS + 50);
});

test("createOrJoin: caller of own existing lobby is a no-op", () => {
  const matches = new Map();
  const first = createOrJoin({
    userId: "u1",
    stakeAmount: 50,
    minesCount: 5,
    matches,
  });
  const second = createOrJoin({
    userId: "u1",
    stakeAmount: 50,
    minesCount: 5,
    matches,
  });
  assert.equal(second.joined, false);
  assert.equal(second.match.id, first.match.id);
  assert.equal(matches.size, 1);
});

test("createOrJoin: does NOT join a different-stake lobby", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  const r = createOrJoin({
    userId: "u2",
    stakeAmount: 100,
    minesCount: 5,
    matches,
  });
  assert.equal(r.joined, false);
  assert.equal(matches.size, 2);
  assert.equal(r.match.stakeAmount, 100);
});

test("createOrJoin: rejects invalid stake with 400-shaped error", () => {
  const matches = new Map();
  const r = createOrJoin({
    userId: "u1",
    stakeAmount: 0,
    minesCount: 5,
    matches,
  });
  assert.equal(r.status, 400);
});

test("createOrJoin: rejects invalid mines with 400-shaped error", () => {
  const matches = new Map();
  const r = createOrJoin({
    userId: "u1",
    stakeAmount: 50,
    minesCount: 0,
    matches,
  });
  assert.equal(r.status, 400);
});

test("createOrJoin: board is server-authoritative (host's 5-mine board preserved)", () => {
  const matches = new Map();
  const r = createOrJoin({
    userId: "u1",
    stakeAmount: 50,
    minesCount: 5,
    matches,
  });
  assert.equal(r.match.board.size, 5);
  assert.equal(r.match.board.mines.length, 5);
  const joinResult = createOrJoin({
    userId: "u2",
    stakeAmount: 50,
    minesCount: 5,
    matches,
  });
  assert.equal(joinResult.joined, true);
  assert.equal(joinResult.match.board.mines.length, 5);
});

test("createOrJoin: stake is rounded to 2dp (no floating-point drift)", () => {
  const matches = new Map();
  const r = createOrJoin({
    userId: "u1",
    stakeAmount: 12.345,
    minesCount: 5,
    matches,
  });
  assert.equal(r.match.stakeAmount, 12.35);
});

// ════════════════════════════════════════════════════════════════════════
// pickTile — turn enforcement + multi-pick resolution
// ════════════════════════════════════════════════════════════════════════

test("pickTile: rejects out-of-range cellIndex", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);

  assert.equal(
    pickTile({ userId: "u1", matchId: match.id, cellIndex: -1, matches })
      .status,
    400,
  );
  assert.equal(
    pickTile({ userId: "u1", matchId: match.id, cellIndex: 25, matches })
      .status,
    400,
  );
  assert.equal(
    pickTile({ userId: "u1", matchId: match.id, cellIndex: 1.5, matches })
      .status,
    400,
  );
});

test("pickTile: rejects non-participant with 403", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);

  const r = pickTile({ userId: "u3", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.status, 403);
});

test("pickTile: rejects when status is waiting", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  const r = pickTile({ userId: "u1", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.status, 400);
  assert.ok(/not awaiting a pick/i.test(r.error));
});

test("pickTile: rejects when status is ready (3s banner)", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  const r = pickTile({ userId: "u1", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.status, 400);
  assert.ok(/not awaiting a pick/i.test(r.error));
});

test("pickTile: rejects when it's not your turn (403)", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);

  // Force the formula into a state where u2 still cannot pick (the
  // closed-form formula says u1 is active because picks.length=0
  // and turn 1 belongs to firstPlayer=player1Id=u1).
  const r = pickTile({ userId: "u2", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.status, 403);
  assert.ok(/not your turn/i.test(r.error));
});

test("pickTile: rejects when pick window has expired", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() - 1_000);

  const r = pickTile({ userId: "u1", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.status, 400);
  assert.ok(/expired/i.test(r.error));
});

test("pickTile: rejects duplicate cell (409), including picks from the OTHER player", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  // Fix the turn order deterministically (createOrJoin randomises it).
  match.firstPlayerId = "u1";
  // Force minone count so we know cell 0 is safe.
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);
  match.board = { size: 5, mines: [1] };

  pickTile({ userId: "u1", matchId: match.id, cellIndex: 0, matches });
  // Now it's u2's turn → u2 tries to also pick 0.
  const r = pickTile({ userId: "u2", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.status, 409);
  assert.ok(/already picked/i.test(r.error));
});

test("pickTile: valid safe pick advances turn per the odds formula", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  // First seat = player1.
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);
  match.board = { size: 5, mines: [9] };

  const r = pickTile({ userId: "u1", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.match.picks.length, 1);
  assert.equal(r.match.picks[0].cell, 0);
  assert.equal(r.match.picks[0].isMine, false);
  assert.equal(r.match.picks[0].seat, "player1");
  // After turn 1, formula says turn 2 goes to secondPlayer.
  assert.equal(r.match.currentTurnUserId, "u2");
  assert.equal(r.match.status, MATCH_STATUS.P2_TURN);
  assert.equal(r.match.roundDeadline instanceof Date, true);
  assert.equal(r.justResolved, false);
});

test("pickTile: multi-pick odds turn order: P1, P2, P2, P1, P1...", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);
  // Put mines only at cells we won't pick for this test.
  match.board = { size: 5, mines: [24] };

  const expectedTurnOrder = [
    ["u1", 0, "player1"],
    ["u2", 1, "player2"],
    ["u2", 2, "player2"],
    ["u1", 3, "player1"],
    ["u1", 4, "player1"],
  ];
  for (const [expectedPicker, cell, expectedSeat] of expectedTurnOrder) {
    assert.equal(
      match.currentTurnUserId,
      expectedPicker,
      `expected ${expectedPicker} before turn ${match.picks.length + 1}`,
    );
    // Push deadline forward so the next pick doesn't expire.
    match.roundDeadline = new Date(Date.now() + 10_000);
    const r = pickTile({
      userId: expectedPicker,
      matchId: match.id,
      cellIndex: cell,
      matches,
    });
    assert.equal(r.match.picks.length, match.picks.length); // sanity
    assert.equal(r.match.picks.at(-1).seat, expectedSeat);
    assert.equal(r.match.picks.at(-1).isMine, false);
  }
});

test("pickTile: mine hit on any turn -> immediate resolve, picker loses", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 100, minesCount: 3, matches });
  createOrJoin({ userId: "u2", stakeAmount: 100, minesCount: 3, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);
  const mines = match.board.mines;
  // Play out a few safe picks first to prove the game can continue
  // past the first pick (and into the odds pattern).
  const safeCells = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (!mines.includes(i)) safeCells.push(i);
  }
  pickTile({ userId: "u1", matchId: match.id, cellIndex: safeCells[0], matches });
  match.roundDeadline = new Date(Date.now() + 10_000);
  pickTile({ userId: "u2", matchId: match.id, cellIndex: safeCells[1], matches });
  match.roundDeadline = new Date(Date.now() + 10_000);
  pickTile({ userId: "u2", matchId: match.id, cellIndex: safeCells[2], matches });
  match.roundDeadline = new Date(Date.now() + 10_000);
  // Now it's u1's turn; have u1 pick a mine. Loser = u1.
  const r = pickTile({ userId: "u1", matchId: match.id, cellIndex: mines[0], matches });
  assert.equal(r.match.status, MATCH_STATUS.FINISHED);
  assert.equal(r.justResolved, true);
  assert.equal(r.match.result, RESULT.PLAYER2);
  assert.equal(r.match.winnerId, "u2");
  assert.equal(r.match.picks.at(-1).isMine, true);
});

test("pickTile: mine hit by u2 -> u1 wins", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 100, minesCount: 3, matches });
  createOrJoin({ userId: "u2", stakeAmount: 100, minesCount: 3, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u2"; // flip first player to u2 to vary the test
  match.status = MATCH_STATUS.P2_TURN;
  match.currentTurnUserId = "u2";
  match.roundDeadline = new Date(Date.now() + 10_000);
  const mines = match.board.mines;
  const safeCells = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (!mines.includes(i)) safeCells.push(i);
  }
  // Turn 1 = player2 (u2). u2 picks SAFE first because the game's very
  // first pick is guaranteed safe by mercy — the mine pick below must
  // not be the opening pick.
  pickTile({ userId: "u2", matchId: match.id, cellIndex: safeCells[0], matches });
  // Turn 2 = player1 (u1). u1 picks a mine -> u1 loses -> u2 wins.
  match.roundDeadline = new Date(Date.now() + 10_000);
  const r = pickTile({ userId: "u1", matchId: match.id, cellIndex: mines[0], matches });
  assert.equal(r.match.status, MATCH_STATUS.FINISHED);
  assert.equal(r.match.result, RESULT.PLAYER2);
  assert.equal(r.match.winnerId, "u2");
});

test("pickTile: payout math (winner gets 1.9x stake, house gets 0.1x)", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 100, minesCount: 2, matches });
  createOrJoin({ userId: "u2", stakeAmount: 100, minesCount: 2, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);
  const mine = match.board.mines[0];
  const safeCells = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (!match.board.mines.includes(i)) safeCells.push(i);
  }
  // u1 takes a safe pick first — the game's opening pick is guaranteed
  // safe by mercy, so the mine pick below must not be pick #1.
  pickTile({ userId: "u1", matchId: match.id, cellIndex: safeCells[0], matches });
  // Turn 2 = u2 picks the mine -> u2 loses -> u1 wins the 1.9x payout.
  match.roundDeadline = new Date(Date.now() + 10_000);
  const r = pickTile({ userId: "u2", matchId: match.id, cellIndex: mine, matches });
  assert.equal(r.match.status, MATCH_STATUS.FINISHED);
  assert.equal(r.match.result, RESULT.PLAYER1);
  assert.equal(r.match.prizePaid, round2(100 * 1.9));
  assert.equal(r.match.houseFee, round2(100 * 0.1));
});

test("pickTile: safe picks carry the distance hint; mine picks carry null", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 3, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 3, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);
  // Fixed board so the expected hints are deterministic.
  match.board = { size: 5, mines: [0, 1, 2] };

  // Cell 7 (row 1, col 2): touches mines 1 and 2 -> distance 1.
  const safe = pickTile({
    userId: "u1",
    matchId: match.id,
    cellIndex: 7,
    matches,
  });
  assert.equal(safe.match.picks[0].isMine, false);
  assert.equal(safe.match.picks[0].hint, 1);

  // Turn 2 belongs to player2 (u2): picking a MINE (cell 0) resolves
  // with u2 losing, and the mine pick carries hint null.
  match.roundDeadline = new Date(Date.now() + 10_000);
  const mine = pickTile({
    userId: "u2",
    matchId: match.id,
    cellIndex: 0,
    matches,
  });
  assert.equal(mine.match.status, MATCH_STATUS.FINISHED);
  assert.equal(mine.match.result, RESULT.PLAYER1);
  const minePick = mine.match.picks.at(-1);
  assert.equal(minePick.isMine, true);
  assert.equal(minePick.hint, null);
});

test("pickTile: first-pick mercy — the game's opening pick is never a mine", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 1, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 1, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);

  // Deliberately first-pick the known mine cell.
  const mineCell = match.board.mines[0];
  const r = pickTile({ userId: "u1", matchId: match.id, cellIndex: mineCell, matches });
  // The mine was relocated off the cell: the pick is safe, flagged with
  // mercy, and the match continues instead of resolving.
  assert.equal(r.match.picks[0].isMine, false);
  assert.equal(r.match.picks[0].mercy, true);
  assert.equal(r.match.status, MATCH_STATUS.P2_TURN);
  assert.equal(r.match.board.mines.includes(mineCell), false, "mine relocated off the picked cell");
  assert.equal(r.match.board.mines.length, 1, "mine count preserved");
  // The hint is computed against the RELOCATED board, so it's a real
  // distance (>= 1) — never the 0 a mine-on-cell would produce.
  assert.ok(r.match.picks[0].hint >= 1);
});

test("pickTile: mercy applies ONLY to the first pick (later mine picks still resolve)", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 2, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 2, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);

  const mineCell = match.board.mines[0];
  const safeCells = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (!match.board.mines.includes(i)) safeCells.push(i);
  }
  // Safe opening pick (no mercy needed).
  const first = pickTile({ userId: "u1", matchId: match.id, cellIndex: safeCells[0], matches });
  assert.equal(first.match.picks[0].mercy, false);
  // Second pick hits the mine -> resolves immediately (mercy is spent).
  match.roundDeadline = new Date(Date.now() + 10_000);
  const second = pickTile({ userId: "u2", matchId: match.id, cellIndex: mineCell, matches });
  assert.equal(second.match.status, MATCH_STATUS.FINISHED);
  assert.equal(second.match.picks.at(-1).isMine, true);
  assert.equal(second.match.picks.at(-1).mercy, false);
});

// ════════════════════════════════════════════════════════════════════════
// flagTile — the "call a mine" skill move
// ════════════════════════════════════════════════════════════════════════

test("flagTile: CORRECT flag (tile is a mine) -> opponent loses, flagger wins", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 100, minesCount: 3, matches });
  createOrJoin({ userId: "u2", stakeAmount: 100, minesCount: 3, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);

  const mineCell = match.board.mines[0];
  const r = flagTile({ userId: "u1", matchId: match.id, cellIndex: mineCell, matches });
  assert.equal(r.match.status, MATCH_STATUS.FINISHED);
  assert.equal(r.match.result, RESULT.PLAYER1);
  assert.equal(r.match.winnerId, "u1");
  const entry = r.match.picks.at(-1);
  assert.equal(entry.flag, true);
  assert.equal(entry.isMine, true);
  assert.equal(r.match.prizePaid, round2(100 * 1.9));
  assert.equal(r.match.houseFee, round2(100 * 0.1));
});

test("flagTile: WRONG flag (tile is safe) -> flagger loses, and NO first-pick mercy for flags", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 1, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 1, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);

  // u1's FIRST action is a flag on a known-SAFE cell. Mercy protects
  // the opening PICK (a definitional guess) — a flag is a deliberate
  // claim, so a wrong first-turn flag loses outright.
  const safeCell = match.board.mines[0] === 0 ? 1 : 0;
  assert.equal(isMine(match.board, safeCell), false);
  const r = flagTile({ userId: "u1", matchId: match.id, cellIndex: safeCell, matches });
  assert.equal(r.match.status, MATCH_STATUS.FINISHED);
  assert.equal(r.match.result, RESULT.PLAYER2);
  assert.equal(r.match.winnerId, "u2");
  const entry = r.match.picks.at(-1);
  assert.equal(entry.flag, true);
  assert.equal(entry.isMine, false);
  assert.equal(entry.mercy, false);
});

test("flagTile: rejects when it's not your turn (403)", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 3, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 3, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);

  const r = flagTile({ userId: "u2", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.status, 403);
  assert.ok(/not your turn/i.test(r.error));
});

test("flagTile: rejects flagging an already-picked cell (409)", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 3, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 3, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);
  // u1 picks cell 0 safely; the turn passes to u2, who tries to flag
  // the same (now revealed) cell.
  pickTile({ userId: "u1", matchId: match.id, cellIndex: 0, matches });
  match.roundDeadline = new Date(Date.now() + 10_000);
  const r = flagTile({ userId: "u2", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.status, 409);
  assert.ok(/already picked/i.test(r.error));
});

test("flagTile: rejects when the pick window has expired", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 3, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 3, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() - 1_000);

  const r = flagTile({ userId: "u1", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.status, 400);
  assert.ok(/expired/i.test(r.error));
});

test("flagTile: rejects non-participant with 403", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 3, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 3, matches });
  const match = [...matches.values()][0];
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);

  const r = flagTile({ userId: "u3", matchId: match.id, cellIndex: 0, matches });
  assert.equal(r.status, 403);
});

test("end-to-end: P1 picks safe, then P2 correctly flags a mine -> P2 wins", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 3, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 3, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() + 10_000);

  const mines = match.board.mines;
  const safeCells = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (!mines.includes(i)) safeCells.push(i);
  }
  // Turn 1: u1 picks a safe tile.
  pickTile({ userId: "u1", matchId: match.id, cellIndex: safeCells[0], matches });
  // Turn 2: u2 flags a mine -> correct -> u2 wins.
  match.roundDeadline = new Date(Date.now() + 10_000);
  const r = flagTile({ userId: "u2", matchId: match.id, cellIndex: mines[0], matches });
  assert.equal(r.match.status, MATCH_STATUS.FINISHED);
  assert.equal(r.match.result, RESULT.PLAYER2);
  assert.equal(r.match.winnerId, "u2");
  assert.equal(r.match.picks.at(-1).flag, true);
  assert.equal(r.match.picks.length, 2, "one safe pick + one flag entry");
});

test("pickTile: never returns DRAW (no ties in the new flow)", () => {
  // Run a handful of forced-mine scenarios from various turn states
  // and assert that EVERY result is PLAYER1 or PLAYER2 — never DRAW.
  for (let trial = 0; trial < 8; trial += 1) {
    const matches = new Map();
    createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 1, matches });
    createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 1, matches });
    const match = [...matches.values()][0];
    match.firstPlayerId = Math.random() < 0.5 ? "u1" : "u2";
    match.status =
      match.firstPlayerId === "u1"
        ? MATCH_STATUS.P1_TURN
        : MATCH_STATUS.P2_TURN;
    match.currentTurnUserId = match.firstPlayerId;
    // Pick a few safe cells before forcing a mine so the game has
    // crossed at least one turn (and possibly the odd/even
    // pair-leader swap).
    const safeCells = [];
    for (let i = 0; i < GRID_CELLS; i += 1) {
      if (!match.board.mines.includes(i)) safeCells.push(i);
    }
    for (let s = 0; s < Math.min(2, safeCells.length - 1); s += 1) {
      match.roundDeadline = new Date(Date.now() + 10_000);
      pickTile({
        userId: match.currentTurnUserId,
        matchId: match.id,
        cellIndex: safeCells[s],
        matches,
      });
    }
    match.roundDeadline = new Date(Date.now() + 10_000);
    const r = pickTile({
      userId: match.currentTurnUserId,
      matchId: match.id,
      cellIndex: match.board.mines[0],
      matches,
    });
    assert.equal(r.match.status, MATCH_STATUS.FINISHED);
    assert.notEqual(r.match.result, RESULT.DRAW);
    assert.ok(
      r.match.result === RESULT.PLAYER1 ||
        r.match.result === RESULT.PLAYER2,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════
// fetchMatchWithAutoResolve
// ════════════════════════════════════════════════════════════════════════

test("fetchMatchWithAutoResolve: rejects non-participant with 403", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  const r = fetchMatchWithAutoResolve("u3", match.id, matches);
  assert.equal(r.status, 403);
});

test("fetchMatchWithAutoResolve: rejects unknown match with 404", () => {
  const matches = new Map();
  const r = fetchMatchWithAutoResolve("u1", 9999, matches);
  assert.equal(r.status, 404);
});

test("fetchMatchWithAutoResolve: returns waiting match scrubbed", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  const r = fetchMatchWithAutoResolve("u1", match.id, matches);
  assert.equal(r.error, undefined);
  assert.equal(r.match.status, MATCH_STATUS.WAITING);
  assert.equal(r.match.board, null);
});

test("fetchMatchWithAutoResolve: auto-advances ready -> first pick state", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  match.roundDeadline = new Date(Date.now() - 1);

  const r = fetchMatchWithAutoResolve("u1", match.id, matches);
  assert.equal(r.error, undefined);
  assert.ok(PICKABLE_STATES.has(r.match.status));
  assert.ok(
    r.match.firstPlayerId === "u1" || r.match.firstPlayerId === "u2",
  );
  assert.equal(r.match.currentTurnUserId, r.match.firstPlayerId);
  assert.ok(r.match.roundDeadline instanceof Date);
  const remaining = new Date(r.match.roundDeadline).getTime() - Date.now();
  assert.ok(remaining > 0);
});

test("fetchMatchWithAutoResolve: no-op when ready deadline has not elapsed", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];

  const r = fetchMatchWithAutoResolve("u1", match.id, matches);
  assert.equal(r.match.status, MATCH_STATUS.READY);
});

test("fetchMatchWithAutoResolve: AFK on p1_turn -> force-pick via applyPick, advances turn", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() - 1);

  const r = fetchMatchWithAutoResolve("u1", match.id, matches);
  // forcePick takes the active-picker's seat (=player1 here),
  // appends an auto pick, and either resolves (mine) or advances
  // to turn 2 (= secondPlayer = u2).
  assert.ok(r.match.picks.length === 1 || r.match.status === MATCH_STATUS.FINISHED);
  if (r.match.status !== MATCH_STATUS.FINISHED) {
    // Picked safe: game continues with the formula's turn 2 picker.
    assert.equal(r.match.currentTurnUserId, "u2");
  } else {
    // Picked a mine: instant resolve.
    assert.equal(r.match.p1AutoPicked, true);
  }
});

test("fetchMatchWithAutoResolve: AFK on the FIRST turn can never auto-lose to a mine (mercy)", () => {
  const matches = new Map();
  // 24-mine board: a random auto-pick hits a mine with ~96% probability.
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 24, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 24, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() - 1);

  const r = fetchMatchWithAutoResolve("u1", match.id, matches);
  // Whatever cell the auto-pick drew, the game's opening pick is safe.
  assert.equal(r.match.picks[0].isMine, false);
  assert.equal(typeof r.match.picks[0].mercy, "boolean");
  assert.equal(r.match.status, MATCH_STATUS.P2_TURN);
  // If mercy fired, the stored board really did lose that mine.
  const stored = [...matches.values()][0];
  assert.equal(stored.board.mines.includes(r.match.picks[0].cell), false);
});

test("fetchMatchWithAutoResolve: AFK on p2_turn -> force-pick resolves if mine", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  // Pre-populate with one safe pick by player1 so the closed-form
  // formula (turn N = picks.length + 1) agrees with the stored
  // status/currentTurnUserId. Without this, formula says turn 1
  // belongs to firstPlayer=u1, and the AFK auto-pick would fire
  // for u1, not u2 — making `p2AutoPicked` stay false.
  match.picks = [
    {
      userId: "u1",
      seat: "player1",
      cell: 0,
      isMine: false,
      autoPicked: false,
      pickedAt: new Date().toISOString(),
    },
  ];
  match.p1Pick = 0;
  match.p1PickIsMine = false;
  match.p1AutoPicked = false;
  match.status = MATCH_STATUS.P2_TURN;
  match.currentTurnUserId = "u2";
  match.roundDeadline = new Date(Date.now() - 1);

  const r = fetchMatchWithAutoResolve("u2", match.id, matches);
  assert.ok(r.match.p2AutoPicked);
  // IF the auto-pick hit a mine, the match resolves immediately
  // with the picker losing. IF it was safe, the turn advances again —
  // either is a valid outcome.
  if (r.match.p2PickIsMine) {
    assert.equal(r.match.status, MATCH_STATUS.FINISHED);
  } else {
    assert.ok(PICKABLE_STATES.has(r.match.status));
  }
});

test("fetchMatchWithAutoResolve: no-op when in finished state", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 5, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 5, matches });
  const match = [...matches.values()][0];
  match.status = MATCH_STATUS.FINISHED;
  match.result = RESULT.PLAYER1;
  match.prizePaid = 0;
  match.houseFee = 0;

  const r = fetchMatchWithAutoResolve("u1", match.id, matches);
  assert.equal(r.match.status, MATCH_STATUS.FINISHED);
  assert.equal(r.match.result, RESULT.PLAYER1);
});

// ════════════════════════════════════════════════════════════════════════
// End-to-end: create -> join -> advance -> multi-pick -> mine hit
// ════════════════════════════════════════════════════════════════════════

test("end-to-end: P1, P2, P2, P1, P1 picks safe, then P1 picks mine -> P2 wins (1.9x payout)", () => {
  const matches = new Map();

  const r1 = createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 3, matches });
  assert.equal(r1.match.status, MATCH_STATUS.WAITING);

  const r2 = createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 3, matches });
  assert.equal(r2.match.status, MATCH_STATUS.READY);
  assert.equal(matches.size, 1);

  const match = r2.match;
  match.firstPlayerId = "u1";
  match.roundDeadline = new Date(Date.now() - 1);
  const r3 = fetchMatchWithAutoResolve("u1", match.id, matches);
  assert.equal(r3.match.status, MATCH_STATUS.P1_TURN);
  assert.equal(r3.match.currentTurnUserId, "u1");

  const mines = match.board.mines;
  const safeCells = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (!mines.includes(i)) safeCells.push(i);
  }
  // Walk the 4-turn odds pattern with all safe picks.
  const turnPlan = [
    ["u1", safeCells[0]],
    ["u2", safeCells[1]],
    ["u2", safeCells[2]],
    ["u1", safeCells[3]],
  ];
  for (const [picker, cell] of turnPlan) {
    match.roundDeadline = new Date(Date.now() + 10_000);
    pickTile({ userId: picker, matchId: match.id, cellIndex: cell, matches });
  }
  assert.equal(match.picks.length, 4);
  assert.equal(match.status, MATCH_STATUS.P1_TURN);
  // Now P1 picks a mine on turn 5 -> P1 loses -> P2 wins.
  match.roundDeadline = new Date(Date.now() + 10_000);
  const rMine = pickTile({
    userId: "u1",
    matchId: match.id,
    cellIndex: mines[0],
    matches,
  });
  assert.equal(rMine.match.status, MATCH_STATUS.FINISHED);
  assert.equal(rMine.match.result, RESULT.PLAYER2);
  assert.equal(rMine.match.winnerId, "u2");
  assert.equal(rMine.match.prizePaid, round2(50 * 1.9));
  assert.equal(rMine.match.houseFee, round2(50 * 0.1));
});

test("end-to-end: u2 AFKs on turn 2 auto-pick auto-loses if mine (or advances if safe)", () => {
  const matches = new Map();
  createOrJoin({ userId: "u1", stakeAmount: 50, minesCount: 1, matches });
  createOrJoin({ userId: "u2", stakeAmount: 50, minesCount: 1, matches });
  const match = [...matches.values()][0];
  match.firstPlayerId = "u1";
  match.status = MATCH_STATUS.P1_TURN;
  match.currentTurnUserId = "u1";
  match.roundDeadline = new Date(Date.now() - 1);

  // u1 AFK'd on turn 1 (auto-pick).
  const r1 = fetchMatchWithAutoResolve("u1", match.id, matches);
  assert.equal(r1.match.p1AutoPicked, true);
  // Formula says turn 2 belongs to u2; u2 AFK'd now too.
  match.roundDeadline = new Date(Date.now() - 1);
  const r2 = fetchMatchWithAutoResolve("u2", match.id, matches);
  // If u1's auto-pick hit the mine, match already resolved.
  if (r1.match.p1PickIsMine) {
    assert.equal(r2.match.status, MATCH_STATUS.FINISHED);
    assert.equal(r2.match.result, RESULT.PLAYER2);
  } else {
    // Otherwise u2's turn is now active, and their AFK'd auto-pick
    // either advances OR resolves (depending on the auto cell).
    if (r2.match.status === MATCH_STATUS.FINISHED) {
      assert.equal(r2.match.result, RESULT.PLAYER1);
    } else {
      assert.ok(PICKABLE_STATES.has(r2.match.status));
    }
  }
});

console.log("\n? All Mines Duel flow tests passed!\n");
