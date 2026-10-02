// src/lib/mines-pvp/constants.js
//
// Shared constants + board generation + outcome resolution for the
// Mines PvP ("Mines Duel") match system.
//
// ── The new game (replaces the old shared-board alternating-turn duel) ──
//
// Mines Duel is now a SIMULTANEOUS, INDEPENDENT-BOARD competitive
// scoring game:
//
//   • Both players play at the SAME TIME. There are no turns.
//   • Each seat gets its OWN server-generated board (the two boards can
//     never share the same mine POSITIONS — see `generateBoardPair`).
//   • Both boards share the same dimensions, mine count, mine-value
//     distribution, difficulty and scoring rules.
//   • A safe reveal scores +5, correctly flagging a mine scores the
//     mine's value, a wrong flag costs −10 and revealing a mine costs
//     −25. Clearing a board awards +100 and locks it; the OPPONENT keeps
//     playing.
//   • The match runs on ONE server-authoritative 180-second timer. When
//     both boards are complete (or the timer expires) the higher score
//     wins, with a deterministic tiebreak ladder (see `resolveScoredMatch`).
//   • Scores NEVER go below 0.
//
// The client is never trusted with the board, mine positions, mine
// values, scores, completion state or the timer. Everything in this
// module is server-only.

import { chooseAiOption, coerceAiDifficulty } from "../aiDifficulty";

// ── Board geometry ────────────────────────────────────────────────────
// 10×10 grid, row-major indexing (cell 0 = top-left, cell 99 =
// bottom-right). Kept from the previous implementation on purpose.
export const GRID_SIZE = 10;
export const GRID_CELLS = GRID_SIZE * GRID_SIZE; // 100
export const MIN_MINES = 1;
export const MAX_MINES = GRID_CELLS - 1; // 99 — a board can never be all mines

// ── Mine count + value distribution ──────────────────────────────────
// Every board holds EXACTLY 10 mines. Each mine carries a point value
// drawn from a fixed, server-side distribution so the four value tiers
// are consistent across both boards while the POSITIONS (and which tier
// sits where) are randomised per board.
//
// NOTE: the brief listed 8+5+3+1 = 17 mines against a 10-mine board.
// That is internally inconsistent, so the distribution below is the
// intended four tiers rescaled to exactly 10 mines: 5×10, 3×20, 1×30,
// 1×50. It is a single server constant so it can be rebalanced later.
export const MINE_VALUE_DISTRIBUTION = Object.freeze([
  Object.freeze({ value: 10, count: 5 }),
  Object.freeze({ value: 20, count: 3 }),
  Object.freeze({ value: 30, count: 1 }),
  Object.freeze({ value: 50, count: 1 }),
]);

export const MINES_PER_MATCH = MINE_VALUE_DISTRIBUTION.reduce(
  (sum, tier) => sum + tier.count,
  0,
); // 10

// Expanded, ordered list of mine values, e.g. [10,10,10,10,10,20,20,20,30,50].
export const MINE_VALUES = Object.freeze(
  MINE_VALUE_DISTRIBUTION.flatMap((tier) =>
    Array.from({ length: tier.count }, () => tier.value),
  ),
);

// ── Scoring ──────────────────────────────────────────────────────────
// Every point change is computed server-side. NEGATIVE_* are stored as
// positive magnitudes and subtracted, so a caller can never sign-flip a
// rule. Scores clamp at 0 (see `applyScoreDelta`).
export const SCORE = Object.freeze({
  SAFE_TILE: 5,
  CORRECT_FLAG: null, // the flagged mine's own value (tier-dependent)
  WRONG_FLAG: -10,
  MINE_HIT: -25,
  BOARD_COMPLETE: 100,
});

// ── Match timer (replaces the old per-turn 20s window) ───────────────
// ONE server-authoritative timer per match. Both players start at the
// same server timestamp; the client may render a countdown but the
// server decides every deadline AND every final result.
export const MATCH_TIMER_SECONDS = 180;
export const MATCH_TIMER_MS = MATCH_TIMER_SECONDS * 1000;

// ── Stake matchmaking constants (stakes retained as values; retired) ─
export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MIN_STAKE = 1;
export const MAX_STAKE = 100000;
export const HOUSE_FEE_PCT = 0.1;
export const WINNER_RATIO = 0.9;
export const HOUSE_RATIO = 0.1;

// ── Status state machine ─────────────────────────────────────────────
// `active` is the new simultaneous-play state. The old `p1_turn` /
// `p2_turn` labels are kept ONLY so legacy rows and the not-yet-updated
// client still resolve to a known state — nothing advances into them.
export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  ACTIVE: "active",
  // Legacy alternating-turn labels (no longer produced).
  P1_TURN: "p1_turn",
  P2_TURN: "p2_turn",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match is live (both players may act at will).
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.ACTIVE,
]);

// States where a reveal / flag is accepted. Only `active`.
export const PICKABLE_STATES = new Set([MATCH_STATUS.ACTIVE]);

// Terminal states. No further actions are accepted.
export const TERMINAL_STATES = new Set([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

// Auto-advance window between player2 joining and the match going live.
export const READY_WINDOW_MS = 3000;
export const FINISHED_GRACE_MS = 5000;

// ── Advisory-lock namespace for `createOrJoin` matchmaking ───────────
export const MINES_PVP_LOCK_NAMESPACE = 0x4d505650 & 0x7fffffff;

// ── Result / reason vocabularies ─────────────────────────────────────
// `result` is stored on the match row. 'draw' is reachable again (a
// perfectly-tied scored match) and is deterministic, never random.
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
});

// WHY a finished match ended.
//   SCORE      — the 180s timer expired (or both boards completed) and
//                the score/tiebreak ladder decided it
//   RESIGN     — a player conceded
//   DISCONNECT — a player dropped past the grace period
//   Legacy (old shared-board rows only): MINE_HIT / ALL_MINES_FLAGGED
export const WIN_REASON = Object.freeze({
  SCORE: "score",
  RESIGN: "resign",
  DISCONNECT: "disconnect",
  MINE_HIT: "mine_hit",
  ALL_MINES_FLAGGED: "all_mines_flagged",
});

// Discriminator for the chronological action history entries.
export const ACTION_KIND = Object.freeze({
  REVEAL: "reveal",
  FLAG: "flag",
});

// ── Board generation ─────────────────────────────────────────────────
// Returns `{ size, mines, values }`:
//   mines  — sorted, unique 0..99 row-major cell indices (length === 10)
//   values — a plain object mapping mine cell index → point value, drawn
//            from MINE_VALUE_DISTRIBUTION (server-only; never sent while
//            the match is live).
//
// `minesCount` defaults to MINES_PER_MATCH and is validated; the value
// tiers are always the full MINE_VALUES list (so a caller cannot request
// a denser/sparser distribution).
export function generateBoard(minesCount = MINES_PER_MATCH) {
  const count = Number(minesCount);
  if (!Number.isInteger(count) || count < MIN_MINES || count > MAX_MINES) {
    throw new RangeError(
      `generateBoard: minesCount must be an integer in [${MIN_MINES}, ${MAX_MINES}], got ${minesCount}`,
    );
  }
  if (count !== MINES_PER_MATCH) {
    throw new RangeError(
      `generateBoard: minesCount is fixed at ${MINES_PER_MATCH}, got ${minesCount}`,
    );
  }

  // Fisher-Yates partial shuffle over the 100 cells.
  const all = Array.from({ length: GRID_CELLS }, (_, i) => i);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(Math.random() * (GRID_CELLS - i));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const mines = all.slice(0, count).sort((a, b) => a - b);

  // Shuffle the value list, then assign one value per mine. Shuffling
  // prevents the highest-value mines from clustering on the lowest
  // cell indices (which would be a readable pattern).
  const values = [...MINE_VALUES];
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  const valueByCell = {};
  mines.forEach((cell, index) => {
    valueByCell[String(cell)] = values[index];
  });

  return { size: GRID_SIZE, mines, values: valueByCell };
}

// Generate TWO boards for one match. The rules require the two players
// to have DIFFERENT mine positions, so we retry until the mine sets
// differ. `attempts` bounds the retry (with 10 of 100 cells the chance
// of a collision is astronomically small, but bounded retries keep the
// function total).
export function generateBoardPair(minesCount = MINES_PER_MATCH) {
  const board1 = generateBoard(minesCount);
  let board2 = generateBoard(minesCount);
  let attempts = 0;
  while (samePositions(board1, board2) && attempts < 100) {
    board2 = generateBoard(minesCount);
    attempts += 1;
  }
  return { board1, board2 };
}

// True when two boards share the exact same mine cell set.
export function samePositions(a, b) {
  if (!a || !b || !Array.isArray(a.mines) || !Array.isArray(b.mines)) {
    return false;
  }
  if (a.mines.length !== b.mines.length) return false;
  for (let i = 0; i < a.mines.length; i += 1) {
    if (a.mines[i] !== b.mines[i]) return false;
  }
  return true;
}

// ── Mine lookup helpers ──────────────────────────────────────────────
export function isMine(board, cellIndex) {
  if (!board || !Array.isArray(board.mines)) return false;
  if (typeof cellIndex !== "number") return false;
  const idx = cellIndex;
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) return false;
  return board.mines.includes(idx);
}

// The point value of the mine at `cellIndex`, or null when the cell is
// not a mine. Server-only — never exposed to a client that has not
// correctly identified the mine.
export function mineValueAt(board, cellIndex) {
  if (!isMine(board, cellIndex)) return null;
  const raw = board?.values?.[String(cellIndex)];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    // Defensive fallback: a malformed value map still yields a sane
    // value rather than NaN, so a score can never be corrupted.
    return Math.min(...MINE_VALUES);
  }
  return value;
}

// ── Clamped score arithmetic ─────────────────────────────────────────
// Apply a signed delta to a score, clamping the floor at 0. Non-finite
// input is treated as a zero delta (defence-in-depth).
export function applyScoreDelta(currentScore, delta) {
  const base = Number(currentScore);
  const d = Number(delta);
  const safeBase = Number.isFinite(base) ? base : 0;
  const safeDelta = Number.isFinite(d) ? d : 0;
  return Math.max(0, safeBase + safeDelta);
}

// ── Reveal / flag set helpers ────────────────────────────────────────
// A seat's state is tracked as three plain arrays on the match row:
//   revealed     — every cell the seat has RESOLVED by revealing it
//                  (safe tiles + mines it detonated)
//   flags        — the seat's currently-active flag CLAIMS
//   correctFlags — the subset of `flags` that really are mines
// `normalizeFlags` canonicalises any of them to unique, sorted,
// in-range integers so tampered / legacy JSONB can never corrupt state.

export function normalizeFlags(flags) {
  if (!Array.isArray(flags)) return [];
  const seen = new Set();
  for (const raw of flags) {
    if (typeof raw !== "number" && typeof raw !== "string") continue;
    const idx = Number(raw);
    if (Number.isInteger(idx) && idx >= 0 && idx < GRID_CELLS) seen.add(idx);
  }
  return [...seen].sort((a, b) => a - b);
}

// Read one seat's active flag set off a match row.
export function flagsForSeat(match, seat) {
  const field = seat === "player2" ? "p2Flags" : "p1Flags";
  return normalizeFlags(match?.[field]);
}

// Read one seat's revealed set off a match row.
export function revealedForSeat(match, seat) {
  const field = seat === "player2" ? "p2Revealed" : "p1Revealed";
  return normalizeFlags(match?.[field]);
}

// Read one seat's confirmed-mine (correctly flagged) set.
export function correctFlagsForSeat(match, seat) {
  const field = seat === "player2" ? "p2CorrectFlags" : "p1CorrectFlags";
  return normalizeFlags(match?.[field]);
}

// ── Board completion ─────────────────────────────────────────────────
// A board is COMPLETE when every cell is resolved: every safe tile has
// been revealed, and every mine has either been correctly flagged or
// detonated (revealed). Because a revealed cell and a correctly-flagged
// cell can never be the same cell (the store forbids it), completion is
// simply `revealed ∪ correctFlags === the whole board`.
export function isBoardComplete(board, revealed, correctFlags) {
  if (!board || !Array.isArray(board.mines)) return false;
  const resolved = new Set([
    ...normalizeFlags(revealed),
    ...normalizeFlags(correctFlags),
  ]);
  return resolved.size >= GRID_CELLS;
}

// ── Tiebreak ladder ──────────────────────────────────────────────────
// Given two seats' final public stats, decide the winner deterministically:
//   1. higher score
//   2. fewer mines hit
//   3. fewer incorrect flags
//   4. more correct flags
//   5. earlier completion timestamp
//   6. draw
//
// Returns "player1" | "player2" | "draw". Pure — no DB, no clock — so it
// is directly unit-testable.
export function decideScoredWinner(p1, p2) {
  const score1 = Number(p1?.score) || 0;
  const score2 = Number(p2?.score) || 0;
  if (score1 !== score2) return score1 > score2 ? "player1" : "player2";

  const hit1 = Number(p1?.minesHit) || 0;
  const hit2 = Number(p2?.minesHit) || 0;
  if (hit1 !== hit2) return hit1 < hit2 ? "player1" : "player2";

  const wrong1 = Number(p1?.incorrectFlags) || 0;
  const wrong2 = Number(p2?.incorrectFlags) || 0;
  if (wrong1 !== wrong2) return wrong1 < wrong2 ? "player1" : "player2";

  const correct1 = Number(p1?.correctFlags) || 0;
  const correct2 = Number(p2?.correctFlags) || 0;
  if (correct1 !== correct2) return correct1 > correct2 ? "player1" : "player2";

  const done1 = p1?.completedAt ? new Date(p1.completedAt).getTime() : null;
  const done2 = p2?.completedAt ? new Date(p2.completedAt).getTime() : null;
  if (Number.isFinite(done1) && Number.isFinite(done2) && done1 !== done2) {
    return done1 < done2 ? "player1" : "player2";
  }
  if (Number.isFinite(done1) && !Number.isFinite(done2)) return "player1";
  if (Number.isFinite(done2) && !Number.isFinite(done1)) return "player2";

  return RESULT.DRAW;
}

// ── Player-state snapshot (canonical read) ───────────────────────────
// Builds the per-seat stats object the tiebreak ladder and settlement
// consume. `seat` is "player1" | "player2".
export function seatStats(match, seat) {
  const p = seat === "player2";
  return {
    score: Number(p ? match?.p2Score : match?.p1Score) || 0,
    minesHit: Number(p ? match?.p2MinesHit : match?.p1MinesHit) || 0,
    incorrectFlags:
      Number(p ? match?.p2IncorrectFlags : match?.p1IncorrectFlags) || 0,
    correctFlags:
      Number(p ? match?.p2CorrectFlags : match?.p1CorrectFlags) || 0,
    completedAt: (p ? match?.p2CompletedAt : match?.p1CompletedAt) ?? null,
    completed: Boolean(p ? match?.p2Completed : match?.p1Completed),
  };
}

// ── Outcome resolution ───────────────────────────────────────────────
// Resolve a finished scored match to a `result`. Thin wrapper around the
// tiebreak ladder so the store has one call site.
export function resolveScoredMatch(match) {
  return decideScoredWinner(
    seatStats(match, "player1"),
    seatStats(match, "player2"),
  );
}

// ── Payout calculator (stakes retired → all zeros) ───────────────────
export function computePayout({ stakeAmount, result }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake < 0) {
    throw new RangeError(
      `computePayout: stakeAmount must be a non-negative number, got ${stakeAmount}`,
    );
  }
  if (![RESULT.PLAYER1, RESULT.PLAYER2, RESULT.DRAW].includes(result)) {
    throw new RangeError(
      `computePayout: result must be one of player1|player2|draw, got ${result}`,
    );
  }
  if (result === RESULT.DRAW) {
    return {
      stake: round2(stake),
      winnerNet: null,
      loserNet: null,
      houseFee: 0,
      prizePaid: 0,
    };
  }
  return {
    stake: round2(stake),
    winnerNet: round2(stake + round2(stake * WINNER_RATIO)),
    loserNet: round2(-stake),
    houseFee: round2(stake * HOUSE_RATIO),
    prizePaid: round2(stake + round2(stake * WINNER_RATIO)),
  };
}

export function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

// ── Cell index ↔ row/col ─────────────────────────────────────────────
export function cellIndexToRowCol(cellIndex) {
  // Reject null/undefined outright — `Number(null)` is 0, which would
  // otherwise read as a valid top-left cell.
  if (cellIndex === null || cellIndex === undefined) return null;
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) return null;
  return { row: Math.floor(idx / GRID_SIZE), col: idx % GRID_SIZE };
}

export function rowColToCellIndex(row, col) {
  const r = Number(row);
  const c = Number(col);
  if (
    !Number.isInteger(r) ||
    !Number.isInteger(c) ||
    r < 0 ||
    r >= GRID_SIZE ||
    c < 0 ||
    c >= GRID_SIZE
  ) {
    return null;
  }
  return r * GRID_SIZE + c;
}

// Chebyshev (king-move) tile distance between two cells.
export function chebyshevDistance(a, b) {
  const ra = cellIndexToRowCol(a);
  const rb = cellIndexToRowCol(b);
  if (!ra || !rb) return null;
  return Math.max(Math.abs(ra.row - rb.row), Math.abs(ra.col - rb.col));
}

// Chebyshev distance to the nearest mine: 1 = touching, etc. A mine
// returns 0. Returns null for unknown boards/cells.
export function nearestMineDistance(board, cellIndex) {
  if (!board || !Array.isArray(board.mines) || board.mines.length === 0) {
    return null;
  }
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) return null;
  const rc = cellIndexToRowCol(idx);
  if (!rc) return null;
  let best = Infinity;
  for (const mine of board.mines) {
    const mr = cellIndexToRowCol(mine);
    if (!mr) continue;
    const d = Math.max(Math.abs(rc.row - mr.row), Math.abs(rc.col - mr.col));
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : null;
}

// ── AI ───────────────────────────────────────────────────────────────
export const MINES_AI_PLAYER_ID = "mines_ai_bot";
export const AI_PICK_DELAY_MS = 1500; // legacy client pacing constant

export function isFreeAiMatch(match) {
  return Boolean(match?.isAi);
}

// Risk estimate for an unknown cell from that seat's OWN public clues.
// 0 = a clue has proven the cell safe; higher = likelier to be a mine.
export function aiCellRisk(cell, revealed) {
  let risk = 0;
  for (const { cell: r, hint } of revealed) {
    if (!Number.isInteger(hint) || hint < 1) continue;
    const d = chebyshevDistance(cell, r);
    if (d === null) continue;
    if (d < hint) continue; // provably safe given this clue
    const edge = d - hint;
    risk += 1 / (edge + 1) / hint;
  }
  return risk;
}

// Mines a seat can PROVE from its own clues: if every still-unknown cell
// on a clue's ring but one is accounted for, the last one is a mine.
export function deduceKnownMines(revealed, unknown, flagged = []) {
  const flaggedSet = flagged instanceof Set ? flagged : new Set(flagged || []);
  const unknownCells = Array.isArray(unknown) ? unknown : [...unknown];
  const mines = new Set();
  for (const entry of revealed) {
    const r = Number(entry?.cell);
    const hint = Number(entry?.hint);
    if (!Number.isInteger(r) || !Number.isInteger(hint) || hint < 1) continue;
    let candidate = null;
    let count = 0;
    for (const cell of unknownCells) {
      if (flaggedSet.has(cell)) continue;
      if (chebyshevDistance(cell, r) !== hint) continue;
      candidate = cell;
      count += 1;
      if (count > 1) break;
    }
    if (count !== 1 || candidate === null) continue;
    if (!isFrontierMine(candidate, revealed)) continue;
    mines.add(candidate);
  }
  return [...mines].sort((a, b) => a - b);
}

function isFrontierMine(cell, revealed) {
  for (const entry of revealed) {
    const r = Number(entry?.cell);
    const hint = Number(entry?.hint);
    if (!Number.isInteger(r) || !Number.isInteger(hint) || hint < 1) continue;
    const d = chebyshevDistance(cell, r);
    if (d !== null && d < hint) return false;
  }
  for (const entry of revealed) {
    const r = Number(entry?.cell);
    const hint = Number(entry?.hint);
    if (!Number.isInteger(r) || !Number.isInteger(hint) || hint < 1) continue;
    if (chebyshevDistance(cell, r) === hint) return true;
  }
  return false;
}

/**
 * Choose the bot's next action ONE seat at a time, reading only that
 * seat's own revealed clues and flag set (never the hidden board).
 *
 * `revealed` — [{ cell, hint }] (the seat's own safe reveals)
 * `flags`    — the seat's currently-active flag cells
 * `resolved` — cells already resolved (revealed ∪ correct flags)
 *
 * Returns { kind: "flag"|"reveal", cellIndex } or null when nothing is
 * left to do.
 */
export function chooseAiActionForSeat({
  revealed = [],
  flags = [],
  resolved = [],
  difficulty,
  random = Math.random,
}) {
  const tier = coerceAiDifficulty(difficulty);
  const resolvedSet = new Set(normalizeFlags(resolved));
  const flagsSet = new Set(normalizeFlags(flags));

  const unknown = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (!resolvedSet.has(i)) unknown.push(i);
  }
  if (unknown.length === 0 && flagsSet.size === 0) return null;

  // Prove mines from the clues (normal / hard only).
  if (tier !== "easy" && revealed.length > 0) {
    const mines = deduceKnownMines(revealed, unknown, flagsSet);
    const flaggable = mines.filter((m) => !flagsSet.has(m));
    if (flaggable.length > 0) {
      const cellIndex =
        flaggable[Math.floor(random() * flaggable.length) % flaggable.length];
      return { kind: ACTION_KIND.FLAG, cellIndex };
    }
  }

  const candidates = unknown.filter((c) => !flagsSet.has(c));
  if (candidates.length === 0) return null;

  if (tier === "easy") {
    return {
      kind: ACTION_KIND.REVEAL,
      cellIndex: candidates[Math.floor(random() * candidates.length) % candidates.length],
    };
  }

  const chosen = chooseAiOption(
    tier,
    candidates,
    (cell) => -aiCellRisk(cell, revealed),
    random,
  );
  return { kind: ACTION_KIND.REVEAL, cellIndex: chosen ?? candidates[0] };
}

