/**
 * PvP Slots ("Fruit Fortune Survival") — round-engine unit tests.
 *
 * Pure-function tests for the shared constants + deterministic helpers
 * in `src/lib/slots-pvp/constants.js` and `src/lib/slots-pvp/engine.js`.
 * The lazy column stream, the grace → survival state machine, the combo
 * checks (3 horizontal rows + 2 diagonals — verticals never count) and
 * the round/match decision rules are the contract every other piece of
 * the match system depends on, so they're tested exhaustively (valid +
 * invalid inputs, boundaries, determinism).
 *
 * The flow-level tests that drive these same functions through a full
 * match (single survival round, per-column deadlines, auto-stop, delayed
 * reveal, settlement) live in `tests/slots-pvp-flow.test.mjs`.
 *
 * Run:  node --test tests/slots-pvp-engine.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ROUNDS,
  MIN_STAKE,
  MAX_STAKE,
  MATCH_STATUS,
  ACTIVE_STATES,
  SPIN_STATES,
  TERMINAL_STATES,
  ROUNDS_TO_WIN,
  ROUND_TIMER_SECONDS,
  COLUMN_TIMER_SECONDS,
  COLUMN_DEADLINE_MS,
  COLUMN_STOP_GRACE_MS,
  MAX_JETTISONS_PER_RUN,
  READY_WINDOW_MS,
  BETWEEN_ROUNDS_MS,
  FINISHED_GRACE_MS,
  HOUSE_FEE_PCT,
  WINNER_RATIO,
  HOUSE_RATIO,
  GRACE_DRAW_REFUND_PCT,
  GRACE_DRAW_RAKE_PCT,
  SLOTS_PVP_LOCK_NAMESPACE,
  STAKE_PRESETS,
  RESULT,
  SLIDING_SYMBOL_COUNT,
  GRACE_MAX_STOPS,
  MAX_COLUMNS_PER_ROUND,
  computePayout,
  statusForSpinNumber,
  spinNumberForStatus,
  isSpinStatus,
  round2,
  pickPositiveInt,
} from "../src/lib/slots-pvp/constants.js";

import {
  GRID_COLS,
  GRID_ROWS,
  HORIZ_DIAG_LINES,
  hasLine,
  winningLinesIn,
  cyrb53,
  mulberry32,
  columnSymbols,
  spinSeed,
  openSpinState,
  applyColumnStop,
  autoStopActiveColumn,
  jettisonActiveColumn,
  canResolveRound,
  decideRoundWinner,
  decideMatchResult,
  buildRoundResult,
  planAdvanceAfterResolve,
  viewerRunSnapshot,
} from "../src/lib/slots-pvp/engine.js";

const FRUIT_SYMBOLS = ["🍉","🍌","🍍","🍏","🍓","🥭","🍈","🍇","🍒","🍎","🍊","🍋","🥝","🍐","🍑","🥥","🍅","🍆","🌽","🍠"];
// The 5-symbol sub-pool the sliding game actually draws from.
const POOL = FRUIT_SYMBOLS.slice(0, SLIDING_SYMBOL_COUNT);

// ════════════════════════════════════════════════════════════════════
// Round structure constants
// ════════════════════════════════════════════════════════════════════

test("each column has a 15-second countdown plus a 2.5s stop-grace window (COLUMN_TIMER_SECONDS / COLUMN_STOP_GRACE_MS)", () => {
  assert.equal(ROUND_TIMER_SECONDS, 15);
  assert.equal(COLUMN_TIMER_SECONDS, 15);
  assert.equal(COLUMN_DEADLINE_MS, 15 * 1000);
  assert.equal(COLUMN_STOP_GRACE_MS, 2500);
  assert.equal(MAX_JETTISONS_PER_RUN, 1);
});

test("a match is a SINGLE survival round (MAX_ROUNDS = ROUNDS_TO_WIN = 1)", () => {
  assert.equal(MAX_ROUNDS, 1);
  assert.equal(ROUNDS_TO_WIN, 1);
  assert.equal(SPIN_STATES.size, 5); // enum parity — only spin_1 is reachable
});

test("the sliding game uses a 5-symbol sub-pool + a 10-stop grace cap + a 60-column cap", () => {
  assert.equal(SLIDING_SYMBOL_COUNT, 5);
  assert.equal(GRACE_MAX_STOPS, 10);
  assert.equal(MAX_COLUMNS_PER_ROUND, 60);
});

test("status enum still matches the slots_pvp_status pgEnum (migration 0059)", () => {
  assert.deepEqual(Object.values(MATCH_STATUS), [
    "waiting",
    "ready",
    "spin_1",
    "spin_2",
    "spin_3",
    "spin_4",
    "spin_5",
    "finished",
    "cancelled",
  ]);
});

test("state sets partition the status machine correctly", () => {
  assert.equal(ACTIVE_STATES.size, 6); // ready + 5 spins (enum parity)
  assert.equal(SPIN_STATES.size, 5); // enum parity; only spin_1 is reachable
  assert.equal(TERMINAL_STATES.size, 2);
  for (const s of SPIN_STATES) assert.ok(ACTIVE_STATES.has(s));
  for (const s of TERMINAL_STATES) assert.ok(!ACTIVE_STATES.has(s));
});

test("statusForSpinNumber maps 1 → spin_1 and clamps everything else (single round)", () => {
  assert.equal(statusForSpinNumber(1), MATCH_STATUS.SPIN_1);
  assert.equal(statusForSpinNumber(0), MATCH_STATUS.SPIN_1); // clamps low
  assert.equal(statusForSpinNumber(99), MATCH_STATUS.SPIN_1); // clamps high
  assert.equal(statusForSpinNumber(undefined), MATCH_STATUS.SPIN_1);
});

test("spinNumberForStatus round-trips spin_1 and rejects every other state", () => {
  assert.equal(spinNumberForStatus(MATCH_STATUS.SPIN_1), 1);
  assert.equal(spinNumberForStatus(MATCH_STATUS.SPIN_2), null); // beyond MAX_ROUNDS
  assert.equal(spinNumberForStatus(MATCH_STATUS.READY), null);
  assert.equal(spinNumberForStatus(MATCH_STATUS.FINISHED), null);
  assert.equal(isSpinStatus(MATCH_STATUS.SPIN_1), true);
  assert.equal(isSpinStatus(MATCH_STATUS.SPIN_2), false);
  assert.equal(isSpinStatus(MATCH_STATUS.CANCELLED), false);
});

test("stake + house-fee constants match the mines-pvp 90/10 split (+ grace-draw rake)", () => {
  assert.equal(MIN_STAKE, 1);
  assert.equal(MAX_STAKE, 1000000);
  assert.ok(STAKE_PRESETS.length > 0);
  assert.equal(HOUSE_FEE_PCT, 0.1);
  assert.equal(WINNER_RATIO, 0.9);
  assert.equal(HOUSE_RATIO, 0.1);
  assert.equal(GRACE_DRAW_REFUND_PCT, 0.95);
  assert.equal(GRACE_DRAW_RAKE_PCT, 0.05);
  assert.equal(typeof SLOTS_PVP_LOCK_NAMESPACE, "number");
  assert.ok(SLOTS_PVP_LOCK_NAMESPACE > 0);
  assert.deepEqual(Object.values(RESULT), ["player1", "player2", "draw", "grace_draw"]);
});

// ════════════════════════════════════════════════════════════════════
// Board geometry + the 5 combo lines
// ════════════════════════════════════════════════════════════════════

test("board is 3x3 with exactly 5 combo lines (3 rows + 2 diagonals, NO verticals)", () => {
  assert.equal(GRID_COLS, 3);
  assert.equal(GRID_ROWS, 3);
  assert.equal(HORIZ_DIAG_LINES.length, 5);
  assert.deepEqual(
    HORIZ_DIAG_LINES.map((l) => l.name).sort(),
    ["bottom-row", "diag-down", "diag-up", "middle-row", "top-row"],
  );
  for (const line of HORIZ_DIAG_LINES) {
    assert.equal(line.cells.length, 3);
    for (const [col, row] of line.cells) {
      assert.ok(col >= 0 && col < 3);
      assert.ok(row >= 0 && row < 3);
    }
  }
});

test("hasLine detects horizontal rows (window is [col][row])", () => {
  const A = "🍉", B = "🍌", C = "🍍";
  // Top row A-A-A.
  assert.equal(hasLine([[A, B, C], [A, C, B], [A, B, C]]), true);
  // Middle row B-B-B.
  assert.equal(hasLine([[C, B, A], [A, B, C], [B, B, A]]), true);
  // Bottom row C-C-C.
  assert.equal(hasLine([[A, B, C], [B, A, C], [C, B, C]]), true);
});

test("hasLine detects both diagonals", () => {
  const A = "🍉", B = "🍌", C = "🍍";
  // Diag-down: [0][0] = [1][1] = [2][2] = A.
  assert.equal(hasLine([[A, B, C], [B, A, C], [C, B, A]]), true);
  // Diag-up: [2][0] = [1][1] = [0][2] = A.
  assert.equal(hasLine([[C, B, A], [B, A, C], [A, B, C]]), true);
});

test("hasLine: vertical columns do NOT count; mixed boards have no line", () => {
  const A = "🍉", B = "🍌", C = "🍍";
  // Three uniform-but-different columns = 3 verticals, ZERO combos.
  assert.equal(hasLine([[A, A, A], [B, B, B], [C, C, C]]), false);
  // Fully mixed board.
  assert.equal(hasLine([[A, B, C], [B, C, A], [A, C, B]]), false);
  // Degenerate inputs.
  assert.equal(hasLine(null), false);
  assert.equal(hasLine([]), false);
  assert.equal(hasLine([[A, B], [B, A], [A, B]]), false);
});

test("winningLinesIn reports every combo line with its symbol", () => {
  const A = "🍉", B = "🍌", C = "🍍";
  const win = winningLinesIn([[A, B, C], [A, C, B], [A, B, C]]); // top row only
  assert.equal(win.length, 1);
  assert.equal(win[0].name, "top-row");
  assert.equal(win[0].symbol, A);
  // A full 3x3 of one symbol → all 5 lines.
  const all = winningLinesIn([[A, A, A], [A, A, A], [A, A, A]]);
  assert.equal(all.length, 5);
  // No lines → empty.
  assert.deepEqual(winningLinesIn([[A, B, C], [B, C, A], [A, C, B]]), []);
});

// ════════════════════════════════════════════════════════════════════
// Determinism + the lazy column stream
// ════════════════════════════════════════════════════════════════════

test("columnSymbols is deterministic and draws only from the 5-symbol sub-pool", () => {
  const a = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const b = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  assert.deepEqual(a, b);
  assert.equal(a.length, GRID_ROWS);
  for (const sym of a) assert.ok(POOL.includes(sym));
  // Symbols beyond the sub-pool are never used.
  assert.ok(!FRUIT_SYMBOLS.slice(SLIDING_SYMBOL_COUNT).some((s) => a.includes(s)));
});

test("different columns / seats / spins produce different columns (virtually always)", () => {
  const base = { matchId: 7, spinNumber: 1, symbols: FRUIT_SYMBOLS };
  assert.notDeepEqual(
    columnSymbols({ ...base, seat: "player1", colIndex: 1 }),
    columnSymbols({ ...base, seat: "player1", colIndex: 2 }),
  );
  assert.notDeepEqual(
    columnSymbols({ ...base, seat: "player1", colIndex: 3 }),
    columnSymbols({ ...base, seat: "player2", colIndex: 3 }),
  );
});

test("columnSymbols with an empty symbol pool degrades gracefully", () => {
  assert.deepEqual(
    columnSymbols({ matchId: 1, spinNumber: 1, seat: "player1", colIndex: 0, symbols: [] }),
    ["?", "?", "?"],
  );
});

test("seeded hashing is stable across runs", () => {
  assert.equal(cyrb53("slots:1:p1:spin1", 0), cyrb53("slots:1:p1:spin1", 0));
  assert.notEqual(spinSeed(1, 1, "player1"), spinSeed(1, 1, "player2"));
  assert.notEqual(spinSeed(1, 1, "player1"), spinSeed(1, 2, "player1"));
  assert.equal(spinSeed(1, 1, "player1"), spinSeed(1, 1, "player1"));
  assert.equal(mulberry32(123)(), mulberry32(123)());
});

// ════════════════════════════════════════════════════════════════════
// Grace → survival state machine (pure transitions)
// ════════════════════════════════════════════════════════════════════

// ── helpers ──────────────────────────────────────────────────────────

/** Reproduce the engine's visible window from the exported stream:
 *  initial columns land in their own slots (any order), sliding columns
 *  push the window left. */
function windowFromStops(seat, colIndices, { matchId = 7, spinNumber = 1, symbols = FRUIT_SYMBOLS } = {}) {
  let window = [null, null, null];
  for (const idx of colIndices) {
    const col = columnSymbols({ matchId, spinNumber, seat, colIndex: idx, symbols });
    if (idx < GRID_COLS) window[idx] = col;
    else window = [window[1], window[2], col];
  }
  return window;
}

function makeSpinMatch({ now = Date.now(), overrides = {} } = {}) {
  const open = openSpinState({ matchId: 7, spinNumber: 1, symbols: FRUIT_SYMBOLS, now });
  return {
    id: 7,
    player1Id: "u1",
    player2Id: "u2",
    stakeAmount: "100.00",
    theme: "fruit",
    status: MATCH_STATUS.SPIN_1,
    currentSpin: 1,
    ...open,
    ...overrides,
  };
}

/** Build a plausible run state that is already mid-grace / mid-survival.
 *  `priorWindow` is the 3-column window BEFORE the next stop lands; the
 *  next landed column slides it to [prior[1], prior[2], col]. */
function craftedRun({
  priorWindow,
  stoppedCount,
  firstComboAt = null,
  survived = 0,
  linesFormed = 0,
  activeDeadline = null,
  now = Date.now(),
  seat = "player1",
}) {
  const base = openSpinState({ matchId: 7, spinNumber: 1, symbols: FRUIT_SYMBOLS, now })[
    seat === "player2" ? "p2CurrentInputs" : "p1CurrentInputs"
  ];
  return {
    ...base,
    window: priorWindow,
    columns: priorWindow.filter(Boolean),
    stoppedOrder: Array.from({ length: stoppedCount }, (_, i) => i),
    stoppedCount,
    firstComboAt,
    survived,
    linesFormed,
    activeIndex: stoppedCount,
    activeDeadline: activeDeadline ?? now + COLUMN_DEADLINE_MS,
  };
}

/** A fully-ended run (for buildRoundResult payload tests). */
function endedRun({ stoppedCount, firstComboAt = null, survived = 0, linesFormed = 0, busted = false, graceFailed = false, bustColumn = null, window }) {
  const base = craftedRun({ priorWindow: window, stoppedCount, firstComboAt, survived, linesFormed });
  return { ...base, ended: true, busted, graceFailed, bustColumn, activeIndex: null, activeDeadline: null };
}

const fillCol = (s) => [s, s, s];

/** Two pool symbols NOT present in `col` (pool=5, col=3 cells → always 2 left). */
function twoOutside(col) {
  const rest = POOL.filter((s) => !col.includes(s));
  return [rest[0], rest[1]];
}

// ── open / validation ────────────────────────────────────────────────

test("openSpinState opens BOTH players' hidden runs with fresh windows + 15s column deadlines", () => {
  const now = 1_000_000;
  const m = makeSpinMatch({ now });
  const p1 = m.p1CurrentInputs;
  const p2 = m.p2CurrentInputs;
  assert.deepEqual(p1.window, [null, null, null]);
  assert.deepEqual(p1.columns, []);
  assert.equal(p1.stoppedCount, 0);
  assert.equal(p1.firstComboAt, null);
  assert.equal(p1.survived, 0);
  assert.equal(p1.linesFormed, 0);
  assert.equal(p1.ended, false);
  assert.equal(p1.activeIndex, 0);
  assert.equal(p1.jettisonsUsed, 0);
  assert.equal(p1.activeDeadline, now + COLUMN_DEADLINE_MS);
  assert.equal(p1.openedAt, now);
  assert.notEqual(p1.seed, p2.seed);
});

test("applyColumnStop validates participant / status / spin identity / run / index / deadline", () => {
  const m = makeSpinMatch();
  assert.deepEqual(applyColumnStop(m, "spectator", 0), {
    ok: false,
    error: "Caller is not a participant",
    status: 403,
  });
  const ready = { ...m, status: MATCH_STATUS.READY };
  assert.deepEqual(applyColumnStop(ready, "player1", 0), {
    ok: false,
    error: "Match is not in a spin round",
    status: 400,
  });
  // Stale round echo.
  assert.deepEqual(applyColumnStop(m, "player1", 0, Date.now(), 2), {
    ok: false,
    error: "Round has already advanced",
    status: 409,
  });
  // Round never opened.
  assert.deepEqual(applyColumnStop({ ...m, p1CurrentInputs: null }, "player1", 0), {
    ok: false,
    error: "Round has not started",
    status: 400,
  });
  // Invalid indices.
  assert.equal(applyColumnStop(m, "player1", -1).ok, false);
  assert.equal(applyColumnStop(m, "player1", "x").ok, false);
  assert.equal(applyColumnStop(m, "player1", 3).ok, false); // initial phase: only 0..2
  // Expired active column — only past the deadline AND the stop-grace
  // window (a click landing just after the deadline is a lag cushion).
  const expired = {
    ...m,
    p1CurrentInputs: {
      ...m.p1CurrentInputs,
      activeDeadline: Date.now() - COLUMN_STOP_GRACE_MS - 1,
    },
  };
  assert.deepEqual(applyColumnStop(expired, "player1", 0), {
    ok: false,
    error: "Column time has expired",
    status: 400,
  });
  // Within the grace window a manual stop is still honoured.
  const inGrace = {
    ...m,
    p1CurrentInputs: {
      ...m.p1CurrentInputs,
      activeDeadline: Date.now() - COLUMN_STOP_GRACE_MS + 1000,
    },
  };
  assert.equal(applyColumnStop(inGrace, "player1", 0).ok, true);
});

test("initial columns stop in any order, once each, then the window is full", () => {
  const now = Date.now();
  let m = makeSpinMatch({ now });
  m = applyColumnStop(m, "player1", 2, now).match;
  m = applyColumnStop(m, "player1", 0, now).match;
  m = applyColumnStop(m, "player1", 1, now).match;
  const run = m.p1CurrentInputs;
  assert.deepEqual(run.stoppedOrder, [2, 0, 1]);
  assert.equal(run.stoppedCount, 3);
  assert.deepEqual(run.window, windowFromStops("player1", [2, 0, 1]));
  assert.equal(run.activeIndex, 3);
  // Once the window is full, only the active sliding column is stoppable
  // — a stale stop of a filled initial column is rejected.
  assert.deepEqual(applyColumnStop(m, "player1", 2), {
    ok: false,
    error: "Only the active column can be stopped",
    status: 409,
  });
});

// ── grace / survival rules ───────────────────────────────────────────

test("grace: stops before the first combo are SAFE — no bust possible, and the first combo starts survival at 0", () => {
  const now = Date.now();
  let m = makeSpinMatch({ now });
  // Land the 3 initial columns.
  for (const idx of [0, 1, 2]) {
    m = applyColumnStop(m, "player1", idx, now).match;
  }
  let run = m.p1CurrentInputs;
  if (hasLine(run.window)) {
    assert.equal(run.firstComboAt, 3);
    assert.equal(run.survived, 0);
    assert.equal(run.ended, false);
  } else {
    assert.equal(run.firstComboAt, null);
    assert.equal(run.ended, false); // non-combo window during grace is SAFE
  }
  // Keep stopping the sliding column until the first combo appears (or
  // the 10-stop grace cap fires).
  let guard = 0;
  while (run.firstComboAt === null && !run.ended && guard < GRACE_MAX_STOPS) {
    m = applyColumnStop(m, "player1", run.activeIndex, now).match;
    run = m.p1CurrentInputs;
    guard += 1;
  }
  if (run.ended) {
    // Only the grace cap can end a grace-phase run — and never with points.
    assert.equal(run.graceFailed, true);
    assert.equal(run.firstComboAt, null);
    assert.equal(run.survived, 0);
  } else {
    assert.ok(run.firstComboAt !== null && run.firstComboAt <= GRACE_MAX_STOPS);
    assert.equal(run.survived, 0); // count starts at the FIRST combo
    assert.equal(run.ended, false);
  }
});

test("the first combo (crafted) ends grace: firstComboAt set, survival count still 0", () => {
  const now = Date.now();
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X, Y] = twoOutside(col3);
  // Prior full window: landing col3 slides it to [p1, p2, col3] whose top
  // row is col3[0]-col3[0]-col3[0] — EXACTLY one combo line.
  const prior = [fillCol("🍉"), [col3[0], Y, Y], [col3[0], X, X]];
  const run0 = craftedRun({ priorWindow: prior, stoppedCount: 3, now });
  const m0 = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };
  const r = applyColumnStop(m0, "player1", 3, now);
  assert.equal(r.ok, true);
  const run = r.match.p1CurrentInputs;
  assert.equal(run.firstComboAt, 4); // the 4th landed column made the combo
  assert.equal(run.survived, 0);
  assert.equal(run.linesFormed, 1);
  assert.equal(run.ended, false);
  assert.equal(run.activeIndex, 4);
  assert.deepEqual(run.window, [[col3[0], Y, Y], [col3[0], X, X], col3]);
});

test("grace stops are SAFE: a non-combo stop before the cap never busts (crafted)", () => {
  const now = Date.now();
  const col5 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 5, symbols: FRUIT_SYMBOLS });
  const [X] = twoOutside(col5);
  const prior = [fillCol("🍉"), fillCol(X), fillCol(X)];
  const run0 = craftedRun({ priorWindow: prior, stoppedCount: 5, now });
  const m0 = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };
  const r = applyColumnStop(m0, "player1", 5, now);
  assert.equal(r.ok, true);
  const run = r.match.p1CurrentInputs;
  assert.equal(run.firstComboAt, null);
  assert.equal(run.graceFailed, false);
  assert.equal(run.ended, false);
  assert.equal(run.activeIndex, 6);
});

test("grace cap: burning all 10 stops without a combo = graceFailed (crafted)", () => {
  const now = Date.now();
  const col9 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 9, symbols: FRUIT_SYMBOLS });
  const [X] = twoOutside(col9);
  const prior = [fillCol("🍉"), fillCol(X), fillCol(X)];
  const run0 = craftedRun({ priorWindow: prior, stoppedCount: 9, now });
  const m0 = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };
  const r = applyColumnStop(m0, "player1", 9, now);
  assert.equal(r.ok, true);
  const run = r.match.p1CurrentInputs;
  assert.equal(run.stoppedCount, 10);
  assert.equal(run.firstComboAt, null);
  assert.equal(run.graceFailed, true);
  assert.equal(run.ended, true);
  assert.equal(run.survived, 0);
  assert.equal(run.activeIndex, null);
});

test("survival: a combo stop ticks survived +1 and keeps the run alive (crafted)", () => {
  const now = Date.now();
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X, Y] = twoOutside(col3);
  const prior = [fillCol("🍉"), [col3[0], Y, Y], [col3[0], X, X]];
  const run0 = craftedRun({ priorWindow: prior, stoppedCount: 3, firstComboAt: 3, linesFormed: 1, now });
  const m0 = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };
  const r = applyColumnStop(m0, "player1", 3, now);
  assert.equal(r.ok, true);
  const run = r.match.p1CurrentInputs;
  assert.equal(run.firstComboAt, 3);
  assert.equal(run.survived, 1);
  assert.equal(run.linesFormed, 2);
  assert.equal(run.ended, false);
  assert.equal(run.activeIndex, 4);
});

test("survival: stopping a column without a combo BUSTS the run (crafted)", () => {
  const now = Date.now();
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X] = twoOutside(col3);
  const prior = [fillCol("🍉"), fillCol(X), fillCol(X)];
  const run0 = craftedRun({ priorWindow: prior, stoppedCount: 3, firstComboAt: 3, linesFormed: 1, now });
  const m0 = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };
  const r = applyColumnStop(m0, "player1", 3, now);
  assert.equal(r.ok, true);
  const run = r.match.p1CurrentInputs;
  assert.equal(run.busted, true);
  assert.equal(run.ended, true);
  assert.equal(run.bustColumn, 3);
  assert.equal(run.survived, 0);
  assert.equal(run.activeIndex, null);
  assert.equal(run.activeDeadline, null);
  // A run that already ended rejects further stops.
  const again = applyColumnStop(r.match, "player1", 4);
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
});

test("sliding phase: only the active column may be stopped", () => {
  const now = Date.now();
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X, Y] = twoOutside(col3);
  const prior = [fillCol("🍉"), [col3[0], Y, Y], [col3[0], X, X]];
  const run0 = craftedRun({ priorWindow: prior, stoppedCount: 3, firstComboAt: 3, linesFormed: 1, now });
  const m0 = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };
  assert.deepEqual(applyColumnStop(m0, "player1", 5, now), {
    ok: false,
    error: "Only the active column can be stopped",
    status: 409,
  });
  assert.equal(applyColumnStop(m0, "player1", 99, now).ok, false);
});

// ── jettison (the skill mechanic) ────────────────────────────────────

test("jettison skips the active column, advances the stream, and refreshes the deadline", () => {
  const now = Date.now();
  // Craft the prior window against col4's OWN symbols so landing col4
  // forms a guaranteed top-row combo (survival phase stays alive).
  const col4 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 4, symbols: FRUIT_SYMBOLS });
  const [X4, Y4] = twoOutside(col4);
  const prior = [fillCol("🍉"), [col4[0], Y4, Y4], [col4[0], X4, X4]];
  const run0 = craftedRun({ priorWindow: prior, stoppedCount: 3, firstComboAt: 3, linesFormed: 1, now });
  const m0 = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };

  const r = jettisonActiveColumn(m0, "player1", now);
  assert.equal(r.ok, true);
  const run = r.match.p1CurrentInputs;
  assert.equal(run.jettisonsUsed, 1);
  assert.equal(run.activeIndex, 4); // column 3 was skipped; column 4 is next
  assert.equal(run.stoppedCount, 3); // nothing landed
  assert.equal(run.activeDeadline, now + COLUMN_DEADLINE_MS); // fresh countdown
  assert.equal(run.ended, false);

  // The next stop must target the advanced active index (col 4) — the
  // skipped column 3 can never land and never enters the window.
  assert.equal(applyColumnStop(r.match, "player1", 3, now).ok, false);
  assert.equal(applyColumnStop(r.match, "player1", 5, now).ok, false);
  const s = applyColumnStop(r.match, "player1", 4, now);
  assert.equal(s.ok, true);
  assert.equal(s.match.p1CurrentInputs.stoppedCount, 4);
  assert.equal(s.match.p1CurrentInputs.activeIndex, 5);
  assert.equal(s.match.p1CurrentInputs.columns.length, 4);
  assert.equal(s.match.p1CurrentInputs.survived, 1); // the col4 stop combo'd
  assert.deepEqual(s.match.p1CurrentInputs.window, [prior[1], prior[2], col4]);
});

test("jettison is sliding-phase only: rejected during the initial 3 columns", () => {
  const now = Date.now();
  const m = makeSpinMatch({ now });
  const r = jettisonActiveColumn(m, "player1", now);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.error, "Jettison is only available once the window is full");
});

test("jettison is budget-limited to MAX_JETTISONS_PER_RUN and validates like a stop", () => {
  const now = Date.now();
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X, Y] = twoOutside(col3);
  const prior = [fillCol("🍉"), [col3[0], Y, Y], [col3[0], X, X]];
  const run0 = craftedRun({ priorWindow: prior, stoppedCount: 3, firstComboAt: 3, linesFormed: 1, now });
  let m = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };

  // First jettison succeeds; the second is rejected (budget spent).
  m = jettisonActiveColumn(m, "player1", now).match;
  const second = jettisonActiveColumn(m, "player1", now);
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(second.error, "No jettisons left");

  // Spectators / ended runs / non-spin matches / stale rounds rejected.
  assert.equal(jettisonActiveColumn(m, "spectator", now).ok, false);
  const ended = { ...m, p1CurrentInputs: { ...m.p1CurrentInputs, ended: true } };
  assert.equal(jettisonActiveColumn(ended, "player1", now).status, 409);
  const ready = { ...m, status: MATCH_STATUS.READY };
  assert.equal(jettisonActiveColumn(ready, "player1", now).ok, false);
  assert.equal(jettisonActiveColumn(m, "player1", now, 2).status, 409);
});

test("jettison past the deadline + grace window is rejected (auto-stop takes over)", () => {
  const now = Date.now();
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X, Y] = twoOutside(col3);
  const prior = [fillCol("🍉"), [col3[0], Y, Y], [col3[0], X, X]];
  const run0 = craftedRun({
    priorWindow: prior,
    stoppedCount: 3,
    firstComboAt: 3,
    linesFormed: 1,
    activeDeadline: now - COLUMN_STOP_GRACE_MS - 1,
    now,
  });
  const m0 = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };
  assert.equal(jettisonActiveColumn(m0, "player1", now).status, 400);
  // Within grace, a late jettison is still honoured.
  const inGrace = {
    ...m0,
    p1CurrentInputs: {
      ...m0.p1CurrentInputs,
      activeDeadline: now - COLUMN_STOP_GRACE_MS + 1000,
    },
  };
  assert.equal(jettisonActiveColumn(inGrace, "player1", now).ok, true);
});

test("MAX_COLUMNS_PER_ROUND caps an ultra-long run (never hangs the match)", () => {
  const now = Date.now();
  const lastIdx = MAX_COLUMNS_PER_ROUND - 1; // 59
  const col = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: lastIdx, symbols: FRUIT_SYMBOLS });
  const [X, Y] = twoOutside(col);
  const prior = [fillCol("🍉"), [col[0], Y, Y], [col[0], X, X]];
  const run0 = craftedRun({ priorWindow: prior, stoppedCount: lastIdx, firstComboAt: 3, linesFormed: 1, now });
  const m0 = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };
  const r = applyColumnStop(m0, "player1", lastIdx, now);
  assert.equal(r.ok, true);
  const run = r.match.p1CurrentInputs;
  assert.equal(run.stoppedCount, MAX_COLUMNS_PER_ROUND);
  assert.equal(run.ended, true); // capped even though it was a combo stop
  assert.equal(run.busted, false);
  assert.equal(run.graceFailed, false);
  assert.equal(run.activeIndex, null);
});

test("the engine's landed windows always match the exported columnSymbols stream (no drift)", () => {
  const now = Date.now();
  let m = makeSpinMatch({ now });
  let guard = 0;
  while (!m.p1CurrentInputs.ended && guard <= MAX_COLUMNS_PER_ROUND + 2) {
    const idx = m.p1CurrentInputs.stoppedCount;
    m = applyColumnStop(m, "player1", idx, now).match;
    const run = m.p1CurrentInputs;
    assert.deepEqual(run.window, windowFromStops("player1", run.stoppedOrder));
    assert.equal(run.stoppedCount, run.stoppedOrder.length);
    assert.equal(run.activeIndex, run.ended ? null : run.stoppedCount);
    guard += 1;
  }
  // The run MUST end (grace-fail, bust, or the 60-column cap).
  assert.equal(m.p1CurrentInputs.ended, true);
});

// ── auto-stop (AFK) ──────────────────────────────────────────────────

test("autoStopActiveColumn lands the remaining initial columns in ascending order (AFK)", () => {
  const now = Date.now();
  let m = makeSpinMatch({ now });
  m = applyColumnStop(m, "player1", 2, now).match;
  const expired = { ...m, p1CurrentInputs: { ...m.p1CurrentInputs, activeDeadline: now - 1 } };
  const out = autoStopActiveColumn(expired, "player1", now);
  const run = out.p1CurrentInputs;
  assert.deepEqual(run.stoppedOrder, [2, 0, 1]);
  assert.equal(run.stoppedCount, 3);
  assert.equal(run.anyAutoStopped, true);
  assert.deepEqual(run.window, windowFromStops("player1", [2, 0, 1]));
  // Still in grace (or already at the first combo) — NEVER ended by the initial auto-stop.
  assert.equal(run.ended, false);
  assert.equal(run.activeIndex, 3);
});

test("an AFK auto-stop in the survival phase can BUST the player", () => {
  const now = Date.now();
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X] = twoOutside(col3);
  const prior = [fillCol("🍉"), fillCol(X), fillCol(X)];
  const run0 = craftedRun({
    priorWindow: prior,
    stoppedCount: 3,
    firstComboAt: 3,
    linesFormed: 1,
    activeDeadline: now - 1,
    now,
  });
  const m0 = { ...makeSpinMatch({ now }), p1CurrentInputs: run0 };
  const out = autoStopActiveColumn(m0, "player1", now);
  const run = out.p1CurrentInputs;
  assert.equal(run.busted, true);
  assert.equal(run.ended, true);
  assert.equal(run.anyAutoStopped, true);
});

test("autoStopActiveColumn is a no-op when nothing is due or the run is ended", () => {
  const now = Date.now();
  const m = makeSpinMatch({ now });
  assert.equal(autoStopActiveColumn(m, "player1", now), m); // future deadline → untouched
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X] = twoOutside(col3);
  const prior = [fillCol("🍉"), fillCol(X), fillCol(X)];
  const run0 = craftedRun({
    priorWindow: prior,
    stoppedCount: 3,
    firstComboAt: 3,
    linesFormed: 1,
    activeDeadline: now - 1,
    now,
  });
  const mEnded = {
    ...makeSpinMatch({ now }),
    p1CurrentInputs: autoStopActiveColumn({ ...makeSpinMatch({ now }), p1CurrentInputs: run0 }, "player1", now).p1CurrentInputs,
  };
  assert.equal(mEnded.p1CurrentInputs.ended, true);
  assert.equal(autoStopActiveColumn(mEnded, "player1", now), mEnded);
});

// ── delayed reveal ───────────────────────────────────────────────────

test("canResolveRound requires BOTH runs to have ended (no early loss reveal)", () => {
  const now = Date.now();
  let m = makeSpinMatch({ now });
  // p1 busts...
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X] = twoOutside(col3);
  const run1 = craftedRun({ priorWindow: [fillCol("🍉"), fillCol(X), fillCol(X)], stoppedCount: 3, firstComboAt: 3, linesFormed: 1, now });
  m = applyColumnStop({ ...m, p1CurrentInputs: run1 }, "player1", 3, now).match;
  assert.equal(m.p1CurrentInputs.ended, true);
  assert.equal(canResolveRound(m), false); // p2 still running
  assert.equal(m.status, MATCH_STATUS.SPIN_1); // NO early reveal
  // ...p2 busts too → the round can resolve.
  const col3p2 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player2", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [Xp2] = twoOutside(col3p2);
  const run2 = craftedRun({ priorWindow: [fillCol("🍉"), fillCol(Xp2), fillCol(Xp2)], stoppedCount: 3, firstComboAt: 3, linesFormed: 1, now, seat: "player2" });
  m = applyColumnStop({ ...m, p2CurrentInputs: run2 }, "player2", 3, now).match;
  assert.equal(m.p2CurrentInputs.ended, true);
  assert.equal(canResolveRound(m), true);
});

// ════════════════════════════════════════════════════════════════════
// Round winner + match result + payout
// ════════════════════════════════════════════════════════════════════

test("decideRoundWinner: both grace-failed → GRACE_DRAW (regardless of other fields)", () => {
  assert.equal(decideRoundWinner({ graceFailed: true }, { graceFailed: true }), RESULT.GRACE_DRAW);
  assert.equal(decideRoundWinner({ graceFailed: true, survived: 5 }, { graceFailed: true, survived: 0 }), RESULT.GRACE_DRAW);
});

test("decideRoundWinner: higher survived wins; linesFormed breaks ties", () => {
  assert.equal(decideRoundWinner({ survived: 4 }, { survived: 2 }), RESULT.PLAYER1);
  assert.equal(decideRoundWinner({ survived: 1 }, { survived: 6 }), RESULT.PLAYER2);
  assert.equal(decideRoundWinner({ survived: 3, linesFormed: 2 }, { survived: 3, linesFormed: 1 }), RESULT.PLAYER1);
  assert.equal(decideRoundWinner({ survived: 3, linesFormed: 1 }, { survived: 3, linesFormed: 4 }), RESULT.PLAYER2);
  assert.equal(decideRoundWinner({ survived: 3, linesFormed: 2 }, { survived: 3, linesFormed: 2 }), RESULT.DRAW);
  assert.equal(decideRoundWinner({}, {}), RESULT.DRAW);
  // A grace-failed player (0 survived) loses to any survivor.
  assert.equal(decideRoundWinner({ graceFailed: true, survived: 0 }, { survived: 2 }), RESULT.PLAYER2);
  assert.equal(decideRoundWinner({ survived: 2 }, { graceFailed: true, survived: 0 }), RESULT.PLAYER1);
});

test("decideMatchResult: rounds-won decides; aggregate survived breaks ties", () => {
  assert.equal(decideMatchResult({ roundsWonPlayer1: 1, roundsWonPlayer2: 0, p1Score: 4, p2Score: 9 }), RESULT.PLAYER1);
  assert.equal(decideMatchResult({ roundsWonPlayer1: 0, roundsWonPlayer2: 1, p1Score: 9, p2Score: 4 }), RESULT.PLAYER2);
  assert.equal(decideMatchResult({ roundsWonPlayer1: 0, roundsWonPlayer2: 0, p1Score: 4, p2Score: 2 }), RESULT.PLAYER1);
  assert.equal(decideMatchResult({ roundsWonPlayer1: 0, roundsWonPlayer2: 0, p1Score: 2, p2Score: 4 }), RESULT.PLAYER2);
  assert.equal(decideMatchResult({}), RESULT.DRAW);
  // Forfeit tally: opponent wins outright.
  assert.equal(decideMatchResult({ roundsWonPlayer1: 0, roundsWonPlayer2: ROUNDS_TO_WIN, p1Score: 0, p2Score: 0 }), RESULT.PLAYER2);
  assert.equal(decideMatchResult({ roundsWonPlayer1: ROUNDS_TO_WIN, roundsWonPlayer2: 0, p1Score: 0, p2Score: 0 }), RESULT.PLAYER1);
});

test("computePayout: normal win → winner gets stake + 90% of loser's stake", () => {
  const payout = computePayout({ stakeAmount: 100, result: RESULT.PLAYER1 });
  assert.equal(payout.winnerNet, 190);
  assert.equal(payout.loserNet, -100);
  assert.equal(payout.houseFee, 10);
  assert.equal(payout.prizePaid, 190);
});

test("computePayout: draw refunds both, no fee", () => {
  const payout = computePayout({ stakeAmount: 100, result: RESULT.DRAW });
  assert.equal(payout.winnerNet, null);
  assert.equal(payout.loserNet, null);
  assert.equal(payout.houseFee, 0);
  assert.equal(payout.prizePaid, 0);
  assert.equal(payout.refundEach, 100);
});

test("computePayout: grace_draw → 95% refund each, house keeps 5% from each (10% total)", () => {
  const payout = computePayout({ stakeAmount: 100, result: RESULT.GRACE_DRAW });
  assert.equal(payout.refundEach, 95);
  assert.equal(payout.houseFee, 10); // 5 + 5
  assert.equal(payout.prizePaid, 0);
  assert.equal(payout.winnerNet, null);
  // Odd stakes round to 2dp.
  const odd = computePayout({ stakeAmount: 33.33, result: RESULT.GRACE_DRAW });
  assert.equal(odd.refundEach, 31.66); // 33.33 * 0.95
  assert.equal(odd.houseFee, 3.33); // 33.33 * 0.10
});

test("computePayout validates inputs", () => {
  assert.throws(() => computePayout({ stakeAmount: -1, result: RESULT.PLAYER1 }), RangeError);
  assert.throws(() => computePayout({ stakeAmount: 100, result: "bogus" }), RangeError);
});

// ════════════════════════════════════════════════════════════════════
// Round result + advance
// ════════════════════════════════════════════════════════════════════

test("buildRoundResult maps both ended runs to the history payload", () => {
  const now = Date.now();
  let m = makeSpinMatch({ now });
  // p1 busts after making (and missing) their first combo...
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X] = twoOutside(col3);
  const run1 = craftedRun({ priorWindow: [fillCol("🍉"), fillCol(X), fillCol(X)], stoppedCount: 3, firstComboAt: 3, linesFormed: 1, now });
  m = applyColumnStop({ ...m, p1CurrentInputs: run1 }, "player1", 3, now).match;
  // ...p2 grace-fails on their 10th stop.
  const col9 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player2", colIndex: 9, symbols: FRUIT_SYMBOLS });
  const [X9] = twoOutside(col9);
  const run2 = craftedRun({ priorWindow: [fillCol("🍉"), fillCol(X9), fillCol(X9)], stoppedCount: 9, now, seat: "player2" });
  m = applyColumnStop({ ...m, p2CurrentInputs: run2 }, "player2", 9, now).match;

  const row = buildRoundResult(m, FRUIT_SYMBOLS);
  assert.equal(row.matchId, 7);
  assert.equal(row.spinNumber, 1);
  // The busting stop (column 3) is recorded in the stopped order.
  assert.deepEqual(row.player1Inputs, { stoppedOrder: [0, 1, 2, 3], autoStopped: false });
  assert.equal(row.player1Result.busted, true);
  assert.equal(row.player1Result.survived, 0);
  assert.equal(row.player1Result.linesFormed, 1);
  assert.equal(row.player2Result.graceFailed, true);
  assert.equal(row.player2Result.survived, 0);
  assert.equal(row.player2Result.linesFormed, 0);
  assert.equal(row.spinPointsPlayer1, 0);
  assert.equal(row.spinPointsPlayer2, 0);
  // p1 formed a combo, p2 never did → p1 wins despite busting first.
  assert.equal(row.roundWinner, RESULT.PLAYER1);
  assert.deepEqual(row.player1Result.winningLines, winningLinesIn(m.p1CurrentInputs.window));
});

test("buildRoundResult stores survived counts as spin points + decides the winner", () => {
  const p1 = endedRun({
    stoppedCount: 8,
    firstComboAt: 4,
    survived: 3,
    linesFormed: 4,
    busted: true,
    bustColumn: 7,
    window: [fillCol("🍉"), fillCol("🍌"), fillCol("🍍")],
  });
  const p2 = endedRun({
    stoppedCount: 9,
    firstComboAt: 3,
    survived: 5,
    linesFormed: 6,
    busted: true,
    bustColumn: 8,
    window: [fillCol("🍏"), fillCol("🍓"), fillCol("🍉")],
  });
  const m = { ...makeSpinMatch(), p1CurrentInputs: p1, p2CurrentInputs: p2 };
  const row = buildRoundResult(m, FRUIT_SYMBOLS);
  assert.equal(row.spinPointsPlayer1, 3);
  assert.equal(row.spinPointsPlayer2, 5);
  assert.equal(row.roundWinner, RESULT.PLAYER2); // higher survived
  assert.equal(row.player1Result.survived, 3);
  assert.equal(row.player1Result.busted, true);
  assert.equal(row.player1Result.bustColumn, 7);
  assert.equal(row.player2Result.survived, 5);
  assert.equal(row.player2Result.ended, true);
});

test("planAdvanceAfterResolve ALWAYS finishes after the single survival round", () => {
  const now = Date.now();
  const m = makeSpinMatch({ now });
  const plan = planAdvanceAfterResolve({
    match: m,
    symbols: FRUIT_SYMBOLS,
    tallies: { roundsWonPlayer1: 1, roundsWonPlayer2: 0, p1Score: 3, p2Score: 1 },
    now,
  });
  assert.equal(plan.finished, true);
  assert.equal(plan.status, MATCH_STATUS.FINISHED);
  assert.equal(plan.endedAt.getTime(), now);
  // Even a fresh unresolved round finishes — MAX_ROUNDS = 1 never opens spin 2.
  const plan2 = planAdvanceAfterResolve({ match: m, symbols: FRUIT_SYMBOLS, now });
  assert.equal(plan2.finished, true);
  assert.equal(plan2.status, MATCH_STATUS.FINISHED);
});

test("planAdvanceAfterResolve on a non-spin match is a no-op finish", () => {
  const m = { ...makeSpinMatch(), status: MATCH_STATUS.READY, currentSpin: 1 };
  const plan = planAdvanceAfterResolve({ match: m, symbols: FRUIT_SYMBOLS, now: Date.now() });
  assert.deepEqual(plan, { finished: true });
});

// ════════════════════════════════════════════════════════════════════
// Viewer-visible run snapshot (status route)
// ════════════════════════════════════════════════════════════════════

test("viewerRunSnapshot reports grace / alive / ended statuses + own window", () => {
  const now = Date.now();
  const m = makeSpinMatch({ now });
  // Fresh run → grace, full 10s countdown.
  const fresh = viewerRunSnapshot({ inputs: m.p1CurrentInputs, now });
  assert.equal(fresh.status, "grace");
  assert.equal(fresh.ended, false);
  assert.equal(fresh.graceStopsUsed, 0);
  assert.equal(fresh.survived, 0);
  assert.equal(fresh.firstComboAt, null);
  assert.deepEqual(fresh.window, [null, null, null]);
  assert.equal(fresh.countdownMs, COLUMN_DEADLINE_MS);

  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X] = twoOutside(col3);
  const prior = [fillCol("🍉"), fillCol(X), fillCol(X)];

  // Mid-grace after 5 stops (no combo yet).
  const grace = viewerRunSnapshot({ inputs: craftedRun({ priorWindow: prior, stoppedCount: 5, activeDeadline: now + 4000, now }), now });
  assert.equal(grace.status, "grace");
  assert.equal(grace.graceStopsUsed, 5);
  assert.equal(grace.countdownMs, 4000);

  // Alive in the survival phase.
  const alive = viewerRunSnapshot({
    inputs: craftedRun({ priorWindow: prior, stoppedCount: 5, firstComboAt: 4, survived: 1, linesFormed: 2, activeDeadline: now + 4000, now }),
    now,
  });
  assert.equal(alive.status, "alive");
  assert.equal(alive.survived, 1);
  assert.equal(alive.firstComboAt, 4);

  // Busted.
  const busted = { ...craftedRun({ priorWindow: prior, stoppedCount: 5, firstComboAt: 4, survived: 1, linesFormed: 2, now }), ended: true, busted: true, activeIndex: null, activeDeadline: null };
  const b = viewerRunSnapshot({ inputs: busted, now });
  assert.equal(b.status, "busted");
  assert.equal(b.ended, true);

  // Grace-failed.
  const gf = { ...craftedRun({ priorWindow: prior, stoppedCount: 10, now }), ended: true, graceFailed: true, activeIndex: null, activeDeadline: null };
  assert.equal(viewerRunSnapshot({ inputs: gf, now }).status, "grace_failed");

  // Capped (safety cap).
  const capped = { ...craftedRun({ priorWindow: prior, stoppedCount: 5, firstComboAt: 4, survived: 1, linesFormed: 2, now }), ended: true, activeIndex: null, activeDeadline: null };
  assert.equal(viewerRunSnapshot({ inputs: capped, now }).status, "capped");

  // Falsy inputs → null (the store only passes real run states or null).
  assert.equal(viewerRunSnapshot({ inputs: null, now }), null);
  assert.equal(viewerRunSnapshot({ inputs: undefined, now }), null);

  // Deterministic.
  assert.deepEqual(viewerRunSnapshot({ inputs: alive, now }), viewerRunSnapshot({ inputs: alive, now }));
});

test("viewerRunSnapshot exposes the real preview of the next column + the jettison budget", () => {
  const now = Date.now();
  const m = makeSpinMatch({ now });

  // Fresh run: preview = the REAL column 0, full jettison budget.
  const fresh = viewerRunSnapshot({ inputs: m.p1CurrentInputs, now });
  assert.equal(fresh.previewIndex, 0);
  assert.deepEqual(
    fresh.preview,
    columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 0, symbols: FRUIT_SYMBOLS }),
  );
  assert.equal(fresh.jettisonsUsed, 0);
  assert.equal(fresh.jettisonsLeft, MAX_JETTISONS_PER_RUN);

  // Mid-sliding run with the jettison spent: preview = the NEXT column.
  const col3 = columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 3, symbols: FRUIT_SYMBOLS });
  const [X, Y] = twoOutside(col3);
  const prior = [fillCol("🍉"), [col3[0], Y, Y], [col3[0], X, X]];
  const run0 = craftedRun({ priorWindow: prior, stoppedCount: 3, firstComboAt: 3, linesFormed: 1, now });
  const mm = jettisonActiveColumn({ ...makeSpinMatch({ now }), p1CurrentInputs: run0 }, "player1", now).match;
  const snap = viewerRunSnapshot({ inputs: mm.p1CurrentInputs, now });
  assert.equal(snap.previewIndex, 4);
  assert.deepEqual(
    snap.preview,
    columnSymbols({ matchId: 7, spinNumber: 1, seat: "player1", colIndex: 4, symbols: FRUIT_SYMBOLS }),
  );
  assert.equal(snap.jettisonsUsed, 1);
  assert.equal(snap.jettisonsLeft, 0);

  // Ended runs expose no preview.
  const ended = {
    ...mm,
    p1CurrentInputs: {
      ...mm.p1CurrentInputs,
      ended: true,
      activeIndex: null,
      activeDeadline: null,
    },
  };
  const es = viewerRunSnapshot({ inputs: ended.p1CurrentInputs, now });
  assert.equal(es.previewIndex, null);
  assert.equal(es.preview, null);

  // Scrubbed opponent inputs (no symbols stream) never leak a preview.
  const opp = viewerRunSnapshot({ inputs: { stoppedCount: 3, ended: false, activeIndex: 3 }, now });
  assert.equal(opp.preview, null);
  assert.equal(opp.previewIndex, null);
});

// ════════════════════════════════════════════════════════════════════
// Misc helpers
// ════════════════════════════════════════════════════════════════════

test("round2 / pickPositiveInt behave like the other PvP games", () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2("12.345"), 12.35);
  assert.equal(round2(null), 0);
  assert.equal(pickPositiveInt(null, 10), 10);
  assert.equal(pickPositiveInt(0, 10), 10);
  assert.equal(pickPositiveInt("20", 10), 20);
  assert.equal(pickPositiveInt(15.9, 10), 15);
  assert.equal(READY_WINDOW_MS, 3000);
  assert.equal(BETWEEN_ROUNDS_MS, 3000);
  assert.equal(FINISHED_GRACE_MS, 5000);
});

console.log("\n✅ All PvP Slots (Fruit Fortune Survival) engine tests passed!\n");
