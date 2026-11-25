// src/lib/solitaire-duel/postMatchTimeline.ts
//
// THE POST-MATCH TIMELINE — "Mistake Finder" data, derived, never invented.
//
// Free players get the final score and basic stats. GRYND PRO gets this: one
// ordered, scrubbable timeline of BOTH seats' validated moves, with the moments
// that actually decided the race marked:
//
//   * `wasted-move`  — the game's own judged signal: a review rating of
//                      inaccuracy / mistake / blunder, a tagged wasted action,
//                      or (Sudoku) an action the server rejected as incorrect.
//   * `time-loss`    — the viewer paused far longer than their opponent's
//                      median pace before a move (>= 5s AND >= 3x that median).
//   * `lead-change`  — the progress lead (foundation cards, solved cells)
//                      changed hands.
//
// EVERY NUMBER COMES FROM THE STORED GAME: move timestamps from the game's own
// append-only log, move kinds from the same rows, progress from either the
// engine's move steps or the per-move series an adapter supplies, and ratings
// from the cached Game Review analysis. Nothing is estimated, no "predicted"
// turning point is produced, and a match with no opponent log simply has no
// opponent comparison (never a fabricated one).
//
// PURE: no DB, no auth, no Stripe. The route decides who may see the result and
// builds the per-game progress series; this module only assembles the timeline,
// so the rules are testable without a browser or a database.

import type { MoveRating } from "./analysis";
import { describeMove } from "./reviewView";

export type TimelineSeat = "player1" | "player2";

/** One stored move, already normalised by the route. */
export type TimelineSeatMove = {
  ply: number;
  kind: string;
  move?: unknown;
  /** Epoch milliseconds of the log row's `created_at`. */
  atMs: number;
  /** Game-specific action label, when the adapter has a better one. */
  label?: string;
};

export type TimelineSeatInput = {
  seat: TimelineSeat;
  /** Server-chosen label — "You" / "Opponent". Never a client value. */
  label: string;
  moves: readonly TimelineSeatMove[];
  /**
   * Progress AFTER each move (same length/order as `moves`), when progress is
   * not a pure function of the move kind (Sudoku's correct-entry count). When
   * omitted, the engine sums `progressStep(kind)` from zero.
   */
  progress?: readonly number[];
  completed?: boolean;
  forfeited?: boolean;
};

/** The viewer's review ratings, keyed by their own 0-based ply. */
export type TimelineRatingInput = {
  ply: number;
  rating: MoveRating;
  tags?: readonly string[];
  /** A game-judged waste that is not a move rating (e.g. a wrong Sudoku entry). */
  wasted?: boolean;
};

export type TimelineEvent = {
  /** 0-based global position on the timeline (the scrub value). */
  index: number;
  /** Milliseconds since the match started, clamped at 0. */
  atMs: number;
  seat: TimelineSeat;
  label: string;
  /** 1-based ply within that seat's own log. */
  ply: number;
  kind: string;
  /** Game progress this seat had after the move (cards, cells, points). */
  progressAfter: number;
  /** Milliseconds since this seat's previous move; null for its first. */
  gapMs: number | null;
  /** The review's rating, for the viewer's seat only. */
  rating: MoveRating | null;
  /** A move the game judged wasteful — the Mistake Finder's core signal. */
  wasted: boolean;
  /** Short human label for the move. */
  moveLabel: string;
};

export type TimelineMarkerKind = "lead-change" | "wasted-move" | "time-loss";

export type TimelineMarker = {
  kind: TimelineMarkerKind;
  /** The event index to scrub to. */
  index: number;
  atMs: number;
  seat: TimelineSeat;
  ply: number;
  label: string;
};

export type SeatBasicStats = {
  moves: number;
  /** Highest progress this seat reached. */
  peakProgress: number;
  /** Median think time between moves, or null with fewer than two moves. */
  medianMoveMs: number | null;
  /** Average think time between moves, or null with fewer than two moves. */
  paceMsPerMove: number | null;
  completed: boolean;
  forfeited: boolean;
};

export type MatchTimeline = {
  durationMs: number | null;
  progressMax: number;
  events: TimelineEvent[];
  markers: TimelineMarker[];
  summary: {
    turningPoints: number;
    wastedMoves: number;
    timeLossSpikes: number;
  };
};

/** A pause shorter than this is never a "time-loss spike", however slow the opponent. */
export const TIME_LOSS_MIN_MS = 5_000;
/** How many times the opponent's median pace a pause must be to count. */
export const TIME_LOSS_FACTOR = 3;
/** The marker list is a picker, not the log — it stays readable. */
export const MAX_MARKERS = 60;

const WASTED_RATINGS: readonly MoveRating[] = ["inaccuracy", "mistake", "blunder"];
const WASTED_TAGS = new Set(["wasted-redeal", "pointless-shuffle", "pulled-from-foundation"]);

function validMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Foundation cards added by a Solitaire move kind. Klondike has exactly three. */
export function foundationStep(kind: string): number {
  if (kind === "waste-to-foundation" || kind === "tableau-to-foundation") return 1;
  if (kind === "foundation-to-tableau") return -1;
  return 0;
}

function clampProgress(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

function sortMoves(moves: readonly TimelineSeatMove[]): TimelineSeatMove[] {
  return [...moves].sort((a, b) => a.ply - b.ply);
}

/** Gaps (ms) between consecutive moves, excluding the first move. */
function moveGaps(moves: readonly TimelineSeatMove[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < moves.length; i += 1) {
    gaps.push(Math.max(0, moves[i].atMs - moves[i - 1].atMs));
  }
  return gaps;
}

/** The progress value after each move, in that seat's ply order. */
export function progressSeries(
  input: TimelineSeatInput,
  progressStep: (kind: string) => number = foundationStep,
  progressMax = 52,
): number[] {
  const moves = sortMoves(input.moves);
  if (input.progress && input.progress.length === moves.length) {
    return input.progress.map((value) =>
      clampProgress(Number(value) || 0, progressMax),
    );
  }
  let progress = 0;
  return moves.map((move) => {
    progress = clampProgress(progress + progressStep(move.kind), progressMax);
    return progress;
  });
}

export function seatBasicStats(
  input: TimelineSeatInput,
  progressStep: (kind: string) => number = foundationStep,
  progressMax = 52,
): SeatBasicStats {
  const moves = sortMoves(input.moves);
  const series = progressSeries(input, progressStep, progressMax);
  const peak = series.length > 0 ? Math.max(...series) : 0;
  const gaps = moveGaps(moves);
  const elapsed =
    moves.length >= 2 ? Math.max(0, moves[moves.length - 1].atMs - moves[0].atMs) : null;

  return {
    moves: moves.length,
    peakProgress: peak,
    medianMoveMs: median(gaps),
    paceMsPerMove:
      elapsed !== null && moves.length >= 2
        ? Math.round(elapsed / (moves.length - 1))
        : null,
    completed: input.completed === true,
    forfeited: input.forfeited === true,
  };
}

/**
 * Build the whole timeline from stored logs.
 *
 * `startedAtMs` anchors the clock; if it is missing the first move becomes the
 * origin. `ratings` applies ONLY to the seat it names, because only the viewer
 * has a Game Review analysis — the opponent's log is never scored here.
 */
export function buildMatchTimeline({
  startedAtMs,
  endedAtMs,
  seats,
  ratings = null,
  progressStep = foundationStep,
  progressMax = 52,
}: {
  startedAtMs: number | null;
  endedAtMs: number | null;
  seats: readonly TimelineSeatInput[];
  ratings?: { seat: TimelineSeat; perMove: readonly TimelineRatingInput[] } | null;
  progressStep?: (kind: string) => number;
  progressMax?: number;
}): MatchTimeline {
  const orderedSeats = [...seats].sort((a, b) => a.seat.localeCompare(b.seat));
  const maxProgress = Math.max(1, Number(progressMax) || 52);
  const firstMoveAt = Math.min(
    ...orderedSeats.flatMap((seat) =>
      seat.moves.length > 0 ? [Math.min(...seat.moves.map((move) => move.atMs))] : [],
    ),
  );
  const origin = validMs(startedAtMs) ?? (Number.isFinite(firstMoveAt) ? firstMoveAt : null);

  const ratingByPly = new Map<number, TimelineRatingInput>();
  if (ratings) {
    for (const entry of ratings.perMove) ratingByPly.set(entry.ply, entry);
  }

  const perSeat = orderedSeats.map((input) => {
    const moves = sortMoves(input.moves);
    const series = progressSeries(input, progressStep, maxProgress);
    const gaps: number[] = [];
    const spikesByPly = new Set<number>();
    return { input, seat: input.seat, moves, series, gaps, spikesByPly };
  });

  // First pass: per-seat gap lists and medians, so a spike can be compared with
  // the OTHER seat's pace (the opponent comparison the feature promises).
  for (const entry of perSeat) {
    entry.moves.forEach((move, i) => {
      if (i > 0) entry.gaps.push(Math.max(0, move.atMs - entry.moves[i - 1].atMs));
    });
  }
  const medians = new Map<TimelineSeat, number | null>();
  for (const entry of perSeat) medians.set(entry.seat, median(entry.gaps));

  for (const entry of perSeat) {
    const opponent = perSeat.find((other) => other.seat !== entry.seat);
    const ownMedian = medians.get(entry.seat) ?? null;
    const reference = (opponent ? medians.get(opponent.seat) : null) ?? ownMedian ?? null;
    if (reference === null) continue;
    entry.moves.forEach((move, i) => {
      if (i === 0) return;
      const gap = Math.max(0, move.atMs - entry.moves[i - 1].atMs);
      if (gap >= TIME_LOSS_MIN_MS && gap >= TIME_LOSS_FACTOR * reference) {
        entry.spikesByPly.add(move.ply);
      }
    });
  }

  const events: TimelineEvent[] = [];
  for (const entry of perSeat) {
    entry.moves.forEach((move, i) => {
      const rated = ratings?.seat === entry.seat ? ratingByPly.get(i) : undefined;
      const wasted =
        rated?.wasted === true ||
        Boolean(rated && WASTED_RATINGS.includes(rated.rating)) ||
        Boolean(rated?.tags?.some((tag) => WASTED_TAGS.has(tag)));
      events.push({
        index: 0,
        atMs: origin === null ? Math.max(0, move.atMs) : Math.max(0, move.atMs - origin),
        seat: entry.seat,
        label: entry.input.label,
        ply: i + 1,
        kind: move.kind,
        progressAfter: entry.series[i] ?? 0,
        gapMs: i === 0 ? null : Math.max(0, move.atMs - entry.moves[i - 1].atMs),
        rating: rated?.rating ?? null,
        wasted,
        moveLabel: move.label ?? describeMove(move.move ?? { kind: move.kind }),
      });
    });
  }

  events.sort(
    (a, b) => a.atMs - b.atMs || a.seat.localeCompare(b.seat) || a.ply - b.ply,
  );
  events.forEach((event, index) => {
    event.index = index;
  });

  // Lead changes, tracked over the SAME progress values the events carry.
  const progress = new Map<TimelineSeat, number>();
  let leader: TimelineSeat | null = null;
  let turningPoints = 0;
  const leadMarkers: TimelineMarker[] = [];
  for (const event of events) {
    progress.set(event.seat, event.progressAfter);
    const p1 = progress.get("player1") ?? 0;
    const p2 = progress.get("player2") ?? 0;
    const nextLeader: TimelineSeat | null = p1 > p2 ? "player1" : p2 > p1 ? "player2" : null;
    if (nextLeader !== null && nextLeader !== leader) {
      turningPoints += 1;
      leadMarkers.push({
        kind: "lead-change",
        index: event.index,
        atMs: event.atMs,
        seat: event.seat,
        ply: event.ply,
        label: `${event.label} took the lead`,
      });
    }
    leader = nextLeader;
  }

  const wastedMarkers: TimelineMarker[] = events
    .filter((event) => event.wasted)
    .map((event) => ({
      kind: "wasted-move",
      index: event.index,
      atMs: event.atMs,
      seat: event.seat,
      ply: event.ply,
      label: event.moveLabel,
    }));

  const spikeMarkers: TimelineMarker[] = [];
  for (const entry of perSeat) {
    if (entry.spikesByPly.size === 0) continue;
    for (const event of events) {
      if (event.seat !== entry.seat) continue;
      const move = entry.moves[event.ply - 1];
      if (!move || !entry.spikesByPly.has(move.ply)) continue;
      spikeMarkers.push({
        kind: "time-loss",
        index: event.index,
        atMs: event.atMs,
        seat: entry.seat,
        ply: event.ply,
        label: `${event.label} paused ${Math.round((event.gapMs ?? 0) / 100) / 10}s`,
      });
    }
  }

  const markers = [...leadMarkers, ...wastedMarkers, ...spikeMarkers]
    .sort((a, b) => a.atMs - b.atMs || a.index - b.index)
    .slice(0, MAX_MARKERS);

  const durationMs =
    origin !== null && endedAtMs !== null && Number.isFinite(endedAtMs)
      ? Math.max(0, endedAtMs - origin)
      : null;

  return {
    durationMs,
    progressMax: maxProgress,
    events,
    markers,
    summary: {
      turningPoints,
      wastedMoves: wastedMarkers.length,
      timeLossSpikes: spikeMarkers.length,
    },
  };
}
