// src/lib/trophies.js
//
// PURE TROPHY MATH — no database, no I/O.
//
// Every trophy number that can ever move a player's trophy count is produced
// here so the rule lives in exactly one place and is trivially unit-testable
// (`tests/trophy-system.test.mjs`). The server-authoritative caller is
// src/lib/trophyStore.js, which owns the transactional read → compute → write
// flow; this module only answers "given this player's trophies and this
// outcome, what is the new count?".
//
// THE RULE (Phase 1 of the trophy system):
//
//   Ranked win  = +30 trophies
//   Ranked loss = −30 trophies
//   Draw        =   0 trophies
//
//   At a MULTI-SEAT table (Crash Arena, Tower Arena, Neon Flush) the rule
//   reads by placement on a SYMMETRIC LINEAR LADDER: the best seat banks the
//   full +30, the last seat the full −30, and every seat between them pays or
//   earns its even share of the difference (a 4-seat table is +30/+10/−10/−30,
//   a 6-seat table is +30/+18/+6/−6/−18/−30).
//
//   The ladder is ZERO-SUM: the seats' nominal deltas always add up to exactly
//   0, so a table redistributes trophies rather than minting them. Tied seats
//   (Neon Flush losers on the same card count, Crash victims with no rank)
//   share the average of the ranks they occupy.
//
//   See `computePlacementTrophies` below; a two-seat table degrades to the
//   plain ±30 duel rule, which is why the 1v1 games need no special case.
//
//   * Trophies are PER GAME and INDEPENDENT — a Chess count and a Precision
//     count are separate rows and are never combined.
//   * The count can never fall below TROPHY_MIN (0).
//   * The count is capped at TROPHY_MAX (1,000) PER GAME. Reaching the cap
//     completes trophy progression for that game and unlocks that game's
//     PRESTIGE ladder (Elo, revealed at the cap).
//   * Trophies are the primary visible competitive progression and the primary
//     matchmaking signal below the cap. There are 20 eligible games, so the
//     additive overall maximum is OVERALL_TROPHY_MAX (the per-game cap times
//     the number of rated games).
//
// WHAT IS DELIBERATELY ABSENT
//   Nothing about tokens, winnings, XP, Battle Pass, streaks, cosmetics or
//   membership may influence a trophy change. The only inputs are the player's
//   current trophies and the authoritative outcome. Trophies are a result
//   measure, never an economy.
//
// GAME ELIGIBILITY
//   Trophies use EXACTLY the Elo registry (`RATED_GAMES` in src/lib/rating.js)
//   as their single source of truth, so the two systems can never disagree
//   about which games are competitive and server-authoritative. There is
//   deliberately no second game list here that could drift.
//
// PRESTIGE (derived, never stored)
//   Prestige is the endgame representation of Elo progress once a game's
//   trophies reach the cap: `prestige = max(0, elo − STARTING_RATING)`. It is a
//   pure read of the existing Elo value — no column, no writer, no history —
//   so it cannot duplicate or move a rating.

import { STARTING_RATING } from "./elo";
import {
  RATED_GAMES,
  RATING_GAME_LABELS,
  getRatingGameLabel,
  isRatedGame,
  normalizeRatingGameKey,
} from "./rating";

// ── Configurable constants ────────────────────────────────────────────────
//
// These are the ONLY tunables in the trophy system. Change them here; never
// hardcode a trophy value anywhere else.

/** Trophies a player starts with in every game (rows are created lazily). */
export const TROPHY_START = 0;

/** Trophies awarded for a ranked win. */
export const TROPHY_WIN = 30;

/** Trophies removed for a ranked loss (a negative number). */
export const TROPHY_LOSS = -30;

/** Trophies moved by a draw — deliberately zero. */
export const TROPHY_DRAW = 0;

/** Floor: a trophy count can never go below this. */
export const TROPHY_MIN = 0;

/**
 * Cap: the maximum trophy progression for ONE game. At the cap, trophy
 * progression is complete for that game and the player unlocks that game's
 * PRESTIGE ladder — Elo, tracked silently from the first rated match and
 * revealed as Prestige once the cap is reached.
 *
 * Every game caps at 1,000. With 20 eligible games the additive overall
 * maximum is OVERALL_TROPHY_MAX; see below.
 */
export const TROPHY_MAX = 1000;

/**
 * The eligible games — EXACTLY the Elo registry, re-exported so every trophy
 * surface reads one list and cannot drift from the rating system.
 */
export const TROPHY_GAMES = RATED_GAMES;

/**
 * The maximum OVERALL trophies: every eligible game capped. Trophies are
 * additive across games (never averaged), so this is simply
 * `TROPHY_MAX × games`. The Battle Pass spans this value across its 100 levels,
 * so its per-level cost moves with the size of the rated-game roster.
 */
export const OVERALL_TROPHY_MAX = TROPHY_MAX * TROPHY_GAMES.length;

/** Display labels, shared with the rating boards. */
export const TROPHY_GAME_LABELS = RATING_GAME_LABELS;

/** True when a game key is eligible for trophies (i.e. is a rated game). */
export function isTrophyGame(gameKey) {
  return isRatedGame(gameKey);
}

/** Coerce a ?game= value to a trophy game key (defaults to the first). */
export function normalizeTrophyGameKey(value) {
  return normalizeRatingGameKey(value);
}

/** Display label for a trophy game key. */
export function getTrophyGameLabel(gameKey) {
  return getRatingGameLabel(gameKey);
}

/** The three valid outcome tokens. Anything else is rejected. */
export const TROPHY_OUTCOMES = Object.freeze(["win", "loss", "draw"]);

/** True when the outcome token is one of win/loss/draw. */
export function isValidTrophyOutcome(outcome) {
  return TROPHY_OUTCOMES.includes(outcome);
}

// ── Small numeric helpers ──────────────────────────────────────────────────

/** Coerce anything to a finite integer, falling back when unusable. */
function toFiniteInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Clamp a trophy count into the legal band [TROPHY_MIN, TROPHY_MAX].
 * Non-finite input falls back to TROPHY_START (never NaN).
 */
export function clampTrophies(value) {
  const n = toFiniteInt(value, TROPHY_START);
  return Math.min(TROPHY_MAX, Math.max(TROPHY_MIN, n));
}

// ── The rule ───────────────────────────────────────────────────────────────

/**
 * The trophy delta for one authoritative outcome, from that player's point of
 * view. A draw moves nothing; an unknown outcome is a defensive no-op (callers
 * validate before reaching here).
 */
export function trophyDeltaForOutcome(outcome) {
  if (outcome === "win") return TROPHY_WIN;
  if (outcome === "loss") return TROPHY_LOSS;
  if (outcome === "draw") return TROPHY_DRAW;
  return 0;
}

/**
 * Apply one outcome to a player's current trophy count.
 *
 * Returns the pre/post count and the delta ACTUALLY applied — which differs
 * from the nominal ±30 at the bounds (a loss at 0 applies 0; a win at the cap
 * applies 0). `clamped` flags that the nominal delta was cut short.
 *
 * @param {number} current
 * @param {"win"|"loss"|"draw"} outcome
 * @returns {{ before: number, delta: number, after: number, nominalDelta: number, clamped: boolean }}
 */
export function applyTrophyDelta(current, outcome) {
  return applyTrophyChange(current, trophyDeltaForOutcome(outcome));
}

/**
 * Apply an EXPLICIT nominal delta to a player's current trophy count.
 *
 * This is what the multi-seat placement ladder uses (each seat's share of the
 * ±30 spread), while a duel goes through `applyTrophyDelta` above. Both end in
 * the same place: clamp the bound, report what actually moved.
 *
 * Returns the pre/post count and the delta ACTUALLY applied — which differs
 * from the nominal value at the bounds (a seat on the floor loses nothing; a
 * seat at the cap gains nothing). `clamped` flags that cut.
 *
 * @param {number} current
 * @param {number} nominalDelta  the ladder share, e.g. +30, +10, −10, −30
 * @returns {{ before: number, delta: number, after: number, nominalDelta: number, clamped: boolean }}
 */
export function applyTrophyChange(current, nominalDelta) {
  const before = clampTrophies(current);
  const nominal = toFiniteInt(nominalDelta, 0);
  const after = clampTrophies(before + nominal);
  return {
    before,
    after,
    delta: after - before,
    nominalDelta: nominal,
    clamped: after - before !== nominal,
  };
}

/**
 * Compute the full trophy result of one two-player ranked match.
 *
 * `result` is `"win"` when the `winner` seat genuinely won, or `"draw"` when
 * the game ended level (neither side moves). In a draw there is no winner/loser
 * distinction beyond seating, so pass either player as `winner`.
 *
 * This is the single function the trophy writer calls. Nothing about tokens,
 * wagers, XP or cosmetics can reach it.
 *
 * @param {object} params
 * @param {number} params.winnerTrophies   winner's (or seat-A's) current count
 * @param {number} params.loserTrophies    loser's (or seat-B's) current count
 * @param {"win"|"draw"} [params.result]   "win" (default) or "draw"
 * @returns {{
 *   result: "win"|"draw",
 *   winner: { before: number, delta: number, after: number, nominalDelta: number, clamped: boolean },
 *   loser:  { before: number, delta: number, after: number, nominalDelta: number, clamped: boolean },
 * }}
 */
export function computeMatchTrophies({
  winnerTrophies,
  loserTrophies,
  result = "win",
}) {
  const isDraw = result === "draw";
  return {
    result: isDraw ? "draw" : "win",
    winner: applyTrophyDelta(winnerTrophies, isDraw ? "draw" : "win"),
    loser: applyTrophyDelta(loserTrophies, isDraw ? "draw" : "loss"),
  };
}

// ── The multi-seat placement ladder ───────────────────────────────────────

/**
 * The trophy swing at the top of a table — the same value a duel win banks.
 * The bottom of the table is the exact mirror (PLACEMENT_BOTTOM).
 */
export const PLACEMENT_TOP = TROPHY_WIN;

/** The trophy swing at the bottom of a table (a negative number). */
export const PLACEMENT_BOTTOM = -TROPHY_WIN;

/**
 * The EXACT (pre-rounding) ladder share for one rank at a table of `seats`
 * human players.
 *
 * Symmetric and linear between the two bounds:
 *
 *   rank 1 → +30, rank `seats` → −30, evenly spaced in between
 *
 * so the middle of an odd table is 0 and every step is `60 / (seats − 1)`.
 * The exact values sum to zero before rounding (see `roundZeroSum`).
 *
 * A one-seat table has nothing to trade against, so it moves nothing.
 *
 * @param {number} rank   1 = best
 * @param {number} seats  number of human seats at the table
 */
export function placementDeltaForRank(rank, seats) {
  const count = toFiniteInt(seats, 0);
  if (count < 2) return 0;
  const r = Math.min(count, Math.max(1, toFiniteInt(rank, 1)));
  return (PLACEMENT_TOP * (count + 1 - 2 * r)) / (count - 1);
}

/**
 * Round EXACT per-rung deltas to integers while preserving an exact zero sum.
 *
 * The ladder is defined so its exact values add to 0; plain `Math.round` can
 * leave a residue of a point or two (or, once a tied group's average is taken,
 * a residue multiplied by that group's size), which would slowly mint — or
 * burn — trophies across a season. `weights[i]` is how many SEATS take rung i,
 * so the quantity being kept at zero is `Σ value × weight`.
 *
 * The residue is handed to UNTIED rungs, largest fractional part first (input
 * order on a tie), because moving one player by a single trophy is invisible
 * next to breaking the equality of players who finished level. Only when every
 * rung is tied does a tied group absorb it, and then only by an amount its size
 * divides evenly, so the table still settles to exactly zero.
 *
 * @param {number[]} exactValues
 * @param {number[]} [weights] seats per rung (default: one seat per rung)
 * @returns {number[]}
 */
function roundZeroSum(exactValues, weights = null) {
  const rounded = exactValues.map((value) => Math.round(value));
  if (rounded.length === 0) return rounded;

  const weightOf = (index) =>
    Array.isArray(weights) ? Math.max(1, toFiniteInt(weights[index], 1)) : 1;
  const total = () =>
    rounded.reduce((sum, value, index) => sum + value * weightOf(index), 0);

  let drift = total();

  // Pass 1 — untied rungs. An untied rung moves the total by exactly 1.
  const untied = exactValues
    .map((value, index) => ({
      index,
      fraction: Math.abs(value - Math.round(value)),
    }))
    .filter((entry) => weightOf(entry.index) === 1)
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  if (drift !== 0 && untied.length > 0) {
    const step = drift > 0 ? -1 : 1;
    for (let i = 0; drift !== 0; i += 1) {
      rounded[untied[i % untied.length].index] += step;
      drift += step;
    }
    return rounded;
  }

  // Pass 2 — the whole table is tied. A tied rung moves the total by its size,
  // so it can only absorb a residue its size divides; otherwise the drift is
  // left as-is (a fraction of a trophy on an all-tied table).
  if (drift !== 0) {
    for (let index = 0; index < rounded.length; index += 1) {
      const size = weightOf(index);
      if (drift % size !== 0) continue;
      rounded[index] -= drift / size;
      return rounded;
    }
  }

  return rounded;
}

/**
 * The integer placement ladder for a table of `seats` human players, best rank
 * first. Always sums to exactly 0.
 *
 *   2 seats → +30, −30      4 seats → +30, +10, −10, −30
 *   3 seats → +30,   0, −30 6 seats → +30, +18, +6, −6, −18, −30
 *
 * @param {number} seats
 * @returns {number[]}
 */
export function placementLadder(seats) {
  const count = toFiniteInt(seats, 0);
  if (count < 2) return [];
  const exact = [];
  for (let rank = 1; rank <= count; rank += 1) {
    exact.push(placementDeltaForRank(rank, count));
  }
  return roundZeroSum(exact);
}

/**
 * Compute the trophy result of one ranked match with MORE THAN ONE human seat —
 * the multi-seat table games (Crash Arena, Tower Arena, Neon Flush) and, in its
 * two-seat form, every 1v1 too.
 *
 * The rule is ONE symmetric linear ladder, expressed by placement rather than
 * by a flat win/loss:
 *
 *   first place  → +30 (a win)
 *   last place   → −30 (a loss)
 *   in between   → that seat's even share, e.g. +10/−10 at a 4-seat table
 *
 * `groups` describes the WHOLE finishing order, best first. Each inner array is
 * one placement group and contains the CURRENT trophy counts of the seats that
 * finished level (fewer than `seats` cards left in Neon Flush, crash victims
 * with no surviving bankroll). A tied group is awarded the AVERAGE of the ranks
 * it spans, so being level with two other players never silently rewards or
 * punishes whoever the server happened to list first.
 *
 * The ladder is zero-sum before clamping: a table redistributes trophies, and
 * clamping only ever moves less than the nominal spread at the bounds (a seat on
 * the floor loses nothing, a seat
 * at the cap gains nothing), so a match can move less than the nominal spread.
 *
 * `position`/`place` in the result are 1-based placement, and `outcome` is the
 * placement read as a result: first place is a WIN, every other seat is a LOSS
 * (a middle seat that still banked a few trophies is a loss — it did not win the
 * table). That keeps win/loss counters and win rate meaningful at every table
 * size. Draws are not part of a placement ladder.
 *
 * AI / practice seats never reach this function — callers pass human seats
 * only, and a table whose winner is a bot settles nothing at all.
 *
 * @param {object} params
 * @param {number[][]} params.groups  current counts, best placement group first
 * @returns {{
 *   result: "placement",
 *   seatCount: number,
 *   ladder: number[],
 *   nominalDeltas: number[],
 *   seats: Array<{
 *     place: number, placeTo: number, before: number, delta: number,
 *     after: number, nominalDelta: number, clamped: boolean,
 *   }>,
 * }}
 */
export function computePlacementTrophies({ groups }) {
  const normalized = (Array.isArray(groups) ? groups : [])
    .map((group) => (Array.isArray(group) ? group : []))
    .filter((group) => group.length > 0);
  const seatCount = normalized.reduce((total, group) => total + group.length, 0);

  if (seatCount < 2) {
    return {
      result: "placement",
      seatCount,
      ladder: [],
      nominalDeltas: [],
      seats: [],
    };
  }

  const ladder = placementLadder(seatCount);

  // Assign every group the rank span it occupies, then average the ladder over
  // that span (a group of one simply reads its own rank).
  let cursor = 0;
  const spans = normalized.map((group) => {
    const place = cursor + 1;
    cursor += group.length;
    return { group, place, placeTo: cursor };
  });

  const exact = spans.map((span) => {
    let total = 0;
    for (let rank = span.place; rank <= span.placeTo; rank += 1) {
      total += ladder[rank - 1];
    }
    return total / (span.placeTo - span.place + 1);
  });
  // Each rung is taken by its whole tie group, so the zero-sum check has to
  // weigh a rung by the number of seats that share it.
  const nominal = roundZeroSum(
    exact,
    spans.map((span) => span.placeTo - span.place + 1),
  );

  const seats = [];
  const nominalDeltas = [];
  spans.forEach((span, spanIndex) => {
    for (const trophies of span.group) {
      const computed = applyTrophyChange(trophies, nominal[spanIndex]);
      nominalDeltas.push(nominal[spanIndex]);
      seats.push({
        place: span.place,
        placeTo: span.placeTo,
        ...computed,
      });
    }
  });

  return {
    result: "placement",
    seatCount,
    ladder,
    nominalDeltas,
    seats,
  };
}

// ── Progression phase + Prestige (derived) ────────────────────────────────

/** True once a game's trophy progression is complete (at the cap). */
export function isTrophyComplete(trophies) {
  return clampTrophies(trophies) >= TROPHY_MAX;
}

/**
 * The player's competitive phase for one game:
 *   * "trophies" — below the cap; trophies are the primary progression and the
 *      primary matchmaking signal.
 *   * "elo"      — at the cap; Elo (and its derived Prestige) take over.
 */
export function trophyPhase(trophies) {
  return isTrophyComplete(trophies) ? "elo" : "trophies";
}

/**
 * Prestige points for one game — simply the player's Elo VALUE for that game.
 * Elo IS the Prestige ladder: it starts at STARTING_RATING (1000), is tracked
 * silently from the first rated match, and is revealed once the game's trophies
 * reach the cap, moving like chess Elo from there.
 *
 * Returns STARTING_RATING for a non-finite rating. This is a display helper
 * only; it does not gate on trophies (callers show it only once the game is
 * complete — see src/lib/prestige.js).
 */
export function prestigeFromRating(rating) {
  return toFiniteInt(rating, STARTING_RATING);
}

/**
 * The full read shape for one game's trophy progress, used by APIs and UI.
 *
 * @param {number} trophies
 * @returns {{
 *   trophies: number,
 *   maxTrophies: number,
 *   remaining: number,
 *   progressPercent: number,
 *   complete: boolean,
 *   phase: "trophies"|"elo",
 * }}
 */
export function trophyProgress(trophies) {
  const value = clampTrophies(trophies);
  const complete = value >= TROPHY_MAX;
  return {
    trophies: value,
    maxTrophies: TROPHY_MAX,
    remaining: Math.max(0, TROPHY_MAX - value),
    progressPercent: Math.round((value / TROPHY_MAX) * 100),
    complete,
    phase: complete ? "elo" : "trophies",
  };
}

/**
 * Normalize a raw `player_trophies` row into the shape every surface uses.
 * `gameKey` is always the game the row belongs to; the derived Prestige and
 * progress fields come from this game's own numbers, never a combination.
 *
 * @param {string} gameKey
 * @param {object} row raw row (snake_case or camelCase aliases both accepted)
 */
export function toTrophyShape(gameKey, row) {
  const trophies = clampTrophies(row.trophies);
  const decided = Number(row.wins ?? 0) + Number(row.losses ?? 0);
  return {
    gameKey: String(gameKey),
    label: getTrophyGameLabel(String(gameKey)),
    trophies,
    peakTrophies: clampTrophies(row.peakTrophies ?? row.peak_trophies ?? trophies),
    gamesRated: Number(row.gamesRated ?? row.games_rated ?? 0),
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    draws: Number(row.draws ?? 0),
    winRate:
      decided > 0
        ? Math.round(((Number(row.wins ?? 0) / decided) * 10000)) / 100
        : 0,
    games: decided,
    lastDelta: Number(row.lastDelta ?? row.last_delta ?? 0),
    lastTrophyAt: row.lastTrophyAt ?? row.last_trophy_at ?? null,
    ...trophyProgress(trophies),
  };
}

// ── Overall Trophies (cross-game aggregate, read-only) ────────────────────
//
// Overall Trophies is NOT a trophy count of its own. Like Overall Elo it has
// no row, no writer and no history — it is the SUM of a player's per-game
// trophy counts, computed on read from the same `player_trophies` rows the
// per-game boards rank. A player needs OVERALL_TROPHY_MIN_GAMES played games
// before an Overall Trophies value exists at all, so a one-game specialist
// cannot top the cross-game board.

/** Title of the aggregate cross-game trophy board. */
export const OVERALL_TROPHIES_LABEL = "Overall Trophies";

/**
 * How many different GAMES (played at least once) a player needs before an
 * Overall Trophies value exists. Mirrors OVERALL_MIN_GAMES for Elo.
 */
export const OVERALL_TROPHY_MIN_GAMES = 3;

/**
 * The Overall Trophies for a player, from their per-game trophy entries.
 *
 * A game counts only once the player has completed a ranked match in it
 * (`gamesRated >= 1`); an unplayed game contributes nothing and cannot help
 * a player qualify. The value is the plain SUM of those per-game counts.
 *
 * @param {Array<{ trophies?: number, gamesRated?: number }>} entries
 * @returns {{
 *   overallTrophies: number|null,
 *   gamesPlayed: number,
 *   eligible: boolean,
 * }}
 */
export function overallTrophiesFromCounts(entries) {
  const played = (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (!entry) return false;
    return Number(entry.gamesRated ?? entry.games_rated ?? 0) > 0;
  });
  if (played.length < OVERALL_TROPHY_MIN_GAMES) {
    return { overallTrophies: null, gamesPlayed: played.length, eligible: false };
  }
  const total = played.reduce(
    (sum, entry) => sum + clampTrophies(entry.trophies),
    0,
  );
  return { overallTrophies: total, gamesPlayed: played.length, eligible: true };
}

/**
 * Config snapshot — exposed so tests can assert the tunables without
 * re-deriving them, and so a future admin surface has one object to read.
 */
export const TROPHY_CONFIG = Object.freeze({
  start: TROPHY_START,
  win: TROPHY_WIN,
  loss: TROPHY_LOSS,
  draw: TROPHY_DRAW,
  min: TROPHY_MIN,
  max: TROPHY_MAX,
  overallMax: OVERALL_TROPHY_MAX,
  gameCount: TROPHY_GAMES.length,
  outcomes: TROPHY_OUTCOMES,
  overallMinGames: OVERALL_TROPHY_MIN_GAMES,
});
