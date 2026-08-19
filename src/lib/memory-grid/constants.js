// src/lib/memory-grid/constants.js
//
// Shared constants + pattern generation + outcome resolution for the
// Memory Grid PvP match system. Built as a parallel to
// `src/lib/mines-pvp/constants.js` so the lobby + match flow shares
// the same shape (stake presets / round timer / status enum /
// advisory-lock namespace / RESULT enum) while the game logic is
// memory-specific (grid pattern recall).
//
// Determinism: every round's pattern derives from the match's random
// SERVER seed via SHA-256 (see src/lib/memory-grid/seeds.js) — both
// players are guaranteed the exact same grid per round, the client
// never generates or supplies the pattern, and the post-match seed
// reveal makes every round independently verifiable.
//
// Game rules (pure pattern recall — no questions, quizzes,
// multiple-choice, or symbols):
//   * A match is EXACTLY 5 rounds. Each round has a fixed grid size
//     and a fixed number of "active" (lit) tiles:
//         Round 1: 3×3 grid,  3 active tiles, 2.5s memorize
//         Round 2: 4×4 grid,  5 active tiles, 3.0s memorize
//         Round 3: 4×4 grid,  7 active tiles, 3.0s memorize
//         Round 4: 5×5 grid, 10 active tiles, 3.5s memorize
//         Round 5: 5×5 grid, 14 active tiles, 4.0s memorize
//   * If the 5 rounds end with EXACTLY equal TOTAL cumulative round
//     scores, a SIXTH TIEBREAK round is dealt — a harder grid
//     (6×6, 18 active tiles, 4.0s memorize) — and the match is
//     decided by who scores higher on it. If that round is ALSO a
//     tie, the match is a DRAW and each player is refunded 95% of
//     their stake (5% rake per side — the tie-breaker fee).
//   * Every round has exactly two phases, played by BOTH players
//     SIMULTANEOUSLY (a competitive race — nobody takes turns, and
//     the SAME server-generated pattern is used for both):
//         PHASE 1 — MEMORIZE: the grid is revealed with the active
//         tiles lit for the round's memorize duration. Both players
//         see the same pattern at the same time.
//         PHASE 2 — RECONSTRUCT: the grid goes dark and each player
//         taps the tiles they remember on their OWN blank grid. A
//         player can submit as soon as they finish — they then see
//         "Waiting for opponent" with their grid frozen while the
//         other player finishes. Once BOTH players have submitted
//         (or been AFK auto-locked), the round resolves.
//   * Round resolution: the higher round score wins the round (+1
//     rounds-won — a display/tiebreak tally), a tie awards nobody.
//     After round 5 the MATCH winner is the player with the higher
//     TOTAL cumulative round score (each round scores /100). Exactly
//     equal totals → the TIEBREAK round (round 6, harder grid) is
//     dealt instead of finishing; whoever scores higher on it wins.
//     A tiebreak round that ALSO ties → DRAW — each player refunded
//     95% of their stake (5% rake per side; never an invented
//     winner).
//   * Round scoring (max 100 per round, accuracy-dominant):
//         Final Score = Accuracy Score × Speed Multiplier, clamped to
//         [0, 100]. Accuracy Score = % of grid cells reconstructed
//         correctly. Speed tiers (fraction of the reconstruct window
//         elapsed): very fast ≤25% ×1.20 · fast ≤50% ×1.15 · average
//         ≤75% ×1.10 · slow <100% ×1.05 · very slow ≥100% ×1.00.
//         Every round uses the SAME 0..100 scale — there are no
//         round-number multipliers or growing maximums.
//   * The active-tile pattern is server-authoritative and hidden
//     from every client except during its own memorize phase (and
//     from both clients once the match finishes, for the reveal).
//
// Payout (mirrors Mines Duel):
//   Winner: own stake back + 90% of loser's stake (1.9× total)
//   Loser:  loses entire stake
//   House:  10% rake on loser's stake only
//   Draw:   both refunded, no rake — EXCEPT a tiebreak-round draw
//           (equal totals after the 6th round): each player is
//           refunded 95% of their stake (5% rake per side → 10% of
//           the pot total, matching the house take on a winner).
//           Mirrors keno-pvp's OVERTIME_DRAW_FEE_PCT.

// ── Round configuration ─────────────────────────────────────────────
// A match is exactly 5 rounds. Index by (roundNumber - 1). The grid
// grows and the pattern gets denser every round, so memorization
// genuinely gets harder.
//   gridSize    — the N×N grid dimensions (N×N total tiles).
//   activeCount — how many tiles are lit during memorize. (There is
//                 no pick limit on reconstruction — a player may
//                 select any number of tiles up to the full grid.)
//   memorizeMs  — how long the pattern stays visible (milliseconds).
export const ROUND_CONFIGS = [
  { roundNumber: 1, gridSize: 3, activeCount: 3, memorizeMs: 2500 },
  { roundNumber: 2, gridSize: 4, activeCount: 5, memorizeMs: 3000 },
  { roundNumber: 3, gridSize: 4, activeCount: 7, memorizeMs: 3000 },
  { roundNumber: 4, gridSize: 5, activeCount: 10, memorizeMs: 3500 },
  { roundNumber: 5, gridSize: 5, activeCount: 14, memorizeMs: 4000 },
];

export const ROUNDS_PER_MATCH = ROUND_CONFIGS.length; // 5 regular rounds

// The TIEBREAK round — the 6th round, dealt ONLY when the 5 regular
// rounds end with exactly equal TOTAL cumulative scores. A harder
// grid than round 5: 6×6 (36 tiles) with 18 lit and the same 4.0s
// memorize window, so there is genuinely more to remember in the
// same time. Whoever scores higher on it wins the match; a tie on
// this round is a DRAW (95% refund each — see OVERTIME_DRAW_FEE_PCT).
export const TIEBREAK_CONFIG = {
  roundNumber: 6,
  gridSize: 6,
  activeCount: 18,
  memorizeMs: 4000,
};

export const TIEBREAK_ROUND_NUMBER = TIEBREAK_CONFIG.roundNumber; // 6

// Per-round config lookup. Returns the TIEBREAK_CONFIG for round 6
// and clamps defensively to [1, TIEBREAK_ROUND_NUMBER] for any other
// out-of-range round number (should never happen — the match
// resolves after the tiebreak round).
export function roundConfig(roundNumber) {
  const n = Number(roundNumber) || 1;
  if (n >= TIEBREAK_ROUND_NUMBER) return TIEBREAK_CONFIG;
  return ROUND_CONFIGS[Math.min(Math.max(n, 1), ROUNDS_PER_MATCH) - 1];
}

// ── Phase state machine ─────────────────────────────────────────────
// Every round has exactly three phases, per player:
//   MEMORIZE     — the pattern is revealed to BOTH players for the
//                  round's memorizeMs window.
//   RECONSTRUCT  — the pattern hides; each player taps the tiles they
//                  remember on their own grid; selection locks at
//                  submission (or the reconstruct deadline) and is
//                  scored.
//   RESULT       — both players have submitted; the round snapshot
//                  (correct pattern + both reconstructions + scores)
//                  is shown to BOTH players for RESULT_WINDOW_MS,
//                  then the next round opens (or the match finishes
//                  after round 5). Submissions are locked — nobody
//                  can modify their reconstruction.
// Stored on `memory_grid_matches.phase`. Play is SIMULTANEOUS (no
// turns), so `status='active'` + `phase` fully describe the game for
// both players at once.
export const PHASES = Object.freeze({
  MEMORIZE: "memorize",
  RECONSTRUCT: "reconstruct",
  RESULT: "result",
});

// How long the round-result screen stays up after both players have
// submitted (milliseconds). Long enough for both clients to poll the
// snapshot (the 1.5s status poll + socket broadcast), short enough
// that the match keeps moving. The server auto-advances to the next
// round's memorize phase (or to `finished` after round 5) once this
// window elapses.
export const RESULT_WINDOW_MS = 5000;

// ── Per-phase windows ───────────────────────────────────────────────
// How long the RECONSTRUCT phase lasts (the player gets this long to
// tap tiles after the pattern hides). Mirrors mines-pvp's
// ROUND_TIMER_SECONDS shape. Memorize durations come from
// ROUND_CONFIGS (they vary per round).
export const RECONSTRUCT_TIMER_SECONDS = 15;
export const RECONSTRUCT_DEADLINE_MS = RECONSTRUCT_TIMER_SECONDS * 1000;

// ── Authoritative phase timing helpers ─────────────────────────────
// The match row's `roundDeadline` is an ABSOLUTE server timestamp set
// as (phaseStart + duration) when each phase opens. All phase timing
// derives from it: both clients receive the same absolute timestamps
// (synchronized countdowns), the client clock is never trusted for
// scoring, and the official phase start is recovered as
// roundDeadline − phaseDuration.

// Has the OFFICIAL reconstruct phase begun for the current round?
// True once the server is in reconstruct, OR once the memorize
// deadline has passed — the pattern-hide instant is the authoritative
// reconstruct start, regardless of when a poll discovers it. A
// submission is only legal after this returns true (submitting while
// the pattern is still being revealed is rejected).
export function reconstructionStarted({ phase, deadlineMs, nowMs }) {
  if (phase === PHASES.RECONSTRUCT) return true;
  if (phase === PHASES.MEMORIZE) {
    // Explicit null/undefined guards — Number(null) would coerce to 0.
    const deadline =
      deadlineMs === null || deadlineMs === undefined
        ? Number.NaN
        : Number(deadlineMs);
    const now = nowMs === null || nowMs === undefined ? Number.NaN : Number(nowMs);
    return Number.isFinite(deadline) && Number.isFinite(now) && now >= deadline;
  }
  return false;
}

// The reconstruct-phase deadline = the authoritative reconstruct start
// (the memorize deadline) + the reconstruct window. Measured from the
// SAME absolute instant for both players — a poll that discovers the
// transition late never shifts the window.
export function reconstructDeadlineFromStart(startMs, windowMs) {
  // Explicit null/undefined guard (Number(null) would coerce to 0).
  const start =
    startMs === null || startMs === undefined ? Number.NaN : Number(startMs);
  if (!Number.isFinite(start)) return null;
  const window = Number(windowMs);
  // Only a positive window is meaningful — 0 / null / NaN fall back to
  // the default reconstruct window (a zero-length window is degenerate).
  const duration = Number.isFinite(window) && window > 0 ? window : RECONSTRUCT_DEADLINE_MS;
  return new Date(start + duration);
}

// Absolute ISO timestamp when the CURRENT phase started (null when no
// phase is live). roundDeadlineMs = phase start + phase duration, so
// the start is roundDeadline − duration. Sent to BOTH players so their
// countdowns are anchored to the same server timestamps.
export function phaseStartedAt({ phase, roundDeadlineMs, phaseDurationMs }) {
  if (!phase) return null;
  // Note: Number(null) would coerce to 0 — treat null/undefined as
  // "no deadline" explicitly.
  const deadline =
    roundDeadlineMs === null || roundDeadlineMs === undefined
      ? Number.NaN
      : Number(roundDeadlineMs);
  if (!Number.isFinite(deadline)) return null;
  // Same explicit null/undefined guard for the duration (Number(null)
  // would coerce to 0 and silently "succeed").
  const duration =
    phaseDurationMs === null || phaseDurationMs === undefined
      ? Number.NaN
      : Number(phaseDurationMs);
  if (!Number.isFinite(duration)) return null;
  return new Date(deadline - duration).toISOString();
}

// ── Stake matchmaking constants ─────────────────────────────────────
// STAKE_PRESETS mirrors mines-pvp / blackjack-pvp so the lobby UI
// renders the same chip row. The actual bet is still free-form
// validated against MIN_STAKE / MAX_STAKE.
export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MIN_STAKE = 1;
export const MAX_STAKE = 1000000;

// ── House fee (per spec: 10% rake on the LOSER's stake) ─────────────
// Same split as Mines Duel: the winner takes 90% of the loser's
// stake, house keeps 10% of it. Distinct from roulette-pvp
// (HOUSE_FEE_PCT = 0.025).
export const HOUSE_FEE_PCT = 0.1;
export const WINNER_RATIO = 0.9; // 90% of the loser's stake
export const HOUSE_RATIO = 0.1; // 10% of the loser's stake

// ── Tiebreak-draw fee (mirrors keno-pvp's OVERTIME_DRAW_FEE_PCT) ────
// Applied ONLY when the 6th tiebreak round ALSO ties (equal totals
// after round 6): each player is refunded 95% of their stake (5%
// taken from each side — 10% of the pot total, matching the house
// take on a winner). Normal draws (which can no longer occur — the
// tiebreak round always fires first) stay a full refund with no
// rake.
export const OVERTIME_DRAW_FEE_PCT = 0.05;

// ── Status state machine ────────────────────────────────────────────
// Five states (SIMULTANEOUS play — no turns). The host creates a
// match (waiting → joins from lobby), player2 joins (ready → 3s
// banner → active), and both players run memorize → reconstruct
// together (the `phase` column distinguishes the two phases). Once
// BOTH players have submitted a round resolves and the next round
// opens; after round 5 → finished. `cancelled` is reachable from any
// non-terminal state when the host leaves before player2 joins.
export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  ACTIVE: "active",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match is still in progress (not yet terminal).
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.ACTIVE,
]);

// States where a `submitReconstruction` action is accepted. `READY`
// is intentionally excluded (brief auto-transition window after both
// players join). `WAITING` is excluded (no opponent yet).
// `FINISHED` / `CANCELLED` are terminal.
export const SUBMIT_STATES = new Set([MATCH_STATUS.ACTIVE]);

// Terminal states. Once a match reaches one of these, no further
// state transitions are allowed.
export const TERMINAL_STATES = new Set([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

// Auto-advance window between player2 joining and the first turn
// starting. Server-authoritative 3-second "Get ready" banner.
export const READY_WINDOW_MS = 3000;

// Auto-advance window between FINISHED and the client being
// allowed to navigate back to the lobby.
export const FINISHED_GRACE_MS = 5000;

// ── Stake-key advisory-lock namespace for `createOrJoin` matchmaking
// Stable ASCII-pack to keep the global pg_advisory_xact_lock
// keyspace partitioned so other features can't accidentally
// collide with memory-grid matchmaking. "MGVD" packed: M=0x4D,
// G=0x47, V=0x56, D=0x44. Bitwise-AND with 0x7FFFFFFF to keep the
// resulting 32-bit signed integer positive.
export const MEMORY_GRID_LOCK_NAMESPACE = 0x4d475644 & 0x7fffffff;

// ── Result string constants ─────────────────────────────────────────
// 'player1' | 'player2' | 'draw' | null. Stored in
// `memory_grid_matches.result` and `memory_grid_rounds.round_winner`.
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
});

// ── Round winner helper ─────────────────────────────────────────────
// Given a completed round's reconstruction scores, decide who won
// the round: higher score wins, equal → draw (no point awarded).
// Pure function so both the server store and the tests share one
// truth. Returns one of RESULT.PLAYER1 | RESULT.PLAYER2 | RESULT.DRAW.
export function roundWinnerFromScores(p1RoundScore, p2RoundScore) {
  const p1 = Number(p1RoundScore) || 0;
  const p2 = Number(p2RoundScore) || 0;
  if (p1 > p2) return RESULT.PLAYER1;
  if (p2 > p1) return RESULT.PLAYER2;
  return RESULT.DRAW;
}

// ── Match winner helper ─────────────────────────────────────────────
// Given a completed match's TOTAL cumulative round scores (each
// round scores /100, so a 5-round match totals up to 500), decide
// the MATCH winner: the higher total wins; EXACTLY equal totals →
// draw, and the wager settles with the existing PvP tie pattern
// (full refund for both — never a random/invented winner). Pure
// function so the server store (resolveMatch) and the tests share
// one truth. Returns one of RESULT.PLAYER1 | RESULT.PLAYER2 |
// RESULT.DRAW.
export function matchWinnerFromTotals(p1Total, p2Total) {
  const p1 = Number(p1Total) || 0;
  const p2 = Number(p2Total) || 0;
  if (p1 > p2) return RESULT.PLAYER1;
  if (p2 > p1) return RESULT.PLAYER2;
  return RESULT.DRAW;
}

// ── Seeded PRNG (mulberry32 clone — mirrors plinko-pvp's physics.js) ─
// Tiny, fast, deterministic 32-bit PRNG. Same seed → same sequence,
// every time. Used ONLY by generatePattern when a derived pattern
// seed is provided (see src/lib/memory-grid/seeds.js). Kept inline
// here (not imported from plinko) so memory-grid stays self-contained
// and crypto-free for the client bundle.
function mulberry32(seed) {
  let a = Number(seed) >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Pattern generator ───────────────────────────────────────────────
// Returns the round's server-authoritative pattern:
//   { size: 3, total: 9, active: [0, 4, 8] }
// where `active` holds `activeCount` distinct tile indices in
// [0, total) — row-major (tile 0 = top-left, tile total-1 =
// bottom-right). Indices are chosen uniformly without replacement.
//
// DETERMINISTIC BY DEFAULT: the server always passes the round's
// derived `seed` (see src/lib/memory-grid/seeds.js), so the SAME
// match + round always produces the SAME pattern — both players are
// guaranteed the exact same grid, and the post-match seed reveal
// makes every pattern independently verifiable. The seed is
// SERVER-authoritative: the client never supplies it and never
// generates the pattern. When `seed` is omitted (e.g. unit tests
// probing distribution), a Math.random fallback is used instead.
//
// The server keeps this hidden: /status only reveals `active` to the
// player whose turn it is during THEIR memorize phase (and to both
// players once the match finishes).
export function generatePattern(roundNumber, { seed } = {}) {
  const cfg = roundConfig(roundNumber);
  const total = cfg.gridSize * cfg.gridSize;
  const rand = seed !== undefined && seed !== null
    ? mulberry32(seed)
    : Math.random;
  const indices = [];
  for (let i = 0; i < total; i += 1) indices.push(i);
  // Fisher-Yates shuffle (in-place, unbiased), then take the first
  // activeCount indices.
  for (let i = total - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const active = indices.slice(0, cfg.activeCount).sort((a, b) => a - b);
  return {
    size: cfg.gridSize,
    total,
    active,
  };
}

// The set of active tile indices for a pattern. Returns an empty Set
// for malformed input (defensive — never throws). Strings are
// rejected outright (a tampered pattern shouldn't coerce) — only
// real non-negative integers count.
export function activeSet(pattern) {
  const set = new Set();
  if (!pattern || !Array.isArray(pattern.active)) return set;
  for (const i of pattern.active) {
    if (typeof i !== "number") continue;
    if (Number.isInteger(i) && i >= 0) set.add(i);
  }
  return set;
}

// ── Reconstruction assessment (authoritative full-grid scoring) ──────
// The server compares the player's ENTIRE reconstructed grid against
// the authoritative pattern — every cell, not just the active ones.
// The player's reconstruction is the set of tiles they picked; each
// grid cell is then one of:
//   TRUE POSITIVE (TP)    — active tile the player correctly picked
//   TRUE NEGATIVE (TN)    — inactive tile the player correctly left
//                           unpicked
//   FALSE POSITIVE (FP)   — inactive tile the player wrongly picked
//   FALSE NEGATIVE (FN)   — active tile the player missed
// False positives count as ERRORS (they forfeit the true-negative
// count for that cell), so a player who selects every tile can never
// score high — the more inactive tiles they wrongly pick, the lower
// their accuracy.
//
// Returns:
//   {
//     total,            // grid cells (size²)
//     hits,             // TP — active tiles correctly picked
//     misses,           // FN — active tiles missed
//     falsePositives,   // FP — inactive tiles wrongly picked
//     correct,          // TP + TN — cells matching the pattern
//     incorrect,        // FP + FN — cells differing from the pattern
//     accuracy,         // correct / total (0..1)
//     accuracyPct,      // accuracy as a percentage (1dp) — this IS
//                       // the round's Accuracy Score (0..100) before
//                       // the speed multiplier is applied
//   }
//
// Duplicate picks, out-of-range indices and malformed entries are
// ignored (never throw). The FINAL round score (accuracy × speed,
// clamped to 0..100) is computed separately by computeFinalRoundScore
// — it needs the reconstruction's completion time, which this pure
// pattern-vs-picks comparison does not have.
export function assessReconstruction(picks, pattern) {
  const empty = {
    total: 0,
    hits: 0,
    misses: 0,
    falsePositives: 0,
    correct: 0,
    incorrect: 0,
    accuracy: 0,
    accuracyPct: 0,
  };
  if (!Array.isArray(picks)) return empty;

  const active = activeSet(pattern);
  const size = Number(pattern?.size);
  const total = Number.isInteger(size) && size > 0 ? size * size : 0;

  // The picked SET (duplicates are irrelevant — a tile is picked or
  // not). Indices outside the grid are invalid input, not cells.
  const picked = new Set();
  for (const p of picks) {
    const n = Number(p);
    if (Number.isInteger(n) && n >= 0 && n < total) picked.add(n);
  }

  let hits = 0; // TP
  let falsePositives = 0; // FP
  for (const i of picked) {
    if (active.has(i)) hits += 1;
    else falsePositives += 1;
  }
  const misses = active.size - hits; // FN
  const correct = hits + (total - active.size - falsePositives); // TP + TN
  const incorrect = falsePositives + misses; // FP + FN
  const accuracy = total > 0 ? correct / total : 0;

  return {
    total,
    hits,
    misses,
    falsePositives,
    correct,
    incorrect,
    accuracy,
    accuracyPct: Number((accuracy * 100).toFixed(1)),
  };
}

// ── Round scoring (accuracy-dominant, max 100 per round) ─────────────
//
// Final Score = Accuracy Score × Speed Multiplier, clamped to [0, 100].
//   * Accuracy Score  = percentage of grid cells reconstructed
//     correctly (correct / total × 100, from assessReconstruction).
//     Accuracy is the DOMINANT factor: the speed multiplier can only
//     ever add up to +20% on top, so a player with significantly
//     worse accuracy can never beat a player who remembered more —
//     even at maximum speed.
//   * Speed Multiplier = a tier derived from how quickly the player
//     completed their reconstruction relative to the round's
//     reconstruct window:
//         very fast  ≤ 25% of the window   → ×1.20 (+20%)
//         fast       ≤ 50%                 → ×1.15 (+15%)
//         average    ≤ 75%                 → ×1.10 (+10%)
//         slow       < 100%                → ×1.05 (+5%)
//         very slow  ≥ 100% (deadline/AFK) → ×1.00 (+0%)
//   * Every round uses the SAME 0..100 scale — there are NO round-
//     number multipliers and the maximum never grows for later rounds.

export const SPEED_TIER_MULTIPLIERS = Object.freeze({
  very_fast: 1.2,
  fast: 1.15,
  average: 1.1,
  slow: 1.05,
  very_slow: 1.0,
});

// Map a reconstruction's completion time (ms since the reconstruct
// phase started) to a speed tier + multiplier, relative to the round's
// reconstruct window (ms). Returns `{ tier, multiplier }`. Missing or
// non-positive window info is treated as very_slow (no bonus).
export function speedMultiplierFromCompletion(completionTimeMs, windowMs) {
  const window = Number(windowMs);
  if (!Number.isFinite(window) || window <= 0) {
    return { tier: "very_slow", multiplier: SPEED_TIER_MULTIPLIERS.very_slow };
  }
  const elapsed = Number(completionTimeMs);
  const fraction =
    Number.isFinite(elapsed) && elapsed >= 0 ? elapsed / window : 2; // unknown → very slow
  if (fraction <= 0.25) {
    return { tier: "very_fast", multiplier: SPEED_TIER_MULTIPLIERS.very_fast };
  }
  if (fraction <= 0.5) {
    return { tier: "fast", multiplier: SPEED_TIER_MULTIPLIERS.fast };
  }
  if (fraction <= 0.75) {
    return { tier: "average", multiplier: SPEED_TIER_MULTIPLIERS.average };
  }
  if (fraction < 1) {
    return { tier: "slow", multiplier: SPEED_TIER_MULTIPLIERS.slow };
  }
  return { tier: "very_slow", multiplier: SPEED_TIER_MULTIPLIERS.very_slow };
}

// The round's FINAL score — an integer in [0, 100] (persisted to
// p1_round_score / p2_round_score and used for the round-winner
// comparison):
//   accuracy (0..1) → accuracy score (0..100)
//   × speed multiplier (1.0..1.2)
//   → rounded + clamped to [0, 100]
//
// `pickedCount` (optional) is the number of tiles the player selected:
// an EMPTY reconstruction (0 picks — e.g. an AFK auto-lock) scores 0.
// Leaving the grid blank must not earn points even though the
// accuracy formula would count the true negatives; this keeps
// "do nothing" from being a viable farming strategy.
export function computeFinalRoundScore({
  accuracy,
  completionTimeMs,
  windowMs,
  pickedCount,
}) {
  if (Number(pickedCount) === 0) return 0;
  const acc = Number(accuracy);
  const accuracyScore =
    (Number.isFinite(acc) ? Math.min(1, Math.max(0, acc)) : 0) * 100;
  const { multiplier } = speedMultiplierFromCompletion(completionTimeMs, windowMs);
  const raw = accuracyScore * multiplier;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

// ── Payout calculator ───────────────────────────────────────────────
// Returns the per-side settlement numbers for a resolved match:
//
//   { stake, winnerNet, loserNet, houseFee, prizePaid, refundEach }
//
// Rules (mirrors Mines Duel):
//   DRAW:       both refunded. winnerNet = loserNet = null,
//               houseFee = 0, prizePaid = 0, refundEach = stake —
//               UNLESS `drawFeePct` is passed (tiebreak-round ties):
//               each player keeps (1 - drawFeePct) of their stake
//               and the house takes 2 × that fee (e.g. 5% per side
//               → 10% of the pot total, matching the house take on
//               a winner). Mirrors keno-pvp's computePayout.
//   PLAYER1:    player1 wins. player1 gets (stake + 0.9 * stake) =
//               1.9x stake back; player2 loses stake. House rake
//               = 0.1 * stake. prizePaid = 1.9 * stake.
//   PLAYER2:    mirror of PLAYER1.
//
// Returns NUMBER (rounded to 2dp via round2) so callers can persist
// directly to numeric(10, 2) columns.
export function computePayout({ stakeAmount, result, drawFeePct = 0 }) {
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
  const feeRate = Number(drawFeePct);
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 1) {
    throw new RangeError(
      `computePayout: drawFeePct must be in [0, 1], got ${drawFeePct}`,
    );
  }
  if (result === RESULT.DRAW) {
    const fee = round2(stake * feeRate);
    return {
      stake: round2(stake),
      winnerNet: null,
      loserNet: null,
      houseFee: round2(fee * 2),
      prizePaid: round2(0),
      refundEach: round2(stake - fee),
    };
  }
  const winnerPrize = round2(stake * WINNER_RATIO); // 90% of loser's stake
  const houseFee = round2(stake * HOUSE_RATIO); // 10% of loser's stake
  return {
    stake: round2(stake),
    // winner is refunded their own stake + 90% of the loser's stake
    winnerNet: round2(stake + winnerPrize),
    // loser loses their entire stake (net = -stake)
    loserNet: round2(-stake),
    houseFee,
    // prizePaid = the total payout to the winner (their stake back
    // + the 90% they won from the loser).
    prizePaid: round2(stake + winnerPrize),
    refundEach: null,
  };
}

// ── Format helpers ──────────────────────────────────────────────────
// Round a number to 2dp. Centralised here so the server store and
// the client UI produce identical strings.
export function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

// Re-export so the lobby + match UI can mirror the same constants
// without re-declaring them in the client.
export { PHASES as MEMORY_GRID_PHASES };
