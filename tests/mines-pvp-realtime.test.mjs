/**
 * Mines Duel — realtime / socket-behavior + disconnect-reconnect contract.
 *
 * The simultaneous rework removed turns entirely. The realtime layer keeps the
 * EXISTING infrastructure (per-match Socket.IO room + the generic
 * `lobby:updated` "refetch the authoritative snapshot" relay) and adds only:
 *   • a cosmetic, SERVER-ONLY `mines-pvp:score` animation hint, and
 *   • a SERVER-ONLY `mines-pvp:opponent:reconnected` presence hint.
 *
 * This file pins the contract the rework has to hold:
 *   1. room/event ids and the broadcast helpers (with and without a live io);
 *   2. the realtime-server's participant tracking + disconnect-forfeit wiring,
 *      and the fact that the two server-only events can't be forged via the
 *      generic `room_event` relay (`lobby:updated` stays forgeable — it is a
 *      bare refetch hint and the refetch is authoritative);
 *   3. race handling — different tiles, same tile, timer edge, completion
 *      edge, post-completion, and duplicate/replayed events;
 *   4. reconnecting during normal play, after a board completion, near the
 *      timer, and after match completion — a blip never awards a win, freezes
 *      the opponent, or changes a score/board, and the reconnect always sees
 *      the correct PLAYER-SPECIFIC board state;
 *   5. no hidden mine data ever crosses the wire (broadcasts or viewer payload).
 *
 * Run:  node --import tsx --test tests/mines-pvp-realtime.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  MINES_PVP_LOBBY_ROOM,
  MINES_PVP_MATCH_ROOM_PREFIX,
  MINES_PVP_MATCH_UPDATED,
  MINES_PVP_SCORE_EVENT,
  minesPvpMatchRoom,
  broadcastMatchUpdate,
  broadcastScoreEvent,
} from "../src/lib/mines-pvp/rooms.js";

import {
  GRID_CELLS,
  MATCH_STATUS,
  MATCH_TIMER_SECONDS,
  MINES_PER_MATCH,
  PICKABLE_STATES,
  RESULT,
  SCORE,
  TERMINAL_STATES,
  WIN_REASON,
  applyScoreDelta,
  correctFlagsForSeat,
  decideScoredWinner,
  flagsForSeat,
  generateBoardPair,
  isBoardComplete,
  isMine,
  mineValueAt,
  normalizeFlags,
} from "../src/lib/mines-pvp/constants.js";

import { normaliseMatchForViewer } from "../src/lib/mines-pvp/matchView.js";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const SERVER = read("realtime-server/server.js");
const FORFEIT_ROUTE = read("src/app/api/mines-pvp/disconnect-forfeit/route.js");
const STORE = read("src/lib/mines-pvp/serverStore.js");

// ═══════════════════════════════════════════════════════════════════════
// 1. Room + event taxonomy
// ═══════════════════════════════════════════════════════════════════════

test("the per-match room id is namespaced and stable", () => {
  assert.equal(MINES_PVP_MATCH_ROOM_PREFIX, "mines-pvp:match:");
  assert.equal(minesPvpMatchRoom(42), "mines-pvp:match:42");
  assert.equal(MINES_PVP_LOBBY_ROOM, "lobby:mines-pvp");
  // The generic refetch hint keeps its long-standing name (clients rely on it).
  assert.equal(MINES_PVP_MATCH_UPDATED, "lobby:updated");
});

test("the score event has its own server-only name, distinct from the refetch hint", () => {
  assert.equal(MINES_PVP_SCORE_EVENT, "mines-pvp:score");
  assert.notEqual(MINES_PVP_SCORE_EVENT, MINES_PVP_MATCH_UPDATED);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Broadcast helpers
// ═══════════════════════════════════════════════════════════════════════

/** Install a fake `globalThis.io`, run `fn`, and always restore. */
function withIo(io, fn) {
  const previous = globalThis.io;
  globalThis.io = io;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete globalThis.io;
    else globalThis.io = previous;
  }
}

test("broadcastMatchUpdate emits the refetch hint to the per-match room only", () => {
  const sent = [];
  const io = {
    to(room) {
      return {
        emit(event, payload) {
          sent.push({ room, event, payload });
        },
      };
    },
  };
  const ok = withIo(io, () =>
    broadcastMatchUpdate(7, { status: "active", p1Score: 5, p2Score: 0 }),
  );
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].room, "mines-pvp:match:7");
  assert.equal(sent[0].event, "lobby:updated");
  assert.equal(sent[0].payload.matchId, 7);
  assert.equal(sent[0].payload.p1Score, 5);
  // The envelope is stamped, but carries no board / mine data.
  assert.equal(typeof sent[0].payload.sentAt, "string");
  assert.equal(JSON.stringify(sent[0].payload).includes("Board"), false);
});

test("broadcastScoreEvent emits the cosmetic score hint to the per-match room", () => {
  const sent = [];
  const io = {
    to(room) {
      return {
        emit(event, payload) {
          sent.push({ room, event, payload });
        },
      };
    },
  };
  const ok = withIo(io, () =>
    broadcastScoreEvent(7, { seat: "player1", delta: 5, reason: "safe" }),
  );
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].room, "mines-pvp:match:7");
  assert.equal(sent[0].event, "mines-pvp:score");
  assert.equal(sent[0].payload.seat, "player1");
  assert.equal(sent[0].payload.delta, 5);
  assert.equal(sent[0].payload.reason, "safe");
});

test("both broadcast helpers no-op (never throw) when no io is reachable", () => {
  const previous = globalThis.io;
  delete globalThis.io;
  try {
    assert.equal(broadcastMatchUpdate(1, { status: "active" }), false);
    assert.equal(broadcastScoreEvent(1, { delta: 5 }), false);
  } finally {
    if (previous !== undefined) globalThis.io = previous;
  }
});

test("a throwing io is swallowed, not propagated into the action path", () => {
  const io = {
    to() {
      throw new Error("socket layer down");
    },
  };
  const ok = withIo(io, () => broadcastMatchUpdate(1, { status: "active" }));
  assert.equal(ok, false);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. realtime-server wiring + reserved server-only events
// ═══════════════════════════════════════════════════════════════════════

test("the realtime-server tracks Mines participants and cancels the grace timer on rejoin", () => {
  assert.match(SERVER, /const MINES_PVP_MATCH_ROOM_PREFIX = "mines-pvp:match:"/);
  assert.match(SERVER, /function trackMinesPvpJoin\(roomId, userId\)/);
  assert.match(SERVER, /function trackMinesPvpLeave\(roomId, userId\)/);
  assert.match(SERVER, /trackMinesPvpJoin\(String\(roomId\), socket\.data\.userId\)/);
  assert.match(SERVER, /trackMinesPvpLeave\(String\(roomId\), socket\.data\.userId\)/);
  // Rejoin cancels the pending forfeit for THAT match+user.
  assert.match(SERVER, /cancelDisconnectGraceTimer\(`mines:\$\{matchId\}:\$\{userId\}`\)/);
  // The presence event is emitted ONLY on a real reconnect (a pending timer),
  // never on a first join.
  assert.match(
    SERVER,
    /const wasAway = cancelDisconnectGraceTimer\(`mines:\$\{matchId\}:\$\{userId\}`\);/,
  );
  assert.match(
    SERVER,
    /if \(wasAway\) \{[\s\S]{0,220}mines-pvp:opponent:reconnected/,
  );
});

test("an abandoned Mines socket schedules a disconnect-forfeit POST through the grace window", () => {
  assert.match(
    SERVER,
    /scheduleDisconnectGraceTimer\(`mines:\$\{mid\}:\$\{socket\.data\.userId\}`/,
  );
  assert.match(SERVER, /\/api\/mines-pvp\/disconnect-forfeit/);
  // The forfeit body is matchId + the socket's Clerk token only.
  assert.match(
    SERVER,
    /body: JSON\.stringify\(\{ matchId: mid, token: socket\.data\.clerkToken \}\)/,
  );
  // A still-live socket for the same room aborts the pending forfeit.
  assert.match(SERVER, /if \(hasLiveSocketForUser\(socket\.data\.userId, roomId\)\) return false;/);
});

test("the two Mines server-only events are reserved against client forgery", () => {
  // The reserved list is the `if (...)` immediately after
  // `const relayedEvent = String(event);` — slice to the relay emit.
  const start = SERVER.indexOf("const relayedEvent = String(event);");
  const end = SERVER.indexOf("socket.to(String(roomId)).emit(String(event)");
  assert.ok(start > -1 && end > start, "the reserved-event block exists");
  const reservedBlock = SERVER.slice(start, end);
  assert.match(reservedBlock, /relayedEvent === "mines-pvp:score"/);
  assert.match(reservedBlock, /relayedEvent === "mines-pvp:opponent:reconnected"/);
  // `lobby:updated` must stay unreserved — it is a bare refetch hint.
  assert.equal(reservedBlock.includes('"lobby:updated"'), false);
});

test("the disconnect-forfeit endpoint re-verifies the token and broadcasts the result", () => {
  assert.match(FORFEIT_ROUTE, /verifyToken\(token, \{ secretKey: CLERK_SECRET_KEY \}\)/);
  assert.match(FORFEIT_ROUTE, /forfeitMatchOnDisconnect\(\{/);
  assert.match(FORFEIT_ROUTE, /loserClerkId: clerkUserId/);
  assert.match(FORFEIT_ROUTE, /broadcastMatchUpdate\(matchId, \{/);
  // Only matchId + token are read from the body — nothing about score/board.
  assert.doesNotMatch(FORFEIT_ROUTE, /body\?\.score|body\?\.board|body\?\.winner/);
});

test("the retry loop stops (success:true) on definitive 403/404 but retries transient errors", () => {
  assert.match(FORFEIT_ROUTE, /result\.status === 403 \|\| result\.status === 404/);
  assert.match(FORFEIT_ROUTE, /success: true,\s*\n\s*data: \{ forfeited: false, reason: result\.error \}/);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. In-memory mirror of the simultaneous state machine
// ═══════════════════════════════════════════════════════════════════════

function makeMatch({ id = 1, player1Id = "p1", player2Id = "p2" } = {}) {
  const { board1, board2 } = generateBoardPair(MINES_PER_MATCH);
  return {
    id,
    player1Id,
    player2Id,
    stakeAmount: 0,
    minesCount: MINES_PER_MATCH,
    status: MATCH_STATUS.WAITING,
    p1Board: board1,
    p2Board: board2,
    p1Revealed: [],
    p2Revealed: [],
    p1Flags: [],
    p2Flags: [],
    p1CorrectFlags: [],
    p2CorrectFlags: [],
    p1Score: 0,
    p2Score: 0,
    p1SafeRevealed: 0,
    p2SafeRevealed: 0,
    p1MinesHit: 0,
    p2MinesHit: 0,
    p1CorrectFlagCount: 0,
    p2CorrectFlagCount: 0,
    p1IncorrectFlagCount: 0,
    p2IncorrectFlagCount: 0,
    p1Completed: false,
    p2Completed: false,
    p1CompletedAt: null,
    p2CompletedAt: null,
    p1Locked: false,
    p2Locked: false,
    matchDeadline: null,
    matchTimerSeconds: MATCH_TIMER_SECONDS,
    result: null,
    winnerId: null,
    winReason: null,
    startedAt: null,
    endedAt: null,
  };
}

const seatOf = (match, userId) => (match.player1Id === userId ? "player1" : "player2");
const boardOf = (match, s) => (s === "player2" ? match.p2Board : match.p1Board);
const key = (s, base) => (s === "player2" ? `p2${base}` : `p1${base}`);
const isLocked = (match, s) => Boolean(match[key(s, "Locked")]);
const isExpired = (match) =>
  Boolean(match.matchDeadline && new Date(match.matchDeadline).getTime() <= Date.now());

function beginMatch(match, seconds = MATCH_TIMER_SECONDS) {
  match.status = MATCH_STATUS.ACTIVE;
  match.matchDeadline = new Date(Date.now() + seconds * 1000);
  match.startedAt = new Date();
  return match;
}

function completeIfDone(match, s, revealed, correctFlags, score) {
  if (isBoardComplete(boardOf(match, s), revealed, correctFlags)) {
    match[key(s, "Completed")] = true;
    match[key(s, "CompletedAt")] = new Date();
    match[key(s, "Locked")] = true;
    return applyScoreDelta(score, SCORE.BOARD_COMPLETE);
  }
  return score;
}

/**
 * Mirror of the store's gate chain shared by reveal/flag/unflag: participant,
 * pickable state, server-authoritative timer, then per-seat lock.
 */
function guard(match, userId) {
  if (!PICKABLE_STATES.has(match.status)) {
    return { error: "Match is not active", status: 400 };
  }
  if (isExpired(match)) return { error: "Match timer has expired", status: 400 };
  const s = seatOf(match, userId);
  if (isLocked(match, s)) return { error: "Your board is already locked", status: 400 };
  return { seat: s };
}

function applyReveal(match, userId, cellIndex) {
  const g = guard(match, userId);
  if (g.error) return g;
  const s = g.seat;
  if (match[key(s, "Revealed")].includes(cellIndex)) return { error: "already revealed", status: 409 };
  if (match[key(s, "CorrectFlags")].includes(cellIndex)) return { error: "confirmed mine", status: 409 };

  const board = boardOf(match, s);
  const mine = isMine(board, cellIndex);
  let score = match[key(s, "Score")];
  let delta;
  let reason;
  if (mine) {
    score = applyScoreDelta(score, SCORE.MINE_HIT);
    match[key(s, "MinesHit")] += 1;
    delta = score - match[key(s, "Score")];
    reason = "mine_hit";
  } else {
    score = applyScoreDelta(score, SCORE.SAFE_TILE);
    match[key(s, "SafeRevealed")] += 1;
    delta = score - match[key(s, "Score")];
    reason = "safe";
  }
  match[key(s, "Revealed")] = normalizeFlags([...match[key(s, "Revealed")], cellIndex]);
  match[key(s, "Flags")] = match[key(s, "Flags")].filter((c) => c !== cellIndex);
  const afterComplete = completeIfDone(match, s, match[key(s, "Revealed")], match[key(s, "CorrectFlags")], score);
  if (afterComplete !== score) {
    delta = afterComplete - score;
    reason = "complete";
  }
  match[key(s, "Score")] = afterComplete;
  maybeResolve(match);
  return { match, seat: s, revealedMine: mine, scoreDelta: delta, scoreReason: reason };
}

function applyFlag(match, userId, cellIndex) {
  const g = guard(match, userId);
  if (g.error) return g;
  const s = g.seat;
  if (match[key(s, "Revealed")].includes(cellIndex)) return { error: "revealed", status: 409 };
  if (match[key(s, "Flags")].includes(cellIndex)) return { error: "already flagged", status: 409 };

  const board = boardOf(match, s);
  const mine = isMine(board, cellIndex);
  let score = match[key(s, "Score")];
  let delta;
  let reason;
  if (mine) {
    const value = mineValueAt(board, cellIndex);
    score = applyScoreDelta(score, value);
    match[key(s, "CorrectFlags")] = normalizeFlags([...match[key(s, "CorrectFlags")], cellIndex]);
    match[key(s, "CorrectFlagCount")] += 1;
    delta = score - match[key(s, "Score")];
    reason = "correct_flag";
  } else {
    score = applyScoreDelta(score, SCORE.WRONG_FLAG);
    match[key(s, "IncorrectFlagCount")] += 1;
    delta = score - match[key(s, "Score")];
    reason = "wrong_flag";
  }
  match[key(s, "Flags")] = normalizeFlags([...match[key(s, "Flags")], cellIndex]);
  const afterComplete = completeIfDone(match, s, match[key(s, "Revealed")], match[key(s, "CorrectFlags")], score);
  if (afterComplete !== score) {
    delta = afterComplete - score;
    reason = "complete";
  }
  match[key(s, "Score")] = afterComplete;
  maybeResolve(match);
  return { match, seat: s, flagCorrect: mine, mineValue: mine ? mineValueAt(board, cellIndex) : null, scoreDelta: delta, scoreReason: reason };
}

function applyUnflag(match, userId, cellIndex) {
  const g = guard(match, userId);
  if (g.error) return g;
  const s = g.seat;
  if (!match[key(s, "Flags")].includes(cellIndex)) return { error: "not flagged", status: 409 };
  if (match[key(s, "CorrectFlags")].includes(cellIndex)) return { error: "cannot unflag confirmed", status: 409 };
  match[key(s, "Flags")] = match[key(s, "Flags")].filter((c) => c !== cellIndex);
  return { match, seat: s, unflagged: true, scoreDelta: 0 };
}

function statsOf(match, s) {
  return {
    score: match[key(s, "Score")],
    minesHit: match[key(s, "MinesHit")],
    incorrectFlags: match[key(s, "IncorrectFlagCount")],
    correctFlags: match[key(s, "CorrectFlagCount")],
    completedAt: match[key(s, "CompletedAt")],
    completed: match[key(s, "Completed")],
  };
}

function maybeResolve(match) {
  if (match.status !== MATCH_STATUS.ACTIVE) return match;
  const both = match.p1Completed && match.p2Completed;
  if (!both && !isExpired(match)) return match;
  const winner = decideScoredWinner(statsOf(match, "player1"), statsOf(match, "player2"));
  match.status = MATCH_STATUS.FINISHED;
  match.result = winner;
  match.winnerId =
    winner === RESULT.PLAYER1
      ? match.player1Id
      : winner === RESULT.PLAYER2
        ? match.player2Id
        : null;
  match.winReason = WIN_REASON.SCORE;
  match.endedAt = new Date();
  match.matchDeadline = null;
  return match;
}

function fixedBoard(values = {}) {
  return { size: 10, mines: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], values };
}
const SAFE_A = 55;
const SAFE_B = 56;
const SAFE_C = 57;

function clearBoard(match, userId) {
  const s = seatOf(match, userId);
  const board = boardOf(match, s);
  const safe = Array.from({ length: GRID_CELLS }, (_, i) => i).filter(
    (i) => !board.mines.includes(i),
  );
  for (const c of safe) applyReveal(match, userId, c);
  for (const m of board.mines) applyFlag(match, userId, m);
  return match;
}

// ═══════════════════════════════════════════════════════════════════════
// 5. Simultaneous actions + race handling
// ═══════════════════════════════════════════════════════════════════════

test("both seats may act simultaneously on their OWN boards — no shared board", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard();
  match.p2Board = fixedBoard();
  beginMatch(match);

  applyReveal(match, "p1", SAFE_A);
  applyReveal(match, "p2", 12); // same instant, different seat
  applyReveal(match, "p1", SAFE_B); // p1 acts again immediately — no turn gate
  applyReveal(match, "p2", 13);

  assert.equal(match.p1SafeRevealed, 2);
  assert.equal(match.p2SafeRevealed, 2);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
  // p1's actions only ever touched p1's board and vice-versa.
  assert.deepEqual(
    [...match.p1Revealed].sort((a, b) => a - b),
    [SAFE_A, SAFE_B].sort((a, b) => a - b),
  );
  assert.deepEqual(
    [...match.p2Revealed].sort((a, b) => a - b),
    [12, 13],
  );
});

test("a reveal and a flag racing on different tiles both apply, once each", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({ "0": 20 });
  match.p2Board = fixedBoard();
  beginMatch(match);

  const reveal = applyReveal(match, "p1", SAFE_A); // +5
  const flag = applyFlag(match, "p1", 0); // correct flag, +20
  assert.equal(reveal.scoreDelta, SCORE.SAFE_TILE);
  assert.equal(flag.scoreDelta, 20);
  assert.equal(match.p1Score, 25);
  assert.equal(match.p1SafeRevealed, 1);
  assert.equal(match.p1CorrectFlagCount, 1);
});

test("two actions on the SAME tile: the second is rejected and never double-applies", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard();
  match.p2Board = fixedBoard();
  beginMatch(match);

  const first = applyReveal(match, "p1", SAFE_A);
  const dupReveal = applyReveal(match, "p1", SAFE_A);
  const dupFlag = applyFlag(match, "p1", SAFE_A);
  assert.equal(first.scoreDelta, SCORE.SAFE_TILE);
  assert.equal(dupReveal.status, 409);
  assert.equal(dupFlag.status, 409);
  assert.equal(match.p1Score, SCORE.SAFE_TILE);
  assert.equal(match.p1SafeRevealed, 1);
});

test("an action arriving exactly at timer expiry is refused (server decides)", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard();
  match.p2Board = fixedBoard();
  beginMatch(match);
  applyReveal(match, "p1", SAFE_A); // +5 before the buzzer
  match.matchDeadline = new Date(Date.now() - 1); // expired

  const late = applyReveal(match, "p1", SAFE_B);
  assert.equal(late.status, 400);
  assert.equal(late.error, "Match timer has expired");
  assert.equal(match.p1Score, SCORE.SAFE_TILE, "no late score change");
  assert.equal(match.p1SafeRevealed, 1, "no late board change");
});

test("an action arriving after the seat's board completes is rejected", () => {
  const match = makeMatch();
  const board = fixedBoard();
  match.p1Board = board;
  match.p2Board = board;
  beginMatch(match);
  clearBoard(match, "p1");
  assert.equal(match.p1Locked, true);

  const after = applyReveal(match, "p1", 99);
  assert.equal(after.status, 400);
  assert.equal(after.error, "Your board is already locked");
});

test("a duplicate (replayed) socket event is idempotent — the action never processes twice", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({ "0": 30 });
  match.p2Board = fixedBoard();
  beginMatch(match);

  const first = applyFlag(match, "p1", 0);
  const replay = applyFlag(match, "p1", 0); // same event delivered twice
  assert.equal(first.scoreDelta, 30);
  assert.equal(replay.status, 409);
  assert.equal(match.p1Score, 30, "the mine value is credited exactly once");
  assert.equal(match.p1CorrectFlagCount, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Score events on every score-changing action
// ═══════════════════════════════════════════════════════════════════════

test("every score-changing action yields a server-minted delta + reason", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard({ "0": 50, "1": 10 });
  match.p2Board = fixedBoard();
  beginMatch(match);

  const safe = applyReveal(match, "p2", SAFE_A);
  assert.equal(safe.scoreDelta, SCORE.SAFE_TILE);
  assert.equal(safe.scoreReason, "safe");

  const good = applyFlag(match, "p1", 0);
  assert.equal(good.scoreDelta, 50);
  assert.equal(good.scoreReason, "correct_flag");

  const bad = applyFlag(match, "p1", SAFE_B);
  assert.equal(bad.scoreDelta, SCORE.WRONG_FLAG);
  assert.equal(bad.scoreReason, "wrong_flag");

  // p1 now holds 40, so the −25 mine hit is not clamped and the delta is exact.
  assert.equal(match.p1Score, 40);
  const boom = applyReveal(match, "p1", 1);
  assert.equal(boom.scoreDelta, SCORE.MINE_HIT);
  assert.equal(boom.scoreReason, "mine_hit");
});

test("clearing a board emits the +100 completion delta and locks that seat only", () => {
  const match = makeMatch();
  const board = fixedBoard();
  match.p1Board = board;
  match.p2Board = board;
  beginMatch(match);
  // Reveal every safe tile and confirm all but one mine; the last flag
  // resolves the final cell and completes the board.
  const safe = Array.from({ length: GRID_CELLS }, (_, i) => i).filter(
    (i) => !board.mines.includes(i),
  );
  for (const c of safe) applyReveal(match, "p1", c);
  for (const m of board.mines.slice(0, -1)) applyFlag(match, "p1", m);
  const completing = applyFlag(match, "p1", board.mines[board.mines.length - 1]);
  assert.equal(completing.scoreReason, "complete");
  assert.equal(match.p1Completed, true);
  assert.equal(match.p1Locked, true);
  assert.equal(match.p2Locked, false, "the opponent is never locked by a completion");
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Disconnect / reconnect mirror
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mirror of `forfeitMatchOnDisconnect` (store). Returns the same shape so the
 * reconnect scenarios can assert a blip never awards a win or mutates state.
 */
function forfeitOnDisconnect(match, userId) {
  if (match.player1Id !== userId && match.player2Id !== userId) {
    return { error: "Forbidden", status: 403 };
  }
  if (TERMINAL_STATES.has(match.status)) return { ignored: true };
  if (match.status === MATCH_STATUS.WAITING || !match.player2Id) {
    return { cancelled: true };
  }
  const s = seatOf(match, userId);
  if (isLocked(match, s)) return { ignored: true };
  return { forfeited: true, winnerId: match.player1Id === userId ? match.player2Id : match.player1Id };
}

test("reconnect during NORMAL play: a blip never awards a win or changes score/board", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard();
  match.p2Board = fixedBoard();
  beginMatch(match);
  applyReveal(match, "p1", SAFE_A);
  applyReveal(match, "p2", 12);

  const before = JSON.stringify({ p1: match.p1Score, p2: match.p2Score, r1: match.p1Revealed, r2: match.p2Revealed });
  // The blip resolves (socket rejoins) — no forfeit is ever run for a
  // reconnect inside the grace window, and even a late forfeit is what we
  // assert against: the board/score snapshot is untouched by a reconnect.
  const view = normaliseMatchForViewer(match, "p1");
  assert.equal(match.status, MATCH_STATUS.ACTIVE, "still live");
  assert.equal(match.winnerId, null, "no win awarded");
  assert.equal(JSON.stringify({ p1: match.p1Score, p2: match.p2Score, r1: match.p1Revealed, r2: match.p2Revealed }), before);

  // The reconnected p1 sees its OWN board state …
  assert.deepEqual(view.myRevealed.map((r) => r.cell), [SAFE_A]);
  assert.equal(view.myScore, SCORE.SAFE_TILE);
  // … and the opponent only as public progress.
  assert.equal(view.opponentScore, SCORE.SAFE_TILE);
  assert.equal(view.opponentBoard, null);
  assert.ok(view.matchDeadline, "the reconnect gets the authoritative deadline");
  assert.equal(view.matchTimerSeconds, MATCH_TIMER_SECONDS);
});

test("reconnect AFTER completing the board: the finisher is not forfeited and keeps its result", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard();
  match.p2Board = fixedBoard();
  beginMatch(match);
  clearBoard(match, "p1");
  const p1Score = match.p1Score;

  // Store: a player whose board is already locked is IGNORED on a disconnect.
  assert.deepEqual(forfeitOnDisconnect(match, "p1"), { ignored: true });
  assert.equal(match.status, MATCH_STATUS.ACTIVE, "the match keeps running for the opponent");
  assert.equal(match.p1Score, p1Score, "the finisher's score is preserved");

  const view = normaliseMatchForViewer(match, "p1");
  assert.equal(view.myCompleted, true);
  assert.equal(view.myLocked, true);
  assert.equal(view.myScore, p1Score);
  assert.equal(view.opponentCompleted, false);
});

test("reconnect NEAR timer expiry: the clock is server-authoritative and a blip does not resolve it", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard();
  match.p2Board = fixedBoard();
  beginMatch(match, 5); // 5s left
  applyReveal(match, "p1", SAFE_A);
  applyReveal(match, "p2", 12);
  applyReveal(match, "p2", 13); // p2 ahead

  const view = normaliseMatchForViewer(match, "p2");
  assert.equal(view.status, MATCH_STATUS.ACTIVE);
  assert.ok(view.matchDeadline, "the reconnect gets the authoritative deadline");
  assert.ok(new Date(view.matchDeadline).getTime() - Date.now() <= 5000);

  // A reconnect must not itself resolve the match; only the server clock does.
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
  assert.equal(match.winnerId, null);

  // When the server clock elapses, the deterministic ladder settles it.
  match.matchDeadline = new Date(Date.now() - 1);
  maybeResolve(match);
  assert.equal(match.status, MATCH_STATUS.FINISHED);
  assert.equal(match.winnerId, "p2", "p2's two safe reveals beat p1's one");
  assert.equal(match.winReason, WIN_REASON.SCORE);
});

test("reconnect AFTER match completion: the forfeit is ignored and the replay boards are visible", () => {
  const match = makeMatch();
  const board = fixedBoard();
  match.p1Board = board;
  match.p2Board = board;
  beginMatch(match);
  applyReveal(match, "p1", SAFE_A);
  match.matchDeadline = new Date(Date.now() - 1);
  maybeResolve(match);
  assert.equal(match.status, MATCH_STATUS.FINISHED);

  // Idempotent: a terminal match is never re-forfeited / re-scored.
  assert.deepEqual(forfeitOnDisconnect(match, "p1"), { ignored: true });
  assert.equal(match.status, MATCH_STATUS.FINISHED);

  const view = normaliseMatchForViewer(match, "p1");
  assert.ok(view.board, "the replay reveals the viewer's board once finished");
  assert.ok(view.opponentBoard, "and the opponent's board for replay");
});

test("forfeit: only a genuinely absent socket past the grace window can decide a match", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard();
  match.p2Board = fixedBoard();
  beginMatch(match);

  // No board locked and the match is live → the disconnect forfeit is the ONLY
  // path that awards a win, and it never touches scoring columns.
  const p1Before = match.p1Score;
  const p2Before = match.p2Score;
  const result = forfeitOnDisconnect(match, "p1");
  assert.equal(result.forfeited, true);
  assert.equal(result.winnerId, "p2");
  assert.equal(match.p1Score, p1Before, "the forfeit does not modify a score");
  assert.equal(match.p2Score, p2Before);
});

test("forfeit: a waiting lobby with no opponent is cancelled, never won", () => {
  const match = makeMatch({ player2Id: null });
  const result = forfeitOnDisconnect(match, "p1");
  assert.equal(result.cancelled, true);
  assert.equal(result.forfeited, undefined);
});

test("forfeit: a non-participant is rejected (403), never able to end someone else's match", () => {
  const match = makeMatch();
  beginMatch(match);
  assert.equal(forfeitOnDisconnect(match, "intruder").status, 403);
  assert.equal(match.status, MATCH_STATUS.ACTIVE);
});

// ═══════════════════════════════════════════════════════════════════════
// 8. No hidden-mine leak over the wire
// ═══════════════════════════════════════════════════════════════════════

test("broadcast envelopes never carry board, mine positions or mine values", () => {
  const sent = [];
  const io = {
    to(room) {
      return {
        emit(event, payload) {
          sent.push({ room, event, payload });
        },
      };
    },
  };
  withIo(io, () => {
    broadcastMatchUpdate(3, {
      status: "active",
      matchDeadline: new Date().toISOString(),
      p1Score: 15,
      p2Score: 5,
      justResolved: false,
    });
    broadcastScoreEvent(3, { seat: "player1", delta: 5, reason: "safe" });
  });
  // Inspect the payloads only — the room id / event name legitimately contain
  // the game name (`mines-pvp`), so a naive substring check would false-positive.
  const payloadWire = JSON.stringify(sent.map((s) => s.payload));
  for (const forbidden of [
    "p1Board",
    "p2Board",
    "mineValue",
    '"mines"',
    '"revealed"',
    '"flags"',
    "cellValues",
  ]) {
    assert.equal(
      payloadWire.includes(forbidden),
      false,
      `broadcast payload must not carry ${forbidden}`,
    );
  }
});

test("the live viewer payload exposes only public opponent progress", () => {
  const match = makeMatch();
  match.p1Board = fixedBoard();
  match.p2Board = fixedBoard();
  beginMatch(match);
  applyReveal(match, "p1", SAFE_A);
  applyFlag(match, "p2", 0); // p2 confirms one of its own mines

  const asP1 = normaliseMatchForViewer(match, "p1");
  const wire = JSON.stringify(asP1);
  assert.equal(wire.includes('"p2Board"'), false);
  assert.equal(wire.includes('"p1Board"'), false);
  assert.equal(asP1.board, null);
  assert.equal(asP1.opponentBoard, null);

  // Public progress IS exposed.
  assert.equal(asP1.opponentScore, 10); // p2 flagged a fallback-value mine
  assert.equal(typeof asP1.opponentSafeRevealed, "number");
  assert.equal(typeof asP1.opponentCorrectFlags, "number");
  assert.equal(asP1.opponentCompleted, false);
});

// ═══════════════════════════════════════════════════════════════════════
// 9. Server-authoritative timer / source contract
// ═══════════════════════════════════════════════════════════════════════

test("the store opens ONE server deadline and rejects late actions with the timer error", () => {
  // ONE shared start instant: `startedAt` and the 180s `matchDeadline` are
  // derived from the same `now` when the match goes active.
  assert.match(STORE, /const now = Date\.now\(\)/);
  assert.match(STORE, /const deadline = new Date\(now \+ timerSeconds \* 1000\)/);
  assert.match(STORE, /startedAt,/);
  assert.match(STORE, /matchDeadline: deadline/);
  assert.match(STORE, /isMatchExpired\(match\)/);
  assert.match(STORE, /Match timer has expired/);
  // No client-supplied clock anywhere.
  assert.doesNotMatch(STORE, /body\.(elapsed|timeLeft|remainingMs|deadline)/);
});

test("the store snapshots both seats' boards at resolve so the replay has both", () => {
  assert.match(STORE, /p2BoardSnapshot/);
});
