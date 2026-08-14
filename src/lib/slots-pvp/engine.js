// src/lib/slots-pvp/engine.js
//
// Pure, deterministic round engine for PvP Slots ("Fruit Fortune
// Survival"). NO database, NO I/O — every function is a pure mapping so
// it can be unit-tested, replayed for audit, and shared between the
// server store and the test runner.
//
// Game rules (per user spec):
//   * Single survival round on a 3-column sliding window.
//   * Each player stops columns one at a time. GRACE phase: the first
//     3 columns are always safe, and you keep stopping columns (no bust
//     possible) until you form your FIRST 3-in-a-row combo — 3 identical
//     symbols in a horizontal row or a diagonal (verticals never count).
//     You have at most GRACE_MAX_STOPS (10) stops to find it; burning
//     all 10 without a combo = graceFailed (loss).
//   * SURVIVAL phase: from the first combo onward, every column you stop
//     must re-form a horizontal/diagonal combo in the visible window or
//     you BUST. `survived` counts the columns survived after the first
//     combo; `linesFormed` counts every combo stop (incl. the first).
//   * The window always shows exactly 3 columns: a new column slides in
//     from the right and the oldest slides out to the left.
//   * Round resolution happens only when BOTH players' runs have ended
//     (no early loss reveal). Winner = higher `survived`, tiebreak
//     `linesFormed`; BOTH grace-failed → RESULT.GRACE_DRAW.
//
// Layering:
//   * `columnSymbols` — deterministic per-(match, spin, seat, colIndex)
//     3-symbol column from the theme's 5-symbol sub-pool. The stream is
//     LAZY: only the column currently sliding in is ever materialised.
//   * `openSpinState` — generates BOTH players' hidden run state.
//   * `applyColumnStop` / `autoStopActiveColumn` — the stop state
//     machine (initial any-order stops, then in-order sliding stops).
//   * `hasLine` / `winningLinesIn` — the combo checks (3 rows + 2
//     diagonals).
//   * `buildRoundResult` / `decideRoundWinner` — resolve the round into
//     its history-row payload (survival snapshots + round winner).
//   * `planAdvanceAfterResolve` — with MAX_ROUNDS = 1 the match always
//     finishes after the single round.
//   * `viewerRunSnapshot` — the viewer-visible CURRENT run served by the
//     status route (own board + status), never the opponent's.

import {
  COLUMN_DEADLINE_MS,
  COLUMN_STOP_GRACE_MS,
  GRACE_MAX_STOPS,
  MAX_COLUMNS_PER_ROUND,
  MAX_JETTISONS_PER_RUN,
  MAX_ROUNDS,
  MATCH_STATUS,
  RESULT,
  ROUNDS_TO_WIN,
  SLIDING_SYMBOL_COUNT,
  isSpinStatus,
  round2,
  spinNumberForStatus,
  statusForSpinNumber,
} from "./constants.js";

// ──────────────────────────────────────────────────────────────────────
// Board geometry + the combo lines (3 rows + 2 diagonals)
// ──────────────────────────────────────────────────────────────────────

export const GRID_COLS = 3;
export const GRID_ROWS = 3;

// All 5 lines that count as a combo on the 3-column window, as
// [col, row] coordinates. Verticals deliberately do NOT count.
export const HORIZ_DIAG_LINES = Object.freeze([
  Object.freeze({ name: "top-row", cells: [[0, 0], [1, 0], [2, 0]] }),
  Object.freeze({ name: "middle-row", cells: [[0, 1], [1, 1], [2, 1]] }),
  Object.freeze({ name: "bottom-row", cells: [[0, 2], [1, 2], [2, 2]] }),
  Object.freeze({ name: "diag-down", cells: [[0, 0], [1, 1], [2, 2]] }),
  Object.freeze({ name: "diag-up", cells: [[2, 0], [1, 1], [0, 2]] }),
]);

/** True when the visible window contains any combo (3 rows + 2 diagonals). */
export function hasLine(window) {
  if (!Array.isArray(window) || window.length < GRID_COLS) return false;
  for (const line of HORIZ_DIAG_LINES) {
    const syms = line.cells.map(([c, r]) => window?.[c]?.[r]);
    if (syms[0] && syms[0] === syms[1] && syms[1] === syms[2]) return true;
  }
  return false;
}

/** Every combo line present in the window (for the reveal / flash UI). */
export function winningLinesIn(window) {
  const out = [];
  if (!Array.isArray(window)) return out;
  for (const line of HORIZ_DIAG_LINES) {
    const syms = line.cells.map(([c, r]) => window?.[c]?.[r]);
    if (syms[0] && syms[0] === syms[1] && syms[1] === syms[2]) {
      out.push({ ...line, symbol: syms[0] });
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Deterministic PRNG + hashing
// ──────────────────────────────────────────────────────────────────────

/** cyrb53 string hash → unsigned 32-bit int. Deterministic across runs. */
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0) + (h1 << 1)) >>> 0;
}

/** mulberry32 seeded PRNG → deterministic sequence of [0, 1). */
export function mulberry32(seed) {
  let a = Number(seed) >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic per-(match, spin, seat) base seed. */
export function spinSeed(matchId, spinNumber, seat /* 1 | 2 */) {
  return cyrb53(`slots:${matchId}:p${seat}:spin${spinNumber}`);
}

// ──────────────────────────────────────────────────────────────────────
// The lazy column stream
// ──────────────────────────────────────────────────────────────────────

/**
 * Deterministic 3-symbol column for (match, spin, seat, colIndex). The
 * sub-pool is the theme's first SLIDING_SYMBOL_COUNT symbols — every
 * symbol is equal for combo matching (no value tiers in this mode).
 * Same inputs → same column, always (audit-replayable).
 */
export function columnSymbols({ matchId, spinNumber, seat, colIndex, symbols }) {
  const pool = (Array.isArray(symbols) ? symbols : []).slice(0, SLIDING_SYMBOL_COUNT);
  if (pool.length === 0) return ["?", "?", "?"];
  const rand = mulberry32(
    cyrb53(`slots:${matchId}:p${seat}:spin${spinNumber}:col${colIndex}`),
  );
  return Array.from({ length: GRID_ROWS }, () => pool[Math.floor(rand() * pool.length)]);
}

// ──────────────────────────────────────────────────────────────────────
// Round state machine (pure transitions)
// ──────────────────────────────────────────────────────────────────────
//
// A match object here is a plain JS shape with `status`, `currentSpin`,
// and `p1CurrentInputs` / `p2CurrentInputs` (the per-player run state).
// The server store persists exactly this shape into the
// `slots_pvp_matches` jsonb columns.
//
// Per-player run state (`p{N}CurrentInputs`):
//   {
//     matchId, spinNumber, seat,       // stream identity
//     seed, symbols,                   // stream inputs (replay-safe)
//     stoppedCount,                    // total columns landed
//     stoppedOrder: [],                // column indices in stop order
//     firstComboAt,                    // 1-based stop of the FIRST combo (null until found)
//     survived,                        // columns survived AFTER the first combo
//     linesFormed,                     // total combo stops (incl. the first)
//     busted,                          // ended: failed a combo in survival phase
//     graceFailed,                     // ended: burned all grace stops without a combo
//     ended,                           // run over (busted || graceFailed || capped)
//     bustColumn,                      // column index that ended the run (bust only)
//     anyAutoStopped,                  // true if any column was auto-stopped (AFK)
//     jettisonsUsed,                   // how many incoming columns were skipped (≤ MAX_JETTISONS_PER_RUN)
//     window: [c0, c1, c2],            // visible 3 columns (3-symbol arrays or null)
//     columns: [],                     // every landed column in order (replay)
//     activeIndex,                     // next column index to land (skips advance it)
//     activeDeadline,                  // ms epoch the active column auto-stops
//     openedAt,                        // ms epoch the round opened
//   }
//
// `activeIndex` is the authoritative "next column to land" pointer:
//   * initial phase: it starts at 0 and follows the in-order consumption
//     (the client stops columns 0,1,2 in order; the server tolerates any
//     order during grace, where activeIndex is only cosmetic).
//   * sliding phase: normally activeIndex === stoppedCount; a JETTISON
//     skips one column, so activeIndex becomes stoppedCount + 1 and the
//     skipped column never lands.

function openRunForSeat({ matchId, spinNumber, seat, symbols, now }) {
  return {
    matchId,
    spinNumber,
    seat,
    seed: spinSeed(matchId, spinNumber, seat),
    symbols: Array.isArray(symbols) ? symbols : [],
    stoppedCount: 0,
    stoppedOrder: [],
    firstComboAt: null,
    survived: 0,
    linesFormed: 0,
    busted: false,
    graceFailed: false,
    ended: false,
    bustColumn: null,
    anyAutoStopped: false,
    jettisonsUsed: 0,
    window: [null, null, null],
    columns: [],
    activeIndex: 0,
    activeDeadline: now + COLUMN_DEADLINE_MS,
    openedAt: now,
  };
}

/** Open the single survival round: BOTH players' hidden run state.
 *  Pure — the server store persists the returned state. */
export function openSpinState({ matchId, spinNumber, symbols, now = Date.now() }) {
  return {
    p1CurrentInputs: openRunForSeat({
      matchId,
      spinNumber,
      seat: "player1",
      symbols,
      now,
    }),
    p2CurrentInputs: openRunForSeat({
      matchId,
      spinNumber,
      seat: "player2",
      symbols,
      now,
    }),
  };
}

/**
 * Land one column onto a run and run the grace / survival logic.
 * Pure — returns a NEW run object (the caller wraps it back onto the
 * match). `auto` marks the landing as an AFK auto-stop.
 */
function landColumnRun(run, colIndex, now, auto = false) {
  const col = columnSymbols({
    matchId: run.matchId,
    spinNumber: run.spinNumber,
    seat: run.seat,
    colIndex,
    symbols: run.symbols,
  });
  const stoppedOrder = [...run.stoppedOrder, colIndex];
  const stoppedCount = run.stoppedCount + 1;

  // Window: initial columns occupy their own slots; sliding columns
  // shift the window left (oldest falls out).
  let window = run.window;
  if (colIndex < GRID_COLS) {
    window = window.map((c, i) => (i === colIndex ? col : c));
  } else {
    window = [window[1], window[2], col];
  }

  const next = {
    ...run,
    stoppedOrder,
    stoppedCount,
    columns: [...run.columns, col],
    window,
    anyAutoStopped: run.anyAutoStopped || auto,
  };

  // Combo / grace / bust logic — only once the window is full.
  if (stoppedCount >= GRID_COLS) {
    if (hasLine(window)) {
      next.linesFormed = next.linesFormed + 1;
      if (next.firstComboAt === null) {
        // First combo found → grace ends here; survival count stays 0.
        next.firstComboAt = stoppedCount;
      } else {
        next.survived = next.survived + 1;
      }
    } else if (next.firstComboAt === null) {
      // Still in grace: no bust possible, BUT the grace cap is hard —
      // burning GRACE_MAX_STOPS without a combo loses immediately.
      if (stoppedCount >= GRACE_MAX_STOPS) {
        next.graceFailed = true;
        next.ended = true;
      }
    } else {
      // Survival phase: stopping a column without a combo = bust.
      next.busted = true;
      next.ended = true;
      next.bustColumn = colIndex;
    }
  }

  // Safety cap — an ultra-lucky run can never hang the match.
  if (!next.ended && stoppedCount >= MAX_COLUMNS_PER_ROUND) {
    next.ended = true;
  }

  if (!next.ended) {
    // Next column to land: every landed column consumes exactly one
    // stream index, and every jettison skips exactly one — so the next
    // index is stoppedCount + jettisonsUsed (jettison is sliding-phase
    // only, so this is identical to the old `activeIndex = stoppedCount`
    // everywhere else).
    next.activeIndex = next.stoppedCount + (next.jettisonsUsed || 0);
    next.activeDeadline = now + COLUMN_DEADLINE_MS;
  } else {
    next.activeIndex = null;
    next.activeDeadline = null;
  }
  return next;
}

/**
 * Apply one column stop for a seat. Returns either
 * `{ ok: false, error, status }` or `{ ok: true, match }`.
 *
 * Rules enforced:
 *   * caller must be a participant seat
 *   * the match must be inside a spin round
 *   * expectedSpin (if provided) must match the live round — rejects
 *     STALE stops from a round that already advanced
 *   * the run must not already be ended
 *   * the active column's deadline must not have passed
 *   * INITIAL phase (stoppedCount < 3): any of columns 0..2, in any
 *     order, once each.
 *   * SLIDING phase: only the active stream column (stoppedCount) may be
 *     stopped — the newest sliding column is the only one spinning.
 */
export function applyColumnStop(
  match,
  seat,
  columnIndex,
  now = Date.now(),
  expectedSpin = null,
) {
  if (seat !== "player1" && seat !== "player2") {
    return { ok: false, error: "Caller is not a participant", status: 403 };
  }
  if (!isSpinStatus(match.status)) {
    return { ok: false, error: "Match is not in a spin round", status: 400 };
  }
  if (expectedSpin != null && Number(expectedSpin) !== Number(match.currentSpin)) {
    return {
      ok: false,
      error: "Round has already advanced",
      status: 409,
    };
  }

  const inputsKey = seat === "player1" ? "p1CurrentInputs" : "p2CurrentInputs";
  const run = match[inputsKey];
  if (!run) {
    return { ok: false, error: "Round has not started", status: 400 };
  }
  if (run.ended) {
    return { ok: false, error: "Your run has already ended", status: 409 };
  }
  // Lag cushion: a manual stop arriving up to COLUMN_STOP_GRACE_MS
  // AFTER the deadline is still honoured. Only genuinely-stale stops
  // (deadline + grace passed) are rejected — those fall to the
  // auto-stop path on the next /status poll.
  if (
    run.activeDeadline &&
    new Date(run.activeDeadline).getTime() + COLUMN_STOP_GRACE_MS <= now
  ) {
    return { ok: false, error: "Column time has expired", status: 400 };
  }

  const idx = Number(columnIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, error: "Invalid column index", status: 400 };
  }

  if (run.stoppedCount < GRID_COLS) {
    // Initial phase: columns 0..2, any order, once each.
    if (idx >= GRID_COLS) {
      return { ok: false, error: `Initial columns are 0..${GRID_COLS - 1}`, status: 400 };
    }
    if (run.stoppedOrder.includes(idx)) {
      return { ok: false, error: `Column ${idx + 1} is already stopped`, status: 409 };
    }
  } else {
    // Sliding phase: only the active column is stoppable (activeIndex
    // may have been advanced by a jettison).
    if (idx !== run.activeIndex) {
      return { ok: false, error: "Only the active column can be stopped", status: 409 };
    }
  }

  return {
    ok: true,
    match: {
      ...match,
      [inputsKey]: landColumnRun(run, idx, now),
    },
  };
}

/**
 * Jettison the ACTIVE column for a seat: skip it and take the NEXT
 * column in the stream instead. This is the skill mechanic — the
 * player can see the incoming column (the preview) and decide whether
 * to take it or burn one of their MAX_JETTISONS_PER_RUN skips. The
 * skipped column never lands and never appears in the window; the
 * active column advances by one index and gets a fresh countdown.
 *
 * Rules enforced (mirrors applyColumnStop):
 *   * caller must be a participant seat
 *   * the match must be inside a spin round
 *   * expectedSpin (if provided) must match the live round
 *   * the run must not already be ended
 *   * only the SLIDING phase (window full) — jettisoning an initial
 *     column would leave holes in the 3-column window
 *   * the active column's deadline (plus grace) must not have passed
 *   * the jettison budget must not be spent
 *
 * Pure — returns `{ ok: false, error, status }` or `{ ok: true, match }`.
 * A jettison never lands a column, so it can never end the run.
 */
export function jettisonActiveColumn(
  match,
  seat,
  now = Date.now(),
  expectedSpin = null,
) {
  if (seat !== "player1" && seat !== "player2") {
    return { ok: false, error: "Caller is not a participant", status: 403 };
  }
  if (!isSpinStatus(match.status)) {
    return { ok: false, error: "Match is not in a spin round", status: 400 };
  }
  if (expectedSpin != null && Number(expectedSpin) !== Number(match.currentSpin)) {
    return {
      ok: false,
      error: "Round has already advanced",
      status: 409,
    };
  }

  const inputsKey = seat === "player1" ? "p1CurrentInputs" : "p2CurrentInputs";
  const run = match[inputsKey];
  if (!run) {
    return { ok: false, error: "Round has not started", status: 400 };
  }
  if (run.ended) {
    return { ok: false, error: "Your run has already ended", status: 409 };
  }
  if (run.stoppedCount < GRID_COLS) {
    return {
      ok: false,
      error: "Jettison is only available once the window is full",
      status: 400,
    };
  }
  if (
    run.activeDeadline &&
    new Date(run.activeDeadline).getTime() + COLUMN_STOP_GRACE_MS <= now
  ) {
    return { ok: false, error: "Column time has expired", status: 400 };
  }
  if ((Number(run.jettisonsUsed) || 0) >= MAX_JETTISONS_PER_RUN) {
    return { ok: false, error: "No jettisons left", status: 409 };
  }

  const jettisonsUsed = (Number(run.jettisonsUsed) || 0) + 1;
  return {
    ok: true,
    match: {
      ...match,
      [inputsKey]: {
        ...run,
        jettisonsUsed,
        // Skip the active column: the next landable index is one further
        // into the stream (stoppedCount + jettisonsUsed).
        activeIndex: run.stoppedCount + jettisonsUsed,
        activeDeadline: now + COLUMN_DEADLINE_MS,
      },
    },
  };
}

/**
 * Auto-stop the active column(s) for a seat once the per-column
 * deadline passes (AFK nudge — guarantees a column never spins longer
 * than COLUMN_TIMER_SECONDS). Initial phase: remaining unstopped
 * columns are landed in ascending order; sliding phase: just the active
 * column. An auto-stop can bust the player in the survival phase.
 * Pure — returns a new match (or the same one when nothing is due).
 */
export function autoStopActiveColumn(match, seat, now = Date.now()) {
  const inputsKey = seat === "player1" ? "p1CurrentInputs" : "p2CurrentInputs";
  const run = match[inputsKey];
  if (!run || run.ended) return match;
  if (!run.activeDeadline || new Date(run.activeDeadline).getTime() > now) return match;

  let nextRun = run;
  if (nextRun.stoppedCount < GRID_COLS) {
    const remaining = [0, 1, 2].filter((i) => !nextRun.stoppedOrder.includes(i));
    for (const i of remaining) {
      nextRun = landColumnRun(nextRun, i, now, true);
      if (nextRun.ended) break;
    }
  } else {
    nextRun = landColumnRun(nextRun, nextRun.activeIndex, now, true);
  }
  return {
    ...match,
    [inputsKey]: nextRun,
  };
}

/** True when BOTH runs have ended — the round can be resolved. */
export function canResolveRound(match) {
  return (
    isSpinStatus(match.status) &&
    Boolean(match.p1CurrentInputs && match.p1CurrentInputs.ended) &&
    Boolean(match.p2CurrentInputs && match.p2CurrentInputs.ended)
  );
}

// ──────────────────────────────────────────────────────────────────────
// Round result + winner
// ──────────────────────────────────────────────────────────────────────

/**
 * Decide the round winner from the two players' run states.
 * Both grace-failed → RESULT.GRACE_DRAW. Otherwise higher `survived`
 * wins; equal survival is broken by `linesFormed`; still tied → draw.
 */
export function decideRoundWinner(p1, p2) {
  const a = p1 || {};
  const b = p2 || {};
  if (a.graceFailed && b.graceFailed) return RESULT.GRACE_DRAW;
  const sa = Number(a.survived) || 0;
  const sb = Number(b.survived) || 0;
  if (sa > sb) return RESULT.PLAYER1;
  if (sb > sa) return RESULT.PLAYER2;
  const la = Number(a.linesFormed) || 0;
  const lb = Number(b.linesFormed) || 0;
  if (la > lb) return RESULT.PLAYER1;
  if (lb > la) return RESULT.PLAYER2;
  return RESULT.DRAW;
}

/** Decide the MATCH result from match-level tallies (used by forfeits;
 *  natural settlements pass the round winner through directly). */
export function decideMatchResult({
  roundsWonPlayer1 = 0,
  roundsWonPlayer2 = 0,
  p1Score = 0,
  p2Score = 0,
} = {}) {
  const r1 = Number(roundsWonPlayer1) || 0;
  const r2 = Number(roundsWonPlayer2) || 0;
  if (r1 > r2) return RESULT.PLAYER1;
  if (r2 > r1) return RESULT.PLAYER2;
  const s1 = Number(p1Score) || 0;
  const s2 = Number(p2Score) || 0;
  if (s1 > s2) return RESULT.PLAYER1;
  if (s2 > s1) return RESULT.PLAYER2;
  return RESULT.DRAW;
}

/** Build the `slots_pvp_rounds` history-row payload for the resolved
 *  round: both players' survival snapshots + the round winner. The
 *  server computes everything from the ended run states — clients never
 *  submit scores. */
export function buildRoundResult(match, symbols) {
  const spinNumber = spinNumberForStatus(match.status);
  const p1 = match.p1CurrentInputs || {};
  const p2 = match.p2CurrentInputs || {};

  const snapshotFor = (run) => ({
    stoppedCount: Number(run.stoppedCount) || 0,
    stoppedOrder: Array.isArray(run.stoppedOrder) ? run.stoppedOrder : [],
    firstComboAt: run.firstComboAt ?? null,
    survived: Number(run.survived) || 0,
    linesFormed: Number(run.linesFormed) || 0,
    busted: Boolean(run.busted),
    graceFailed: Boolean(run.graceFailed),
    ended: Boolean(run.ended),
    bustColumn: run.bustColumn ?? null,
    autoStopped: Boolean(run.anyAutoStopped),
    window: Array.isArray(run.window) ? run.window : [null, null, null],
    columns: Array.isArray(run.columns) ? run.columns : [],
    winningLines: winningLinesIn(run.window),
  });

  return {
    matchId: match.id,
    spinNumber,
    player1Inputs: {
      stoppedOrder: Array.isArray(p1.stoppedOrder) ? p1.stoppedOrder : [],
      autoStopped: Boolean(p1.anyAutoStopped),
    },
    player2Inputs: {
      stoppedOrder: Array.isArray(p2.stoppedOrder) ? p2.stoppedOrder : [],
      autoStopped: Boolean(p2.anyAutoStopped),
    },
    player1Result: snapshotFor(p1),
    player2Result: snapshotFor(p2),
    player1AutoSpun: Boolean(p1.anyAutoStopped),
    player2AutoSpun: Boolean(p2.anyAutoStopped),
    // spin_points_* columns are repurposed as "columns survived".
    spinPointsPlayer1: Number(p1.survived) || 0,
    spinPointsPlayer2: Number(p2.survived) || 0,
    roundWinner: decideRoundWinner(p1, p2),
  };
}

/**
 * Plan the state AFTER the round resolves. With MAX_ROUNDS = 1 the
 * single survival round always finishes the match. Kept in the same
 * shape as the old best-of-5 planner so the server store flow is
 * unchanged. Pure — the server store persists the plan.
 */
export function planAdvanceAfterResolve({
  match,
  symbols,
  tallies = null,
  now = Date.now(),
}) {
  const spinNumber = spinNumberForStatus(match.status);
  if (spinNumber === null) return { finished: true };

  const r1 = Number(tallies?.roundsWonPlayer1 ?? match.roundsWonPlayer1) || 0;
  const r2 = Number(tallies?.roundsWonPlayer2 ?? match.roundsWonPlayer2) || 0;
  const matchDecided = r1 >= ROUNDS_TO_WIN || r2 >= ROUNDS_TO_WIN;

  if (matchDecided || spinNumber >= MAX_ROUNDS) {
    return {
      finished: true,
      status: MATCH_STATUS.FINISHED,
      endedAt: new Date(now),
    };
  }

  // Single-round mode never reaches here — kept for structural parity.
  const nextSpin = spinNumber + 1;
  const open = openSpinState({
    matchId: match.id,
    spinNumber: nextSpin,
    symbols,
    now,
  });
  return {
    finished: false,
    status: statusForSpinNumber(nextSpin),
    currentSpin: nextSpin,
    roundDeadline: null,
    p1CurrentInputs: open.p1CurrentInputs,
    p2CurrentInputs: open.p2CurrentInputs,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Viewer snapshot
// ──────────────────────────────────────────────────────────────────────

/**
 * The VIEWER-VISIBLE current run served by the status route: their own
 * board + status + countdown. The opponent's run never passes through
 * here — `scrubMatchForViewer` collapses it server-side.
 * Pure + deterministic: clients can only ever READ this, never submit.
 */
export function viewerRunSnapshot({ inputs, now = Date.now() }) {
  if (!inputs) return null;
  const status = inputs.ended
    ? inputs.busted
      ? "busted"
      : inputs.graceFailed
        ? "grace_failed"
        : "capped"
    : inputs.firstComboAt === null
      ? "grace"
      : "alive";

  const jettisonsUsed = Number(inputs.jettisonsUsed) || 0;
  const jettisonsLeft = Math.max(0, MAX_JETTISONS_PER_RUN - jettisonsUsed);

  // Skill preview: the REAL symbols of the next column to land (the one
  // the STOP/JETTISON buttons act on). Computed from the viewer's OWN
  // deterministic stream — the opponent's scrubbed inputs carry no
  // `symbols`, so their snapshot never leaks a preview.
  let previewIndex = null;
  let preview = null;
  if (!inputs.ended && inputs.activeIndex != null) {
    const ownStream =
      Array.isArray(inputs.symbols) &&
      inputs.symbols.length > 0 &&
      inputs.matchId != null &&
      inputs.seat != null;
    if (ownStream) {
      previewIndex = inputs.activeIndex;
      preview = columnSymbols({
        matchId: inputs.matchId,
        spinNumber: inputs.spinNumber,
        seat: inputs.seat,
        colIndex: inputs.activeIndex,
        symbols: inputs.symbols,
      });
    }
  }

  return {
    status,
    ended: Boolean(inputs.ended),
    busted: Boolean(inputs.busted),
    graceFailed: Boolean(inputs.graceFailed),
    survived: Number(inputs.survived) || 0,
    linesFormed: Number(inputs.linesFormed) || 0,
    firstComboAt: inputs.firstComboAt ?? null,
    stoppedCount: Number(inputs.stoppedCount) || 0,
    graceStopsUsed: Math.min(Number(inputs.stoppedCount) || 0, GRACE_MAX_STOPS),
    activeIndex: inputs.activeIndex ?? null,
    activeDeadline: inputs.activeDeadline ?? null,
    countdownMs: inputs.activeDeadline
      ? Math.max(0, new Date(inputs.activeDeadline).getTime() - now)
      : 0,
    jettisonsUsed,
    jettisonsLeft,
    previewIndex,
    preview,
    // Own board is always visible; the opponent's is scrubbed server-side.
    window: Array.isArray(inputs.window) ? inputs.window : null,
    columns: Array.isArray(inputs.columns) ? inputs.columns : [],
  };
}
