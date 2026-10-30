// src/lib/odds.ts
//
// Pure game logic for Odds — the 1v1 SHARED-TARGET prediction duel. No DB, no
// network, no side effects, fully unit-testable. The API routes own
// persistence and settlement; both the server and the client import these
// helpers so the board and the authoritative result can never disagree.

import { coerceAiDifficulty, type AiDifficulty } from "./aiDifficulty";

// ── Rules ─────────────────────────────────────────────────────────────
//
// A match is EXACTLY FIVE ROUNDS and the number domain is the SAME 1..100 in
// every round. There is no shrinking range any more: the only thing that makes
// later rounds different is the clue.
//
// Each round:
//   1. the server draws ONE target in 1..100 (`createRound`),
//   2. both seats are shown the SAME clue derived from that target
//      (`createClue`) — informative, but never a reveal,
//   3. both seats submit their own prediction independently: an inclusive
//      RANGE (`min..max`) or ONE EXACT number,
//   4. the round resolves only when both are in (or a timeout / forfeit ends
//      the match). Only then are the target and both predictions revealed.
//
// Scoring (`scorePrediction`):
//   * exact and correct ......... 100
//   * exact and wrong ............. 0
//   * range containing target ..... max(1, round(100 / width)),
//                                   width = max - min + 1 (inclusive)
//   * range missing target ........ 0
//
// So a narrower correct range always pays at least as much as a wider one, and
// the widest possible "guaranteed hit" (1..100) is worth exactly 1 point.
//
// SECURITY MODEL — the target and the opponent's pending prediction are secret
// until the round resolves. They live in the match row's `game_state` jsonb
// (server only) and leave the server EXCLUSIVELY through `viewForPlayer`, which
// nulls the unresolved round's target and the opponent's prediction. Nothing
// else may serialise the raw state to a client.

export const TARGET_MIN = 1;
export const TARGET_MAX = 100;

/** Rounds in one match. Fixed — the match is five rounds, full stop. */
export const TOTAL_ROUNDS = 5;

/**
 * How long (ms) a round may sit HALF-submitted before the seat that already
 * locked in may claim it.
 *
 * One submission per seat per round means there is exactly one timeout case:
 * one seat called the round, the other never did. The seat that called it wins
 * by forfeit and the idle seat loses — never the other way round. Shared by the
 * pick route (which settles the claim), the sweep and the board's claim timer,
 * so those three can never drift apart.
 */
export const ROUND_TIMEOUT_MS = 120_000;

/**
 * Version stamp carried inside `game_state`.
 *
 * The previous rules (two phases: pick your own number, then predict the
 * opponent's, over a shrinking range) are not convertible to this game: they
 * have no target. Rows written by them therefore carry no `version` and are
 * handled explicitly by the routes (`isCurrentOddsState`) instead of being fed
 * to these helpers — a retired match is voided and refunded, never half-read.
 */
export const ODDS_STATE_VERSION = 2 as const;

/**
 * A clue must always leave at least this many targets standing, or it would
 * disclose the answer. Every clue format is banded so this holds for EVERY
 * target in EVERY round — the floor is a guarantee, not a best effort.
 */
export const MIN_CLUE_CANDIDATES = 5;

// ── Types ─────────────────────────────────────────────────────────────

/**
 * One seat's prediction.
 *
 * `exact` guesses a single number; `range` guesses an inclusive interval. Both
 * are expressed in the fixed 1..100 domain (TARGET_MIN..TARGET_MAX).
 */
export type OddsPrediction =
  | { kind: "exact"; value: number }
  | { kind: "range"; min: number; max: number };

/** One round, as stored server-side (target included — never send this raw). */
export type OddsRound = {
  /** 1-based round number. */
  round: number;
  /** The secret target, 1..100. Nulled by `viewForPlayer` until resolved. */
  target: number;
  /** The clue both seats see. Safe by construction (never a reveal). */
  clue: string;
  /** Each seat's prediction for THIS round (null until submitted). */
  player1Prediction: OddsPrediction | null;
  player2Prediction: OddsPrediction | null;
  /** Points each seat earned. Null until the round resolves. */
  player1Score: number | null;
  player2Score: number | null;
  /** True once both predictions were scored and the target is public. */
  resolved: boolean;
  /** Wall-clock resolution timestamp (ms), null while live. */
  resolvedAt: number | null;
};

export type OddsGameState = {
  /** Rules version — see ODDS_STATE_VERSION. */
  version: typeof ODDS_STATE_VERSION;
  /** 1-based round currently being played (1..totalRounds). */
  currentRound: number;
  totalRounds: number;
  /**
   * One entry per STARTED round, oldest first; the live round is
   * `rounds[currentRound - 1]`. Length equals `currentRound` until the match
   * ends, then equals `totalRounds`.
   */
  rounds: OddsRound[];
  /** Cumulative scores across resolved rounds. */
  p1Score: number;
  p2Score: number;
  /** null = the match ended in an exact tie (draw → both stakes refunded). */
  winner: "player1" | "player2" | null;
  gameOver: boolean;
  /** When the current round opened (ms) — drives the timeout rules. */
  roundStartedAt: number;
};

/** A round as a client may see it: the target is null until it resolves. */
export type OddsRoundView = Omit<OddsRound, "target"> & {
  target: number | null;
};

/**
 * The per-viewer view of a match. `viewForPlayer` is the ONLY function that
 * turns server state into something a client may receive.
 */
export type OddsPlayerView = Omit<OddsGameState, "rounds"> & {
  rounds: OddsRoundView[];
  /** Has the viewer locked in for the current round? */
  mySubmitted: boolean;
  /** Has the opponent locked in for the current round? */
  opponentSubmitted: boolean;
};

/** Kept as aliases so both entry points describe the same shape. */
export type InteractiveOddsState = OddsGameState;
export type PvPInteractiveOddsState = OddsGameState;

export type OddsSeat = "player1" | "player2";

// ── Input validation ──────────────────────────────────────────────────

export type PredictionParseResult =
  | { ok: true; prediction: OddsPrediction }
  | { ok: false; error: string };

function isDomainInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= TARGET_MIN &&
    value <= TARGET_MAX
  );
}

/**
 * Validate a prediction object (typically a request body).
 *
 * Accepts the canonical engine shape the board sends — `{ kind: "exact",
 * value: n }` or `{ kind: "range", min: n, max: n }` — and the older flat
 * request shape `{ exact: n }` / `{ min: n, max: n }`. Every value must be an
 * INTEGER inside TARGET_MIN..TARGET_MAX and `min <= max`. Anything else —
 * missing halves, a non-integer, 0, 101, NaN, a reversed range — is rejected
 * here rather than being scored as a miss, so a malformed request is a 400 and
 * never a silent zero.
 *
 * Both shapes must be accepted: the client's `PredictionPanel` emits `kind`
 * predictions, and an exact one carries `value` and neither `exact` nor
 * `min`/`max` — reading it as the flat shape found "no prediction at all" and
 * refused every exact call while ranges worked.
 */
export function parsePrediction(input: unknown): PredictionParseResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "A prediction is required" };
  }

  const shaped = input as {
    kind?: unknown;
    value?: unknown;
    exact?: unknown;
    min?: unknown;
    max?: unknown;
  };

  // Normalise a `kind`-tagged prediction onto the flat shape the rest of this
  // function validates. A tagged prediction that ALSO carries the other
  // shape's fields is ambiguous, and ambiguity is refused rather than guessed.
  let raw: { exact?: unknown; min?: unknown; max?: unknown };
  if (shaped.kind === "exact") {
    if (
      shaped.exact !== undefined ||
      shaped.min !== undefined ||
      shaped.max !== undefined
    ) {
      return {
        ok: false,
        error: "Send either an exact number or a range, not both",
      };
    }
    if (shaped.value === undefined || shaped.value === null) {
      return {
        ok: false,
        error: `An exact prediction must be a whole number between ${TARGET_MIN} and ${TARGET_MAX}`,
      };
    }
    raw = { exact: shaped.value };
  } else if (shaped.kind === "range") {
    if (shaped.exact !== undefined) {
      return {
        ok: false,
        error: "Send either an exact number or a range, not both",
      };
    }
    if (shaped.min === undefined || shaped.max === undefined) {
      return {
        ok: false,
        error: "A range prediction needs both a minimum and a maximum",
      };
    }
    raw = { min: shaped.min, max: shaped.max };
  } else if (shaped.kind !== undefined) {
    return {
      ok: false,
      error: 'A prediction kind must be "exact" or "range"',
    };
  } else {
    raw = shaped;
  }

  const hasExact = raw.exact !== undefined && raw.exact !== null;
  const hasRange = raw.min !== undefined || raw.max !== undefined;

  if (hasExact && hasRange) {
    return {
      ok: false,
      error: "Send either an exact number or a range, not both",
    };
  }

  if (hasExact) {
    if (!isDomainInteger(raw.exact)) {
      return {
        ok: false,
        error: `An exact prediction must be a whole number between ${TARGET_MIN} and ${TARGET_MAX}`,
      };
    }
    return { ok: true, prediction: { kind: "exact", value: raw.exact } };
  }

  if (hasRange) {
    if (raw.min === undefined || raw.max === undefined) {
      return {
        ok: false,
        error: "A range prediction needs both a minimum and a maximum",
      };
    }
    if (!isDomainInteger(raw.min) || !isDomainInteger(raw.max)) {
      return {
        ok: false,
        error: `Range bounds must be whole numbers between ${TARGET_MIN} and ${TARGET_MAX}`,
      };
    }
    if (raw.min > raw.max) {
      return {
        ok: false,
        error: "The range minimum cannot be greater than its maximum",
      };
    }
    return {
      ok: true,
      prediction: { kind: "range", min: raw.min, max: raw.max },
    };
  }

  return { ok: false, error: "A prediction is required" };
}

/** Structural validation of an already-typed prediction (defensive). */
export function normalizePrediction(
  prediction: OddsPrediction | null | undefined,
): OddsPrediction | null {
  if (!prediction || typeof prediction !== "object") return null;
  if (prediction.kind === "exact") {
    return isDomainInteger(prediction.value)
      ? { kind: "exact", value: prediction.value }
      : null;
  }
  if (prediction.kind === "range") {
    if (!isDomainInteger(prediction.min) || !isDomainInteger(prediction.max)) {
      return null;
    }
    if (prediction.min > prediction.max) return null;
    return { kind: "range", min: prediction.min, max: prediction.max };
  }
  return null;
}

/**
 * Inclusive width of a prediction: `max - min + 1` for a range, 1 for an exact
 * number. Null for anything invalid. Exported for the board readout and tests.
 */
export function predictionWidth(
  prediction: OddsPrediction | null | undefined,
): number | null {
  const p = normalizePrediction(prediction);
  if (!p) return null;
  return p.kind === "exact" ? 1 : p.max - p.min + 1;
}

// ── Scoring ───────────────────────────────────────────────────────────

/**
 * Points for one prediction against the round's target.
 *
 * The ONLY scoring function in the game — every route and both entry points
 * (AI and PvP) score through it, and it always runs on the server.
 *
 *   exact, correct          → 100
 *   exact, wrong            → 0
 *   range contains target   → max(1, round(100 / width))
 *   range misses target     → 0
 *
 * An invalid prediction (out of domain, reversed range, non-integer) scores 0 —
 * the routes reject those before they get here, so this is a backstop.
 */
export function scorePrediction(
  prediction: OddsPrediction | null | undefined,
  target: number,
): number {
  const t = Number(target);
  if (!Number.isInteger(t) || t < TARGET_MIN || t > TARGET_MAX) return 0;

  const p = normalizePrediction(prediction);
  if (!p) return 0;

  if (p.kind === "exact") return p.value === t ? 100 : 0;

  // A range that does not contain the target scores nothing, however narrow.
  if (t < p.min || t > p.max) return 0;
  const width = p.max - p.min + 1;
  // `max(1, …)` keeps a correct guess worth scoring even at full width.
  return Math.max(1, Math.round(100 / width));
}

/** Winner of the MATCH by cumulative score; null = exact tie (draw). */
export function decideMatchWinner(
  p1Score: number,
  p2Score: number,
): "player1" | "player2" | null {
  const s1 = Number(p1Score) || 0;
  const s2 = Number(p2Score) || 0;
  if (s1 > s2) return "player1";
  if (s2 > s1) return "player2";
  return null;
}

// ── Clue generation ───────────────────────────────────────────────────
//
// A clue is ONE short sentence, derived from the round's actual target, that
// both seats receive. It is deliberately vague early and progressively more
// useful later:
//
//   round 1   broad only — "Higher than X.", "Lower than X.",
//             "Somewhere in the upper half.", "Somewhere in the lower half."
//   round 2   the same four formats, with a tighter boundary band, so the
//             boundary actually varies between matches
//   round 3   higher / lower / interval, moderately informative
//   round 4   interval only, more restrictive
//   round 5   interval only, the most informative — and still ambiguous
//
// Hard rules, enforced here and asserted by the tests:
//
//   * every clue is TRUE of the target: the candidate set is computed from the
//     same predicate that produced the text, never from a hardcoded answer;
//   * a clue always leaves at least MIN_CLUE_CANDIDATES possible targets, so it
//     can never be the answer in prose;
//   * no parity / divisibility clues and no exact-number clues;
//   * the clue is a pure function of (target, round) plus an injectable random
//     source, so the same inputs always reproduce the same sentence.

export type OddsClueKind =
  | "higher"
  | "lower"
  | "upper-half"
  | "lower-half"
  | "interval";

export type OddsClue = {
  /** The one sentence both seats see. */
  text: string;
  /** Every integer in TARGET_MIN..TARGET_MAX consistent with the clue. */
  candidates: number[];
  /** Which of the allowed formats this clue used. */
  kind: OddsClueKind;
};

/** The lower half is 1..HALF_SPLIT, the upper half HALF_SPLIT+1..100. */
export const HALF_SPLIT = 50;

type ClueOption = {
  kind: OddsClueKind;
  text: string;
  test: (n: number) => boolean;
};

/**
 * How informative each round is allowed to be.
 *
 * `min`/`max` bound how many targets the clue may leave standing; the three
 * flags are the formats that round may use.
 */
type RoundCluePolicy = {
  min: number;
  max: number;
  halves: boolean;
  directionals: boolean;
  intervals: boolean;
};

const ROUND_CLUE_POLICY: RoundCluePolicy[] = [
  // Round 1 — as broad as the game gets.
  { min: 40, max: 60, halves: true, directionals: true, intervals: false },
  // Round 2 — the same broad formats, with a tighter boundary band.
  { min: 30, max: 45, halves: true, directionals: true, intervals: false },
  // Round 3 — a real narrowing, but still a wide field.
  { min: 16, max: 30, halves: false, directionals: true, intervals: true },
  // Round 4 — intervals only, more restrictive.
  { min: 9, max: 16, halves: false, directionals: false, intervals: true },
  // Round 5 — the most informative clue that is still ambiguous. The band
  // starts where round 4's ends, so the ladder never widens round to round.
  { min: 5, max: 9, halves: false, directionals: false, intervals: true },
];

function higherOption(bound: number): ClueOption {
  return { kind: "higher", text: `Higher than ${bound}.`, test: (n) => n > bound };
}

function lowerOption(bound: number): ClueOption {
  return { kind: "lower", text: `Lower than ${bound}.`, test: (n) => n < bound };
}

function intervalOption(min: number, max: number): ClueOption {
  return {
    kind: "interval",
    text: `Between ${min} and ${max}, inclusive.`,
    test: (n) => n >= min && n <= max,
  };
}

/** The half the target actually falls in — the other half would be a lie. */
function halfOptions(target: number): ClueOption[] {
  if (target <= HALF_SPLIT) {
    return [
      {
        kind: "lower-half",
        text: "Somewhere in the lower half.",
        test: (n) => n <= HALF_SPLIT,
      },
    ];
  }
  return [
    {
      kind: "upper-half",
      text: "Somewhere in the upper half.",
      test: (n) => n > HALF_SPLIT,
    },
  ];
}

/** Candidate set of one option: every in-domain number the clue admits. */
function candidatesOf(option: ClueOption): number[] {
  const candidates: number[] = [];
  for (let n = TARGET_MIN; n <= TARGET_MAX; n += 1) {
    if (option.test(n)) candidates.push(n);
  }
  return candidates;
}

/**
 * The "higher than" / "lower than" boundaries that leave between `min` and
 * `max` candidates standing and are still true of the target.
 *
 * "Higher than X" leaves TARGET_MAX - X candidates, "Lower than X" leaves
 * X - TARGET_MIN, so the boundary is solved from the wanted width rather than
 * guessed.
 */
function directionalOptions(
  target: number,
  min: number,
  max: number,
): ClueOption[] {
  const options: ClueOption[] = [];

  const higherLow = Math.max(TARGET_MIN, TARGET_MAX - max);
  const higherHigh = Math.min(target - 1, TARGET_MAX - min);
  for (let bound = higherLow; bound <= higherHigh; bound += 1) {
    options.push(higherOption(bound));
  }

  const lowerLow = Math.max(target + 1, min + TARGET_MIN);
  const lowerHigh = Math.min(TARGET_MAX, max + TARGET_MIN);
  for (let bound = lowerLow; bound <= lowerHigh; bound += 1) {
    options.push(lowerOption(bound));
  }

  return options;
}

/** Every interval of width min..max that contains the target. */
function intervalOptions(
  target: number,
  min: number,
  max: number,
): ClueOption[] {
  const options: ClueOption[] = [];
  const widthLow = Math.max(MIN_CLUE_CANDIDATES, min);
  const widthHigh = Math.min(TARGET_MAX - TARGET_MIN + 1, max);

  for (let width = widthLow; width <= widthHigh; width += 1) {
    const startLow = Math.max(TARGET_MIN, target - width + 1);
    const startHigh = Math.min(target, TARGET_MAX - width + 1);
    for (let start = startLow; start <= startHigh; start += 1) {
      options.push(intervalOption(start, start + width - 1));
    }
  }

  return options;
}

function roundIndexFor(round: number): number {
  const r = Number(round);
  if (!Number.isFinite(r)) return 0;
  const idx = Math.floor(r) - 1;
  if (idx < 0) return 0;
  return Math.min(idx, ROUND_CLUE_POLICY.length - 1);
}

/**
 * Deterministic PRNG (mulberry32) — the clue never reaches for `Math.random`,
 * so a given seed always produces the same clue.
 */
export function seededUnitSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The default seed: a stable hash of the target and the round. */
function clueSeed(target: number, round: number): number {
  return (
    (Math.imul(target, 0x9e3779b1) ^
      Math.imul(roundIndexFor(round) + 1, 0x85ebca6b)) >>>
    0
  );
}

/**
 * The clue for `target` in `round`.
 *
 * Pure: the same target, round and random draws always produce the same clue.
 * `random` is injectable so a test (or a replay) is fully deterministic; the
 * default is a seeded source derived from the target and round, so both seats
 * — and a server retry — read the same sentence.
 */
export function createClue(
  target: number,
  round: number,
  random?: () => number,
): OddsClue {
  const raw = Number(target);
  const t =
    Number.isInteger(raw) && raw >= TARGET_MIN && raw <= TARGET_MAX
      ? raw
      : TARGET_MIN;
  const policy = ROUND_CLUE_POLICY[roundIndexFor(round)];
  const next = random ?? seededUnitSource(clueSeed(t, round));

  const options: ClueOption[] = [];

  /**
   * Keep only clues that are true of the target, leave a real choice, and sit
   * inside the round's information band. `ignoreBand` exists for the halves,
   * which are broad by definition (50 candidates) but are the only legal
   * format for a mid-domain target in rounds 1–2.
   */
  const push = (option: ClueOption, ignoreBand = false) => {
    if (!option.test(t)) return;
    const candidates = candidatesOf(option);
    if (candidates.length < MIN_CLUE_CANDIDATES) return;
    if (
      !ignoreBand &&
      (candidates.length < policy.min || candidates.length > policy.max)
    ) {
      return;
    }
    options.push(option);
  };

  if (policy.halves) halfOptions(t).forEach((option) => push(option, true));
  if (policy.directionals) {
    directionalOptions(t, policy.min, policy.max).forEach((option) =>
      push(option),
    );
  }
  if (policy.intervals) {
    intervalOptions(t, policy.min, policy.max).forEach((option) =>
      push(option),
    );
  }

  // Backstop, not a path the game takes: a half is always legal in rounds 1–2,
  // and an interval of width >= MIN_CLUE_CANDIDATES always fits inside 1..100.
  if (options.length === 0) {
    const width = Math.min(
      Math.max(MIN_CLUE_CANDIDATES, policy.min),
      TARGET_MAX - TARGET_MIN + 1,
    );
    const start = Math.min(
      Math.max(TARGET_MIN, t - Math.floor(width / 2)),
      TARGET_MAX - width + 1,
    );
    options.push(intervalOption(start, start + width - 1));
  }

  const draw = next();
  const pick =
    options[Math.min(options.length - 1, Math.floor(draw * options.length))];

  return { text: pick.text, candidates: candidatesOf(pick), kind: pick.kind };
}

// ── Round / match construction ────────────────────────────────────────

/**
 * Random integer in TARGET_MIN..TARGET_MAX.
 *
 * Uses Web Crypto when the runtime has it (the Node.js server does), so a
 * staked target is not drawn from a predictable PRNG. Falls back to
 * `Math.random` only where crypto is unavailable (older/bundled runtimes).
 */
export function secureRandomInt(
  min: number = TARGET_MIN,
  max: number = TARGET_MAX,
  random?: () => number,
): number {
  const span = max - min + 1;
  const draw = random ? random() : secureUnitInterval();
  const clamped = Math.min(Math.max(draw, 0), 0.9999999999);
  return min + Math.floor(clamped * span);
}

function secureUnitInterval(): number {
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } })
    .crypto;
  if (cryptoObj?.getRandomValues) {
    const buffer = new Uint32Array(1);
    cryptoObj.getRandomValues(buffer);
    return buffer[0] / 0x1_0000_0000;
  }
  return Math.random();
}

/** A fresh round: a secret target plus the clue both seats will see. */
export function createRound(
  round: number,
  random?: () => number,
): OddsRound {
  const target = secureRandomInt(TARGET_MIN, TARGET_MAX, random);
  const { text } = createClue(target, round);
  return {
    round,
    target,
    clue: text,
    player1Prediction: null,
    player2Prediction: null,
    player1Score: null,
    player2Score: null,
    resolved: false,
    resolvedAt: null,
  };
}

export type OddsInitOptions = {
  /** Injectable RNG (tests). Defaults to secureRandomInt's crypto source. */
  random?: () => number;
};

/** A brand-new match, round 1 open. Used by BOTH PvP and AI. */
export function initPvPOddsGame(options: OddsInitOptions = {}): OddsGameState {
  return {
    version: ODDS_STATE_VERSION,
    currentRound: 1,
    totalRounds: TOTAL_ROUNDS,
    rounds: [createRound(1, options.random)],
    p1Score: 0,
    p2Score: 0,
    winner: null,
    gameOver: false,
    roundStartedAt: Date.now(),
  };
}

export function initInteractiveOddsGame(
  options: OddsInitOptions = {},
): OddsGameState {
  return initPvPOddsGame(options);
}

/**
 * True when a stored `game_state` belongs to the CURRENT rules.
 *
 * Everything else (the retired pick/predict engine, a truncated payload, a
 * string) must be treated as retired: the routes void and refund it rather
 * than reading fields that no longer exist.
 */
export function isCurrentOddsState(state: unknown): state is OddsGameState {
  if (!state || typeof state !== "object") return false;
  const s = state as Partial<OddsGameState> & { version?: unknown };
  if (s.version !== ODDS_STATE_VERSION) return false;
  if (!Array.isArray(s.rounds) || s.rounds.length === 0) return false;
  if (!Number.isInteger(s.currentRound) || s.currentRound < 1) return false;
  if (s.currentRound > s.rounds.length) return false;
  const live = s.rounds[s.currentRound - 1];
  return Boolean(
    live &&
      typeof live === "object" &&
      Number.isInteger(live.target) &&
      typeof live.clue === "string" &&
      typeof live.resolved === "boolean",
  );
}

/** The round currently being played (throws if the state is malformed). */
export function currentRoundOf(state: OddsGameState): OddsRound {
  const round = state.rounds[state.currentRound - 1];
  if (!round) throw new Error("Odds state has no current round");
  return round;
}

function seatOf(
  state: OddsGameState,
  player: OddsSeat,
): "player1Prediction" | "player2Prediction" {
  return player === "player1" ? "player1Prediction" : "player2Prediction";
}

/** Has this seat already locked in for the current round? */
export function hasSubmitted(
  state: OddsGameState,
  isPlayer1: boolean,
): boolean {
  const round = currentRoundOf(state);
  return (
    (isPlayer1 ? round.player1Prediction : round.player2Prediction) !== null
  );
}

/** This seat's pending prediction for the current round (null = not yet). */
export function predictionOf(
  state: OddsGameState,
  isPlayer1: boolean,
): OddsPrediction | null {
  const round = currentRoundOf(state);
  return isPlayer1 ? round.player1Prediction : round.player2Prediction;
}

// ── Submissions ───────────────────────────────────────────────────────

/**
 * Record one seat's prediction for the current round.
 *
 * Validates, refuses a double submission ("locked in is locked in"), and
 * reports `roundComplete` once BOTH seats have submitted. It does NOT resolve
 * — `resolveRound` is a separate, explicit step so the caller can settle the
 * match in the same transaction.
 */
export function submitPrediction(
  state: OddsGameState,
  player: OddsSeat,
  prediction: OddsPrediction,
): { updatedState: OddsGameState; roundComplete: boolean } {
  if (state.gameOver) throw new Error("Game is already over");

  const normalized = normalizePrediction(prediction);
  if (!normalized) {
    throw Object.assign(
      new Error(
        `Prediction must be a whole number or range between ${TARGET_MIN} and ${TARGET_MAX}`,
      ),
      { status: 400 },
    );
  }

  const live = currentRoundOf(state);
  const key = seatOf(state, player);
  if (live[key] !== null) {
    throw Object.assign(
      new Error("You already submitted for this round"),
      { status: 400 },
    );
  }

  const updatedRound: OddsRound = { ...live, [key]: normalized };
  const rounds = state.rounds.slice();
  rounds[state.currentRound - 1] = updatedRound;

  const roundComplete =
    updatedRound.player1Prediction !== null &&
    updatedRound.player2Prediction !== null;

  return {
    updatedState: { ...state, rounds },
    roundComplete,
  };
}

// ── Resolution ────────────────────────────────────────────────────────

/**
 * Score the live round and advance.
 *
 * Requires BOTH predictions. Scores both seats against the SAME target, marks
 * the round resolved (which is what makes the target public), accumulates the
 * scores, and then either opens the next round (fresh target + clue, clock
 * restarted) or ends the match — five rounds, winner by cumulative score,
 * exact tie = draw.
 */
export function resolveRound(state: OddsGameState): {
  round: OddsRound;
  updatedState: OddsGameState;
} {
  if (state.gameOver) throw new Error("Game is already over");
  const live = currentRoundOf(state);
  if (live.player1Prediction === null || live.player2Prediction === null) {
    throw new Error(
      "Both players must submit a prediction before the round can resolve",
    );
  }

  const player1Score = scorePrediction(live.player1Prediction, live.target);
  const player2Score = scorePrediction(live.player2Prediction, live.target);

  const resolvedRound: OddsRound = {
    ...live,
    player1Score,
    player2Score,
    resolved: true,
    resolvedAt: Date.now(),
  };

  const rounds = state.rounds.slice();
  rounds[state.currentRound - 1] = resolvedRound;

  const p1Score = state.p1Score + player1Score;
  const p2Score = state.p2Score + player2Score;
  const gameOver = state.currentRound >= state.totalRounds;

  if (!gameOver) {
    rounds.push(createRound(state.currentRound + 1));
  }

  const updatedState: OddsGameState = {
    ...state,
    rounds,
    p1Score,
    p2Score,
    currentRound: gameOver ? state.currentRound : state.currentRound + 1,
    winner: gameOver ? decideMatchWinner(p1Score, p2Score) : null,
    gameOver,
    roundStartedAt: Date.now(),
  };

  return { round: resolvedRound, updatedState };
}

// ── AI ────────────────────────────────────────────────────────────────

/**
 * What the bot predicts.
 *
 * The bot runs server-side and therefore COULD read the target; instead its
 * accuracy is capped by the tier, so every tier is honest and beatable:
 *
 *   easy   — wide (50-number) range, hits about 45% of the time
 *   normal — 20-number range, hits about 70%
 *   hard   — 10-number range, hits about 90%, and fires an exact guess 8% of
 *            the time
 *
 * `random` is injectable so the tiers stay deterministic under test.
 */
export function botPrediction(
  target: number,
  difficulty: unknown,
  random: () => number = Math.random,
): OddsPrediction {
  const tier: AiDifficulty = coerceAiDifficulty(difficulty);
  const profile =
    tier === "hard"
      ? { hitChance: 0.9, width: 10, exactChance: 0.08 }
      : tier === "easy"
        ? { hitChance: 0.45, width: 50, exactChance: 0 }
        : { hitChance: 0.7, width: 20, exactChance: 0.02 };

  if (profile.exactChance > 0 && random() < profile.exactChance) {
    return { kind: "exact", value: target };
  }

  const width = Math.min(profile.width, TARGET_MAX - TARGET_MIN + 1);
  const maxStart = TARGET_MAX - width + 1;

  let min: number;
  if (random() < profile.hitChance) {
    // Slide a window that contains the target, clamped to the domain.
    const offset = Math.floor(random() * width);
    min = Math.min(Math.max(target - offset, TARGET_MIN), maxStart);
  } else {
    // A guess that may or may not cover the target.
    min = TARGET_MIN + Math.floor(random() * (maxStart - TARGET_MIN + 1));
  }
  return { kind: "range", min, max: min + width - 1 };
}

/**
 * The bot's whole turn: build its prediction for the live round, then resolve.
 * Used by the AI route so the AI and PvP paths share one resolver and one
 * scoring rule.
 */
export function submitAIPrediction(
  state: OddsGameState,
  playerPrediction: OddsPrediction,
  difficulty?: unknown,
  random: () => number = Math.random,
): { round: OddsRound; updatedState: OddsGameState } {
  const live = currentRoundOf(state);
  const aiPrediction = botPrediction(live.target, difficulty, random);
  const { updatedState } = submitPrediction(state, "player1", playerPrediction);
  const withAi = submitPrediction(updatedState, "player2", aiPrediction);
  return resolveRound(withAi.updatedState);
}

/** Backwards-compatible alias: the AI seat is always player2. */
export function submitAIPick(
  state: OddsGameState,
  playerPrediction: OddsPrediction,
  difficulty?: unknown,
  random: () => number = Math.random,
): { round: OddsRound; updatedState: OddsGameState } {
  return submitAIPrediction(state, playerPrediction, difficulty, random);
}

// ── Per-viewer projection ─────────────────────────────────────────────

/**
 * Turn server state into what ONE seat may see.
 *
 * This is the single sanitisation chokepoint. For the unresolved round it
 * nulls the target and the opponent's prediction; my own prediction stays
 * visible so the board can show "locked in". Every resolved round is public —
 * that is the reveal. The opponent's identity is not in here at all (seats are
 * resolved by the route).
 */
export function viewForPlayer(
  state: OddsGameState,
  isPlayer1: boolean,
): OddsPlayerView {
  const liveIndex = state.currentRound - 1;

  const rounds: OddsRoundView[] = state.rounds.map((round, index) => {
    // Resolved rounds are history: target, both predictions, both scores.
    if (round.resolved || index !== liveIndex) return { ...round };
    return {
      ...round,
      target: null,
      // Show my own locked-in prediction; hide theirs.
      player1Prediction: isPlayer1 ? round.player1Prediction : null,
      player2Prediction: isPlayer1 ? null : round.player2Prediction,
      player1Score: null,
      player2Score: null,
    };
  });

  const live = state.rounds[liveIndex];
  const mySubmitted = live
    ? (isPlayer1 ? live.player1Prediction : live.player2Prediction) !== null
    : false;
  const opponentSubmitted = live
    ? (isPlayer1 ? live.player2Prediction : live.player1Prediction) !== null
    : false;

  return {
    ...state,
    rounds,
    mySubmitted,
    opponentSubmitted,
  };
}

/**
 * Human-readable label for a prediction, used by the board and the round log
 * so a range always reads the same way ("12–18", "exact 42").
 */
export function describePrediction(
  prediction: OddsPrediction | null | undefined,
): string {
  const p = normalizePrediction(prediction);
  if (!p) return "—";
  return p.kind === "exact" ? `exact ${p.value}` : `${p.min}–${p.max}`;
}
