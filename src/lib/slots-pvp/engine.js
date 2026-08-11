// src/lib/slots-pvp/engine.js
//
// Pure, deterministic round engine for PvP Slots. NO database, NO I/O —
// every function is a pure mapping so it can be unit-tested, replayed
// for audit, and shared between the server store and the test runner.
//
// Layering (mirrors plinko-pvp's physics.js being imported by the
// server store):
//   * `resolveSpin` — the 3x3 outcome engine: server decides how many
//     winning lines to guarantee (outcome-first, like the solo
//     /api/slots/play), builds the board to fit, then `evaluateBoard`
//     scores whatever actually landed (natural accidental lines on
//     top of the forced ones are counted too).
//   * `openSpinState` — generates BOTH players' hidden round state
//     (final reels + precomputed board score) when a spin round opens.
//   * `applyReelStop` / `autoStopReels` — the skill-stop state machine.
//     Manual stops record a per-reel offset (ms since round open) that
//     feeds the stop-accuracy bonus.
//   * `scoreBoard` / `buildRoundResult` / `planAdvanceAfterResolve` —
//     resolve the round into its history-row payload (final score +
//     round winner) and the next state.
//   * `viewerRoundScoreSnapshot` — the viewer-visible CURRENT round
//     score served by the status route: the FULL score once the
//     viewer's board locks, or the live stop-bonus total while they
//     are still stopping. Always recomputed from the viewer's OWN
//     inputs only — the opponent's score never passes through it.
//   * `decideRoundWinner` / `decideMatchResult` — the FINAL scoring
//     rules: round winner by higher total score; match winner by most
//     rounds won, tie-broken by aggregate points.
//   * Best-of-5: a player who reaches ROUNDS_TO_WIN (3) round wins
//     ends the match IMMEDIATELY — `planAdvanceAfterResolve` decides
//     this from the post-round tallies; MAX_ROUNDS (5) is the hard cap.
//
// Scoring (per user spec, fully server-authoritative):
//   * 8 winning lines on the 3x3 board (3 rows + 3 columns + 2
//     diagonals). A line wins when its 3 cells are the same symbol.
//   * Symbol tiers are POSITION-BASED: each theme's first 6 symbols
//     map to Cherry(100) … Diamond(500); the other 14 symbols score 0
//     (a 3-in-a-row of them is NOT a winning line).
//   * Line-count multiplier: 1 line x1, 2 x1.25, 3 x1.5, 4 x2, 5+ x3.
//   * Stop accuracy per reel: Perfect (+100) within 3s, Good (+50)
//     within 6s, Normal (+0) after / auto-stopped.
//   * Round score = (sum of winning-line base scores) * line multiplier
//     + stop bonus. Clients never submit scores — the board is generated
//     server-side and the score is recomputed from it at resolve.

import {
  MAX_ROUNDS,
  MATCH_STATUS,
  REELS_PER_ROUND,
  RESULT,
  ROUNDS_TO_WIN,
  ROUND_DEADLINE_MS,
  SCORING_SYMBOL_COUNT,
  SYMBOL_SCORES,
  isSpinStatus,
  lineMultiplierForCount,
  round2,
  spinNumberForStatus,
  statusForSpinNumber,
  stopAccuracyForOffset,
  stopBonusForAccuracy,
} from "./constants.js";

// ──────────────────────────────────────────────────────────────────────
// Board geometry + the 8 winning lines (3x3)
// ──────────────────────────────────────────────────────────────────────

export const GRID_COLS = 3;
export const GRID_ROWS = 3;

// All 8 possible winning lines on a 3x3 board, as [col, row] cell
// coordinates (reels is indexed reels[col][row]). A line wins when all
// 3 of its cells hold the SAME scoring symbol. Kept in the same
// { name, cells } shape so the client's payline overlay can render any
// of them (rows, columns, and diagonals).
export const WINNING_LINES = Object.freeze([
  // 3 horizontal (rows)
  Object.freeze({ name: "top-row", cells: [[0, 0], [1, 0], [2, 0]] }),
  Object.freeze({ name: "middle-row", cells: [[0, 1], [1, 1], [2, 1]] }),
  Object.freeze({ name: "bottom-row", cells: [[0, 2], [1, 2], [2, 2]] }),
  // 3 vertical (columns)
  Object.freeze({ name: "left-col", cells: [[0, 0], [0, 1], [0, 2]] }),
  Object.freeze({ name: "center-col", cells: [[1, 0], [1, 1], [1, 2]] }),
  Object.freeze({ name: "right-col", cells: [[2, 0], [2, 1], [2, 2]] }),
  // 2 diagonal
  Object.freeze({ name: "diag-down", cells: [[0, 0], [1, 1], [2, 2]] }),
  Object.freeze({ name: "diag-up", cells: [[2, 0], [1, 1], [0, 2]] }),
]);

// ──────────────────────────────────────────────────────────────────────
// Outcome table (server-authoritative odds)
// ──────────────────────────────────────────────────────────────────────
//
// The server rolls the outcome FIRST (like the solo /api/slots/play),
// then builds the board to guarantee the rolled number of winning rows.
// Pure-random 3x3 boards would rarely hit 3-in-a-row across 20 symbols,
// so forcing keeps symbol scores meaningful and the rounds lively.
//
//   roll < 3   → 3 forced rows of one scoring symbol (usually cascades
//                into all 8 lines — the jackpot roll)
//   roll < 10  → 2 forced rows
//   roll < 25  → 1 forced row
//   else       → nothing forced (natural lines only)
//
// The same forced symbol is used for every forced row; accidental
// natural lines on top are scored normally by `evaluateBoard`.
export const FORCED_LINE_ODDS = Object.freeze([
  Object.freeze({ maxRoll: 3, forcedLines: 3 }),
  Object.freeze({ maxRoll: 10, forcedLines: 2 }),
  Object.freeze({ maxRoll: 25, forcedLines: 1 }),
  Object.freeze({ maxRoll: 100, forcedLines: 0 }),
]);

/** Decide how many rows to force from a roll in [0, 1). */
export function decideForcedLines(roll01) {
  const roll = Number.isFinite(roll01) ? roll01 * 100 : 100;
  for (const row of FORCED_LINE_ODDS) {
    if (roll < row.maxRoll) return row.forcedLines;
  }
  return 0;
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

// ──────────────────────────────────────────────────────────────────────
// Symbol scoring (position-based tiers)
// ──────────────────────────────────────────────────────────────────────

/** Map a theme's symbol pool to base scores: index 0..5 → Cherry..Diamond.
 *  Symbols at index >= SCORING_SYMBOL_COUNT map to 0 (never win). */
export function buildScoreMap(symbols) {
  const map = {};
  (Array.isArray(symbols) ? symbols : []).forEach((sym, i) => {
    if (i < SCORING_SYMBOL_COUNT) map[sym] = SYMBOL_SCORES[i];
  });
  return map;
}

// ──────────────────────────────────────────────────────────────────────
// Board builder + evaluator
// ──────────────────────────────────────────────────────────────────────

/** Build a 3x3 reel grid. When forcedLines > 0, the top `forcedLines`
 *  rows are filled with `forcedSymbol` (a scoring symbol) so those rows
 *  are guaranteed winning lines. Pure + deterministic via `rand`. */
export function buildReels({ symbols, forcedLines = 0, forcedSymbol = null, rand }) {
  const pick = () => symbols[Math.floor(rand() * symbols.length)];
  const reels = Array.from({ length: GRID_COLS }, () =>
    Array.from({ length: GRID_ROWS }, () => pick()),
  );
  if (forcedLines > 0 && forcedSymbol) {
    for (let row = 0; row < Math.min(forcedLines, GRID_ROWS); row += 1) {
      for (let col = 0; col < GRID_COLS; col += 1) {
        reels[col][row] = forcedSymbol;
      }
    }
  }
  return reels;
}

/**
 * Score a 3x3 board against all 8 winning lines. Returns the symbol
 * component of the round score:
 *
 *   {
 *     winningLines, // [{ line, symbol, base, cells }] — only scoring symbols
 *     lineCount,    // number of winning lines (drives the multiplier)
 *     multiplier,   // lineMultiplierForCount(lineCount)
 *     baseScore,    // sum of winning-line base scores (pre-multiplier)
 *     symbolScore,  // Math.round(baseScore * multiplier) — integer so it
 *                   //   fits the integer spin_points/p1_score columns
 *   }
 *
 * Deterministic — same reels + symbols always yield the same score.
 * Clients cannot influence it: the board is generated server-side.
 */
export function evaluateBoard({ reels, symbols }) {
  const scoreMap = buildScoreMap(symbols);
  const winningLines = [];
  for (const line of WINNING_LINES) {
    const syms = line.cells.map(([c, r]) => reels?.[c]?.[r]);
    if (syms[0] && syms[0] === syms[1] && syms[1] === syms[2]) {
      const base = scoreMap[syms[0]] || 0;
      if (base > 0) {
        winningLines.push({
          line: line.name,
          symbol: syms[0],
          base,
          cells: line.cells,
        });
      }
    }
  }
  const lineCount = winningLines.length;
  const multiplier = lineMultiplierForCount(lineCount);
  const baseScore = winningLines.reduce((sum, w) => sum + w.base, 0);
  return {
    winningLines,
    lineCount,
    multiplier,
    baseScore,
    // Math.round keeps the score an exact integer (base scores are
    // integers but multipliers 1.25 / 1.5 can produce fractional raw
    // products like 275 x 1.25 = 343.75). The DB columns for points
    // are `integer`, so rounding here keeps the persisted value in
    // lock-step with the jsonb snapshot.
    symbolScore: Math.round(baseScore * multiplier),
  };
}

/**
 * Full spin resolution — outcome-first, then naturally scored:
 *   1. Roll to decide how many winning rows to force.
 *   2. Pick a forced symbol from the 6 scoring tiers.
 *   3. Build the reels (forcing the rows), then evaluate the real board.
 *
 * @param {string[]} symbols theme symbol pool (first 6 = scoring tiers)
 * @param {number} seed deterministic 32-bit seed
 * @returns {{ reels, ...evaluateBoard }} board + symbol score
 */
export function resolveSpin({ symbols, seed }) {
  const rand = mulberry32(seed);
  const forcedLines = decideForcedLines(rand());
  const scoringPool = (symbols || []).slice(0, SCORING_SYMBOL_COUNT);
  const forcedSymbol =
    forcedLines > 0 && scoringPool.length > 0
      ? scoringPool[Math.floor(rand() * scoringPool.length)]
      : null;
  const reels = buildReels({ symbols, forcedLines, forcedSymbol, rand });
  return { reels, ...evaluateBoard({ reels, symbols }) };
}

/** Deterministic per-(match, spin, seat) seed. Same inputs → same reels.
 *  The reels are precomputed at round OPEN, so manual and AFK
 *  auto-stopped rounds of the same round share the same hidden reels
 *  (no variant is needed — the outcome never depends on HOW a reel
 *  was stopped, only on the round identity). */
export function spinSeed(matchId, spinNumber, seat /* 1 | 2 */) {
  return cyrb53(`slots:${matchId}:p${seat}:spin${spinNumber}`);
}

// ──────────────────────────────────────────────────────────────────────
// Round state machine (pure transitions)
// ──────────────────────────────────────────────────────────────────────
//
// A match object here is a plain JS shape with `status`, `currentSpin`,
// `roundDeadline` (Date), and `p1CurrentInputs` / `p2CurrentInputs`
// (the per-player round state below). The server store persists exactly
// this shape into the `slots_pvp_matches` jsonb columns.
//
// Per-player round state (`p{N}CurrentInputs`):
//   {
//     seed,            // deterministic seed for this (match, spin, seat)
//     reels,           // 3x3 final grid (hidden from the opponent)
//     winningLines, lineCount, multiplier, baseScore, symbolScore, // precomputed
//     openedAt,        // ms epoch when the round opened (stop timing)
//     reelsStopped: [],  // reel indices already stopped (0..2)
//     stopOffsets: {},   // reelIndex → ms since round open (accuracy)
//     autoStopped: false, // true when the 10s deadline forced the stop
//     boardLocked: false, // true once all 3 reels are stopped
//   }

/** Open a spin round: generate BOTH players' hidden round state with
 *  deterministic seeds and stamp the 10-second deadline. Pure — the
 *  server store persists the returned state.
 *  `openedAt` (ms epoch) defaults to `deadline - ROUND_DEADLINE_MS`. */
export function openSpinState({ matchId, spinNumber, symbols, deadline, openedAt = null }) {
  const seed1 = spinSeed(matchId, spinNumber, 1);
  const seed2 = spinSeed(matchId, spinNumber, 2);
  const r1 = resolveSpin({ symbols, seed: seed1 });
  const r2 = resolveSpin({ symbols, seed: seed2 });
  const openAt =
    openedAt != null
      ? new Date(openedAt).getTime()
      : new Date(deadline).getTime() - ROUND_DEADLINE_MS;
  const base = {
    openedAt: openAt,
    reelsStopped: [],
    stopOffsets: {},
    autoStopped: false,
    boardLocked: false,
  };
  return {
    p1CurrentInputs: { ...base, seed: seed1, ...r1 },
    p2CurrentInputs: { ...base, seed: seed2, ...r2 },
    deadline,
  };
}

/**
 * Apply one manual reel stop for a seat. Returns either
 * `{ ok: false, error, status }` or `{ ok: true, match }` where
 * `match` is a shallow-cloned match with the stop applied.
 *
 * Rules enforced:
 *   * caller must be a participant seat
 *   * the match must be inside a spin round
 *   * expectedSpin (if provided) must match the live round — rejects
 *     STALE stops from a previous round that arrived after the round
 *     already advanced (mirrors plinko-pvp's current_ball guard)
 *   * reelIndex must be an integer in [0, REELS_PER_ROUND)
 *   * the round deadline must not have passed (never > 10s)
 *   * the reel must not already be stopped (no re-stopping)
 *   * the board must not already be locked
 *
 * Each accepted stop records `stopOffsets[reelIndex] = now - openedAt`
 * (ms since the round opened) — the server-side timing source for the
 * stop-accuracy bonus. Clients cannot fabricate accuracy: the offset is
 * derived from the server's own `now` at request time.
 */
export function applyReelStop(match, seat, reelIndex, now = Date.now(), expectedSpin = null) {
  if (seat !== "player1" && seat !== "player2") {
    return { ok: false, error: "Caller is not a participant", status: 403 };
  }
  if (!isSpinStatus(match.status)) {
    return { ok: false, error: "Match is not in a spin round", status: 400 };
  }
  // Round-identity guard: the caller echoes the spin number it believes
  // is live (from its last /status poll). If it no longer matches, the
  // round already advanced (e.g. the opponent's last stop resolved it)
  // and this stop is stale — it must NOT apply to the next round's
  // fresh board.
  if (expectedSpin != null && Number(expectedSpin) !== Number(match.currentSpin)) {
    return {
      ok: false,
      error: "Round has already advanced",
      status: 409,
    };
  }
  const n = Number(reelIndex);
  if (!Number.isInteger(n) || n < 0 || n >= REELS_PER_ROUND) {
    return {
      ok: false,
      error: `reelIndex must be an integer in [0, ${REELS_PER_ROUND - 1}]`,
      status: 400,
    };
  }
  if (match.roundDeadline && new Date(match.roundDeadline).getTime() <= now) {
    return { ok: false, error: "Round time has expired", status: 400 };
  }

  const inputsKey = seat === "player1" ? "p1CurrentInputs" : "p2CurrentInputs";
  const state = match[inputsKey];
  if (!state) {
    return { ok: false, error: "Round has not started", status: 400 };
  }
  if (state.boardLocked) {
    return { ok: false, error: "Board is already locked", status: 409 };
  }
  const stopped = Array.isArray(state.reelsStopped) ? state.reelsStopped : [];
  if (stopped.includes(n)) {
    return { ok: false, error: `Reel ${n + 1} is already stopped`, status: 409 };
  }

  const reelsStopped = [...stopped, n].sort((a, b) => a - b);
  const openedAt =
    Number(state.openedAt) ||
    new Date(match.roundDeadline).getTime() - ROUND_DEADLINE_MS;
  const offsetMs = Math.max(0, now - openedAt);
  return {
    ok: true,
    match: {
      ...match,
      [inputsKey]: {
        ...state,
        reelsStopped,
        stopOffsets: { ...(state.stopOffsets || {}), [n]: offsetMs },
        boardLocked: reelsStopped.length >= REELS_PER_ROUND,
      },
    },
  };
}

/** Auto-stop every remaining reel for a seat (10s deadline expiry).
 *  Marks the seat `autoStopped` and locks their board. No stop offsets
 *  are recorded for the auto-stopped reels → they score Normal (+0).
 *  Pure. */
export function autoStopReels(match, seat) {
  const inputsKey = seat === "player1" ? "p1CurrentInputs" : "p2CurrentInputs";
  const state = match[inputsKey];
  if (!state || state.boardLocked) return match;
  return {
    ...match,
    [inputsKey]: {
      ...state,
      reelsStopped: [0, 1, 2].slice(0, REELS_PER_ROUND),
      autoStopped: true,
      boardLocked: true,
    },
  };
}

/** True when BOTH boards are locked — the round can be resolved. */
export function canResolveRound(match) {
  return (
    isSpinStatus(match.status) &&
    Boolean(match.p1CurrentInputs && match.p1CurrentInputs.boardLocked) &&
    Boolean(match.p2CurrentInputs && match.p2CurrentInputs.boardLocked)
  );
}

/**
 * Compute a player's FULL round score from their locked board state:
 * symbol score (8-line evaluation) + stop-accuracy bonus.
 *
 *   {
 *     ...evaluateBoard,     // winningLines / lineCount / multiplier / baseScore / symbolScore
 *     stopBonus,            // sum of per-reel accuracy bonuses
 *     accuracyByReel,       // [{ reel, accuracy, bonus }] — 'perfect'|'good'|'normal'
 *     totalScore,           // symbolScore + stopBonus
 *   }
 *
 * Pure + deterministic: given the same reels + stopOffsets, the score is
 * always identical. Accuracy is scored PER REEL from the recorded stop
 * offsets: a reel with an offset was stopped manually (scored by its
 * timing); a reel WITHOUT one was auto-stopped by the 10s deadline
 * (Normal, +0). The board-level `autoStopped` flag is deliberately NOT
 * used for scoring — a player who manually stopped some reels keeps
 * those accuracy bonuses even if the deadline auto-stopped the rest.
 */
export function scoreBoard({ reels, symbols, stopOffsets = {} }) {
  const board = evaluateBoard({ reels, symbols });
  let stopBonus = 0;
  const accuracyByReel = [];
  for (let i = 0; i < REELS_PER_ROUND; i += 1) {
    const offset = stopOffsets && stopOffsets[i];
    // `!= null` (not truthy) so an offset of exactly 0ms still counts.
    const accuracy = offset != null ? stopAccuracyForOffset(offset) : "normal";
    const bonus = stopBonusForAccuracy(accuracy);
    accuracyByReel.push({ reel: i, accuracy, bonus });
    stopBonus += bonus;
  }
  return {
    ...board,
    stopBonus,
    accuracyByReel,
    totalScore: board.symbolScore + stopBonus,
  };
}

/**
 * Compute the VIEWER-VISIBLE current round score from the viewer's
 * own round inputs (server-authoritative, served by the status route):
 *
 *   • board LOCKED → the full `scoreBoard` snapshot (symbol score +
 *     stop bonuses) — the viewer sees their own final score while
 *     waiting for the opponent.
 *   • board LIVE   → a PARTIAL snapshot: only the stop-accuracy
 *     bonuses earned so far. The symbol score stays hidden until the
 *     board locks, so the reveal keeps its payoff.
 *   • no reels yet (round not opened / finished) → null.
 *
 * The opponent's inputs are never touched — the round result stays
 * hidden until the round actually resolves (see `buildRoundResult`).
 * Pure + deterministic: clients can only ever READ this score, never
 * submit or alter it.
 */
export function viewerRoundScoreSnapshot({ inputs, symbols }) {
  if (!inputs || !Array.isArray(inputs.reels)) return null;
  if (inputs.boardLocked) {
    const full = scoreBoard({
      reels: inputs.reels,
      symbols,
      stopOffsets: inputs.stopOffsets || {},
    });
    return {
      locked: true,
      totalScore: full.totalScore,
      symbolScore: full.symbolScore,
      stopBonus: full.stopBonus,
      lineCount: full.lineCount,
      multiplier: full.multiplier,
      accuracyByReel: full.accuracyByReel,
    };
  }
  const stopped = Array.isArray(inputs.reelsStopped) ? inputs.reelsStopped : [];
  const accuracyByReel = stopped.map((i) => {
    const offset = inputs.stopOffsets && inputs.stopOffsets[i];
    // `!= null` so an offset of exactly 0ms still counts as a stop.
    const accuracy = offset != null ? stopAccuracyForOffset(offset) : "normal";
    return { reel: i, accuracy, bonus: stopBonusForAccuracy(accuracy) };
  });
  const stopBonus = accuracyByReel.reduce((sum, a) => sum + a.bonus, 0);
  return {
    locked: false,
    totalScore: stopBonus,
    symbolScore: 0,
    stopBonus,
    lineCount: 0,
    multiplier: 1,
    accuracyByReel,
  };
}

/** Decide the round winner from the two players' total scores.
 *  Higher score wins; equal scores → 'draw'. */
export function decideRoundWinner(score1, score2) {
  const a = Number(score1) || 0;
  const b = Number(score2) || 0;
  if (a > b) return RESULT.PLAYER1;
  if (b > a) return RESULT.PLAYER2;
  return RESULT.DRAW;
}

/** Decide the MATCH result after all rounds: most rounds won wins;
 *  tied rounds-won is broken by aggregate points (p1Score/p2Score);
 *  still tied → 'draw'. Pure — the store maps seats to clerkIds. */
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

/** Build the `slots_pvp_rounds` history-row payload for a resolved
 *  round: both players' full scoring snapshots + round winner. The
 *  server recomputes the score from the locked boards at resolve —
 *  clients never submit scores. */
export function buildRoundResult(match, symbols) {
  const spinNumber = spinNumberForStatus(match.status);
  const p1 = match.p1CurrentInputs || {};
  const p2 = match.p2CurrentInputs || {};
  const s1 = scoreBoard({
    reels: p1.reels,
    symbols,
    stopOffsets: p1.stopOffsets,
  });
  const s2 = scoreBoard({
    reels: p2.reels,
    symbols,
    stopOffsets: p2.stopOffsets,
  });
  return {
    matchId: match.id,
    spinNumber,
    player1Inputs: {
      reelsStopped: Array.isArray(p1.reelsStopped) ? p1.reelsStopped : [],
      autoStopped: Boolean(p1.autoStopped),
    },
    player2Inputs: {
      reelsStopped: Array.isArray(p2.reelsStopped) ? p2.reelsStopped : [],
      autoStopped: Boolean(p2.autoStopped),
    },
    player1Result: {
      reels: p1.reels || null,
      winningLines: s1.winningLines,
      lineCount: s1.lineCount,
      multiplier: s1.multiplier,
      baseScore: s1.baseScore,
      symbolScore: s1.symbolScore,
      stopBonus: s1.stopBonus,
      accuracyByReel: s1.accuracyByReel,
      totalScore: s1.totalScore,
    },
    player2Result: {
      reels: p2.reels || null,
      winningLines: s2.winningLines,
      lineCount: s2.lineCount,
      multiplier: s2.multiplier,
      baseScore: s2.baseScore,
      symbolScore: s2.symbolScore,
      stopBonus: s2.stopBonus,
      accuracyByReel: s2.accuracyByReel,
      totalScore: s2.totalScore,
    },
    player1AutoSpun: Boolean(p1.autoStopped),
    player2AutoSpun: Boolean(p2.autoStopped),
    spinPointsPlayer1: s1.totalScore,
    spinPointsPlayer2: s2.totalScore,
    roundWinner: decideRoundWinner(s1.totalScore, s2.totalScore),
  };
}

/**
 * Plan the state AFTER a round resolves. Signals `finished` when:
 *   * the match is NOT in a spin round, OR
 *   * round MAX_ROUNDS just resolved (best-of-5 hard cap), OR
 *   * a player just reached ROUNDS_TO_WIN (3) round wins — per user
 *     spec the match ends IMMEDIATELY, the remaining rounds are not
 *     played.
 * Otherwise returns the next spin round's status / currentSpin /
 * deadline / fresh per-player round state.
 *
 * `tallies` carries the POST-round rounds-won counts ({ roundsWonPlayer1,
 * roundsWonPlayer2, p1Score, p2Score }) computed by the caller (the
 * server store) from the just-resolved round. When omitted (pure
 * callers) it falls back to the match row's own counts — which only
 * reflect already-credited rounds, so an early finish still requires
 * the caller to pass the post-round tally.
 * Pure — the server store persists the plan.
 */
export function planAdvanceAfterResolve({
  match,
  symbols,
  tallies = null,
  now = Date.now(),
}) {
  const spinNumber = spinNumberForStatus(match.status);
  if (spinNumber === null) return { finished: true };

  // First-to-ROUNDS_TO_WIN check (per user spec). Falls back to the
  // match's pre-round counts when the caller didn't pass the post-round
  // tally — under the normal flow those can't reach ROUNDS_TO_WIN
  // before the round that would make it so, so the caller MUST pass
  // `tallies` for the early finish to trigger.
  const r1 =
    Number(tallies?.roundsWonPlayer1 ?? match.roundsWonPlayer1) || 0;
  const r2 =
    Number(tallies?.roundsWonPlayer2 ?? match.roundsWonPlayer2) || 0;
  const matchDecided = r1 >= ROUNDS_TO_WIN || r2 >= ROUNDS_TO_WIN;

  if (matchDecided || spinNumber >= MAX_ROUNDS) {
    return {
      finished: true,
      status: MATCH_STATUS.FINISHED,
      endedAt: new Date(now),
    };
  }

  const nextSpin = spinNumber + 1;
  const deadline = new Date(now + ROUND_DEADLINE_MS);
  const open = openSpinState({
    matchId: match.id,
    spinNumber: nextSpin,
    symbols,
    deadline,
    openedAt: now,
  });
  return {
    finished: false,
    status: statusForSpinNumber(nextSpin),
    currentSpin: nextSpin,
    roundDeadline: deadline,
    p1CurrentInputs: open.p1CurrentInputs,
    p2CurrentInputs: open.p2CurrentInputs,
  };
}
