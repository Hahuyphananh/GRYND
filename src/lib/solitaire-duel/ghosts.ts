// src/lib/solitaire-duel/ghosts.ts
//
// THE GHOST POOL — recorded replays of REAL players, never an AI.
//
// A ghost duel is an asynchronous match: the player races another person's
// already-played run of the SAME deterministic deal. That is only honest if the
// replay is (a) a real human's accepted move log, (b) played on the exact deal
// the player receives, and (c) replayed at the human's own recorded pace. This
// module supplies all three and decides nothing about the game:
//
//   * THE POOL IS MATERIALIZED. `backfillGhostRuns` turns finished ranked
//     matches into rows in `solitaire_ghost_runs`, copying the deal, the paced
//     timeline and the recorded trail. The pool therefore survives the retention
//     sweep deleting the source match, and the backfill job fills it from
//     HISTORY — so it is warm from the first tick, not cold until the next
//     human duel happens to finish. `findGhostRun` reads the pool first and
//     falls back to scanning recent matches live, so matchmaking can never be
//     left without an opponent because a job has not run yet.
//   * A SEAT MUST REPLAY. A seat that was RE-DEALT (`resetCount > 0`) is
//     refused, because its log no longer replays from the committed deal. Every
//     candidate's log is replayed through the real engine before it is stored
//     or offered, so a broken recording can never become an opponent.
//   * THE PACE IS THE HUMAN'S. `buildGhostTimeline` turns the log's own
//     `created_at` instants into offsets from the source GO; `dueGhostSteps`
//     says which of them the clock has reached — that is the whole "AI": the
//     moves are fixed, in order, at the recorded times.
//   * THE RUN IS VISIBLE. `buildGhostTrail` samples the recording's foundation
//     progress at those same instants (counts only, never a card), so the
//     opponent panel can show the run unfolding.
//
// NO AI IMPORT, NO PLANNER, NO RANDOMNESS DURING PLAYBACK. The only randomness
// is which recording the pool picks, which decides the opponent, not a single
// move of it.

import crypto from "node:crypto";
import { sql } from "drizzle-orm";

import {
  GHOST_MIN_RECORDED_MOVES,
  SEAT,
  SOLITAIRE_GHOST_PLAYER_PREFIX,
  VARIANT_VERSION,
} from "./constants";
import {
  applyMove,
  initialStateFromDeal,
  progressOf,
  replayMoves,
} from "./rules";
import type { Seat, SolitaireDeal, SolitaireMove } from "./types";

/** One recorded move, at the instant it was played, from the source GO. */
export type GhostTimelineStep = {
  /** Milliseconds after the source match's GO instant. */
  offsetMs: number;
  kind: string;
  move: SolitaireMove;
};

/** One count-only checkpoint of the recording's own progress. */
export type GhostTrailPoint = {
  /** Milliseconds after the source match's GO instant. */
  atMs: number;
  foundationCards: number;
};

/** A replayable run, with everything needed to mint a ghost duel from it. */
export type GhostRun = {
  sourceMatchId: string;
  seat: Seat;
  /** The source account, for the "never race yourself" exclusion only. */
  sourceClerkId: string;
  variant: string;
  variantVersion: number;
  deal: SolitaireDeal;
  serverSeed: string;
  serverSeedHash: string;
  dealSeed: number;
  /** Anonymised handle shown to the player. */
  name: string;
  /** The source player's ladder snapshot at record time. */
  rating: number;
  trophies: number;
  timeline: GhostTimelineStep[];
  trail: GhostTrailPoint[];
  /** Accepted moves in the recording (= its logged plies). */
  ply: number;
  /** Offset of the source player's completing move, or null if unfinished. */
  completedOffsetMs: number | null;
};

/** Candidate matches considered per live fallback (each is verified). */
const CANDIDATE_LIMIT = 5;
/** Candidates actually replayed per fallback, so a read stays bounded. */
const VERIFIED_ATTEMPTS = 3;
/** Rows read from the pool per fallback. */
const POOL_LIMIT = 5;
/** Pool candidates verified per fallback before falling back to a live scan. */
const POOL_VERIFIED_ATTEMPTS = 3;
/** Default number of matches one backfill tick records. */
const BACKFILL_DEFAULT_LIMIT = 50;
/** Ladder defaults when the source player has never been rated/trophied. */
const DEFAULT_GHOST_RATING = 1_000;
const DEFAULT_GHOST_TROPHIES = 0;
/** Trail resolution: enough to show the shape of a run, small enough to paint. */
const TRAIL_MAX_POINTS = 24;

const GHOST_NAMESPACE = "grynd:solitaire-ghost:";

function digestFor(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(GHOST_NAMESPACE + String(value ?? ""))
    .digest("hex");
}

/**
 * The anonymised handle for a recorded run.
 *
 * Stable per source player, so two runs by the same person are introduced
 * identically — and one-way, so the handle can never be resolved back into the
 * account that produced it. Nothing of the club id, name or icon survives.
 */
export function ghostHandleFor(sourceUserId: unknown): string {
  return `GHOST-${digestFor(sourceUserId).slice(0, 4).toUpperCase()}`;
}

/**
 * The synthetic seat id a ghost occupies.
 *
 * Derived from the SOURCE MATCH, so every ghost duel is distinct, and prefixed
 * with the ghost namespace, so it can never equal an account id (which the
 * platform issues as `user_*`) and is never mistaken for the AI seat.
 */
export function ghostPlayerIdFor(sourceMatchId: unknown): string {
  return `${SOLITAIRE_GHOST_PLAYER_PREFIX}${digestFor(sourceMatchId).slice(0, 12)}`;
}

// ── Seat selection (pure) ─────────────────────────────────────────────────

export type GhostCandidateFacts = {
  p1Ply: number;
  p2Ply: number;
  /** The seat's board has been re-dealt, so its log no longer replays. */
  p1Reset: number;
  p2Reset: number;
  p1Done: boolean;
  p2Done: boolean;
};

function seatPly(facts: GhostCandidateFacts, seat: Seat): number {
  return Math.max(0, Number(seat === SEAT.PLAYER1 ? facts.p1Ply : facts.p2Ply) || 0);
}

function seatResets(facts: GhostCandidateFacts, seat: Seat): number {
  return Math.max(
    0,
    Number(seat === SEAT.PLAYER1 ? facts.p1Reset : facts.p2Reset) || 0,
  );
}

function seatDone(facts: GhostCandidateFacts, seat: Seat): boolean {
  return Boolean(seat === SEAT.PLAYER1 ? facts.p1Done : facts.p2Done);
}

/**
 * Every seat of a finished match that can be replayed, best first.
 *
 * A seat qualifies only when its board was never re-dealt and it logged at
 * least `minMoves` accepted moves. The seat that actually SOLVED the deal comes
 * first (the stronger, faster replay), then the one that played more moves.
 * Deterministic, so the same facts always produce the same order.
 *
 * The backfill records EVERY qualifying seat (more variety in the pool); a live
 * fallback simply takes the first.
 */
export function ghostSeatsFor(
  facts: GhostCandidateFacts,
  minMoves = GHOST_MIN_RECORDED_MOVES,
): Seat[] {
  const eligible = (seat: Seat) =>
    seatResets(facts, seat) === 0 && seatPly(facts, seat) >= minMoves;
  return [SEAT.PLAYER1, SEAT.PLAYER2]
    .filter(eligible)
    .sort((a, b) => {
      if (seatDone(facts, a) !== seatDone(facts, b)) {
        return seatDone(facts, a) ? -1 : 1;
      }
      return seatPly(facts, b) - seatPly(facts, a);
    });
}

/** The single best replayable seat, or null. */
export function chooseGhostSeat(
  facts: GhostCandidateFacts,
  minMoves = GHOST_MIN_RECORDED_MOVES,
): Seat | null {
  return ghostSeatsFor(facts, minMoves)[0] ?? null;
}

// ── Timeline + trail (pure) ───────────────────────────────────────────────

function instantMs(value: unknown): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Turn a seat's stored log into a paced timeline.
 *
 * Offsets come from each row's own server-written `created_at` minus the SOURCE
 * match's GO instant, so the replay moves at the human's real pace rather than
 * at a bot's fixed delay. They are clamped to zero and forced non-decreasing:
 * a clock-skewed or back-dated row can delay the recording, but can never make
 * the ghost move backwards in time or burst several moves at the same instant
 * out of order.
 */
export function buildGhostTimeline({
  goAtMs,
  rows,
}: {
  goAtMs: unknown;
  rows: readonly { kind: string; move: SolitaireMove; createdAt?: unknown }[];
}): GhostTimelineStep[] {
  const base = instantMs(goAtMs);
  let previous = 0;
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const at = instantMs(row.createdAt);
    const raw =
      base == null || at == null ? previous : Math.max(0, Math.round(at - base));
    const offsetMs = Math.max(previous, raw);
    previous = offsetMs;
    return { offsetMs, kind: String(row.kind), move: row.move };
  });
}

/**
 * The steps the clock has reached that have not been played yet.
 *
 * `appliedPly` is the ghost seat's own move cursor, so this is idempotent and
 * monotonic: re-reading the same match at the same instant yields nothing.
 */
export function dueGhostSteps(
  timeline: readonly GhostTimelineStep[],
  appliedPly: number,
  elapsedMs: number,
): { index: number; step: GhostTimelineStep }[] {
  const from = Math.max(0, Math.floor(Number(appliedPly) || 0));
  const until = Number(elapsedMs);
  if (!Number.isFinite(until) || until < 0) return [];
  const due: { index: number; step: GhostTimelineStep }[] = [];
  for (let index = from; index < timeline.length; index += 1) {
    const step = timeline[index];
    if (Number(step?.offsetMs) > until) break;
    due.push({ index, step });
  }
  return due;
}

/**
 * The recording's foundation progress at its own recorded instants.
 *
 * Count-only checkpoints sampled from the VERIFIED replay, so the opponent
 * panel can show the run unfolding without ever exposing a card identity, a
 * column layout or the stock order. Every point is a real position from the
 * run, never an interpolation: the bar only moves when the recording did.
 */
export function buildGhostTrail(
  deal: SolitaireDeal,
  timeline: readonly GhostTimelineStep[],
  maxPoints = TRAIL_MAX_POINTS,
): GhostTrailPoint[] {
  if (!deal || !Array.isArray(timeline) || timeline.length === 0) return [];
  const cap = Math.max(2, Math.min(60, Math.floor(maxPoints) || TRAIL_MAX_POINTS));
  const stride = Math.max(1, Math.ceil(timeline.length / cap));
  let state = initialStateFromDeal(deal);
  const points: GhostTrailPoint[] = [
    { atMs: 0, foundationCards: progressOf(state).foundationCards },
  ];
  for (let index = 0; index < timeline.length; index += 1) {
    const applied = applyMove({ state, move: timeline[index].move });
    if (!applied.ok) break;
    state = applied.state as typeof state;
    const last = index === timeline.length - 1;
    if ((index + 1) % stride === 0 || last) {
      points.push({
        atMs: timeline[index].offsetMs,
        foundationCards: progressOf(state).foundationCards,
      });
    }
  }
  return points;
}

/** True when the given timeline is a replayable sequence on `deal`. */
export function ghostTimelineReplays(
  deal: SolitaireDeal,
  timeline: readonly GhostTimelineStep[],
): boolean {
  if (!deal || !Array.isArray(timeline) || timeline.length === 0) return false;
  const replayed = replayMoves({
    deal,
    moves: timeline.map((step) => ({ kind: step.kind, move: step.move })),
  });
  return Boolean(replayed?.ok);
}

// ── Row helpers ───────────────────────────────────────────────────────────

type Row = Record<string, any>;

function rowsOf(result: any): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (Array.isArray(result?.rows)) return result.rows as Row[];
  return [];
}

function asObject<T>(value: unknown): T | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? (value as T) : null;
}

function arrayOf<T>(value: unknown): T[] | null {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

// ── Candidate reads ───────────────────────────────────────────────────────

type GhostCandidate = {
  matchId: string;
  player1Id: string;
  player2Id: string;
  variant: string;
  variantVersion: number;
  serverSeed: string;
  serverSeedHash: string;
  dealSeed: number;
  deal: unknown;
  goAt: unknown;
  p1Ply: number;
  p2Ply: number;
  p1Reset: number;
  p2Reset: number;
  p1Done: boolean;
  p2Done: boolean;
};

const CANDIDATE_COLUMNS = sql`
  m.id::text AS "matchId",
  m.player1_id AS "player1Id",
  m.player2_id AS "player2Id",
  m.variant AS "variant",
  m.variant_version AS "variantVersion",
  m.server_seed AS "serverSeed",
  m.server_seed_hash AS "serverSeedHash",
  m.deal_seed AS "dealSeed",
  m.deal AS "deal",
  m.go_at AS "goAt",
  m.p1_ply AS "p1Ply",
  m.p2_ply AS "p2Ply",
  COALESCE((m.p1_state->>'resetCount')::int, 0) AS "p1Reset",
  COALESCE((m.p2_state->>'resetCount')::int, 0) AS "p2Reset",
  COALESCE((m.p1_state->>'completed')::boolean, false) AS "p1Done",
  COALESCE((m.p2_state->>'completed')::boolean, false) AS "p2Done"
`;

/**
 * Finished HUMAN matches on the current variant, as raw candidate rows.
 *
 * Raw SQL because the filters read each seat's own JSON board (`resetCount` /
 * `completed`), which the typed query builder cannot express. Excludes practice
 * and ghost rows always; excludes the requester's own matches when there is a
 * requester; and (for the backfill) matches already recorded in the pool.
 */
async function readGhostCandidates(
  executor: any,
  {
    limit,
    minMoves,
    excludeUserId = null,
    onlyUnrecorded = false,
  }: {
    limit: number;
    minMoves: number;
    excludeUserId?: string | null;
    onlyUnrecorded?: boolean;
  },
): Promise<GhostCandidate[]> {
  const exclude =
    excludeUserId == null
      ? sql``
      : sql`
    AND m.player1_id <> ${String(excludeUserId)}
    AND (m.player2_id IS NULL OR m.player2_id <> ${String(excludeUserId)})`;
  const unrecorded = onlyUnrecorded
    ? sql`
    AND NOT EXISTS (
      SELECT 1 FROM solitaire_ghost_runs r WHERE r.source_match_id = m.id
    )`
    : sql``;

  const result = await executor.execute(sql`
    SELECT ${CANDIDATE_COLUMNS}
      FROM solitaire_duel_matches m
     WHERE m.status = 'finished'
       AND m.is_ai = false
       AND m.is_ghost = false
       AND m.variant_version = ${VARIANT_VERSION}
       AND m.go_at IS NOT NULL
       AND (
         (COALESCE((m.p1_state->>'resetCount')::int, 0) = 0 AND m.p1_ply >= ${minMoves})
         OR
         (COALESCE((m.p2_state->>'resetCount')::int, 0) = 0 AND m.p2_ply >= ${minMoves})
       )
       ${exclude}
       ${unrecorded}
     ORDER BY m.created_at DESC
     LIMIT ${limit}
  `);
  return rowsOf(result) as GhostCandidate[];
}

/** The source seat's own ladder snapshot, for a fair settlement. */
async function readGhostLedger(
  executor: any,
  clerkId: string,
): Promise<{ rating: number; trophies: number }> {
  const result = await executor.execute(sql`
    SELECT
      (SELECT r.rating FROM player_ratings r
         INNER JOIN users u ON u.id = r.user_id
        WHERE u.clerk_id = ${String(clerkId)}
          AND r.game_key = 'solitaire-duel'
        LIMIT 1) AS rating,
      (SELECT t.trophies FROM player_trophies t
         INNER JOIN users u ON u.id = t.user_id
        WHERE u.clerk_id = ${String(clerkId)}
          AND t.game_key = 'solitaire-duel'
        LIMIT 1) AS trophies
  `);
  const row = rowsOf(result)[0] ?? {};
  const rating = Number(row.rating);
  const trophies = Number(row.trophies);
  return {
    rating: Number.isFinite(rating) ? Math.round(rating) : DEFAULT_GHOST_RATING,
    trophies: Number.isFinite(trophies) ? Math.round(trophies) : DEFAULT_GHOST_TROPHIES,
  };
}

async function readSeatMoves(
  executor: any,
  matchId: string,
  seat: Seat,
): Promise<Row[]> {
  return rowsOf(
    await executor.execute(sql`
      SELECT ply, kind, move, created_at AS "createdAt"
        FROM solitaire_duel_moves
       WHERE match_id = ${matchId}
         AND seat = ${seat}
       ORDER BY ply ASC
    `),
  );
}

/**
 * Every verified run a finished match can supply — the ONE place a timeline is
 * built from raw rows, used by both the live fallback and the backfill.
 *
 * A seat is included only when its log replays through the real engine, so a
 * run is verified BEFORE it is stored or offered. Bounded by the match's own
 * two seats.
 */
export async function buildGhostRunsFromCandidate(
  executor: any,
  candidate: GhostCandidate,
  { minMoves = GHOST_MIN_RECORDED_MOVES }: { minMoves?: number } = {},
): Promise<GhostRun[]> {
  const deal = asObject<SolitaireDeal>(candidate.deal);
  if (!deal) return [];

  const seats = ghostSeatsFor(
    {
      p1Ply: Number(candidate.p1Ply) || 0,
      p2Ply: Number(candidate.p2Ply) || 0,
      p1Reset: Number(candidate.p1Reset) || 0,
      p2Reset: Number(candidate.p2Reset) || 0,
      p1Done: Boolean(candidate.p1Done),
      p2Done: Boolean(candidate.p2Done),
    },
    minMoves,
  );

  const runs: GhostRun[] = [];
  for (const seat of seats) {
    const sourceClerkId = String(
      seat === SEAT.PLAYER1 ? candidate.player1Id : candidate.player2Id,
    );
    if (!sourceClerkId) continue;

    const moveRows = await readSeatMoves(executor, String(candidate.matchId), seat);
    if (moveRows.length < minMoves) continue;

    const timeline = buildGhostTimeline({
      goAtMs: candidate.goAt,
      rows: moveRows.map((row) => ({
        kind: String(row.kind),
        move: asObject<SolitaireMove>(row.move) as SolitaireMove,
        createdAt: row.createdAt,
      })),
    });
    if (!ghostTimelineReplays(deal, timeline)) continue;

    const replayed = replayMoves({
      deal,
      moves: timeline.map((step) => ({ kind: step.kind, move: step.move })),
    });
    const completed =
      Boolean(replayed?.ok) && Boolean((replayed as any).state?.completed);
    const ledger = await readGhostLedger(executor, sourceClerkId);

    runs.push({
      sourceMatchId: String(candidate.matchId),
      seat,
      sourceClerkId,
      variant: String(candidate.variant),
      variantVersion: Number(candidate.variantVersion) || VARIANT_VERSION,
      deal,
      serverSeed: String(candidate.serverSeed),
      serverSeedHash: String(candidate.serverSeedHash),
      dealSeed: Number(candidate.dealSeed),
      name: ghostHandleFor(sourceClerkId),
      rating: ledger.rating,
      trophies: ledger.trophies,
      timeline,
      trail: buildGhostTrail(deal, timeline),
      ply: timeline.length,
      completedOffsetMs: completed
        ? timeline[timeline.length - 1]?.offsetMs ?? null
        : null,
    });
  }
  return runs;
}

// ── The pool ──────────────────────────────────────────────────────────────

/** Map one `solitaire_ghost_runs` row to a run, or null if it no longer replays. */
function runFromPoolRow(row: Row): GhostRun | null {
  const deal = asObject<SolitaireDeal>(row.deal);
  const timeline = arrayOf<GhostTimelineStep>(row.timeline);
  if (!deal || !timeline || timeline.length === 0) return null;
  // Defense in depth: a stored run is re-checked before it is offered, so a
  // hand-edited or legacy row can never become an opponent.
  if (!ghostTimelineReplays(deal, timeline)) return null;
  const seat = String(row.seat) === SEAT.PLAYER2 ? SEAT.PLAYER2 : SEAT.PLAYER1;
  return {
    sourceMatchId: String(row.sourceMatchId),
    seat,
    sourceClerkId: String(row.sourceClerkId),
    variant: String(row.variant),
    variantVersion: Number(row.variantVersion) || VARIANT_VERSION,
    deal,
    serverSeed: String(row.serverSeed),
    serverSeedHash: String(row.serverSeedHash),
    dealSeed: Number(row.dealSeed),
    name: String(row.ghostName),
    rating: Number(row.rating),
    trophies: Number(row.trophies),
    timeline,
    trail: arrayOf<GhostTrailPoint>(row.trail) ?? buildGhostTrail(deal, timeline),
    ply: Number(row.ply) || timeline.length,
    completedOffsetMs:
      row.completedOffsetMs == null ? null : Number(row.completedOffsetMs),
  };
}

/** Verified runs from the materialized pool, never the requester's own. */
export async function readGhostPool(
  executor: any,
  { excludeUserId, limit = POOL_LIMIT }: { excludeUserId: string; limit?: number },
): Promise<GhostRun[]> {
  const result = await executor.execute(sql`
    SELECT source_match_id::text AS "sourceMatchId",
           source_seat AS "seat",
           source_clerk_id AS "sourceClerkId",
           variant,
           variant_version AS "variantVersion",
           server_seed AS "serverSeed",
           server_seed_hash AS "serverSeedHash",
           deal_seed AS "dealSeed",
           deal,
           timeline,
           trail,
           ply,
           completed_offset_ms AS "completedOffsetMs",
           rating,
           trophies,
           ghost_name AS "ghostName"
      FROM solitaire_ghost_runs
     WHERE variant_version = ${VARIANT_VERSION}
       AND source_clerk_id <> ${String(excludeUserId)}
     ORDER BY random()
     LIMIT ${limit}
  `);
  return rowsOf(result)
    .map(runFromPoolRow)
    .filter((run): run is GhostRun => Boolean(run));
}

/**
 * A verified, replayable ghost run, or null.
 *
 * THE POOL FIRST, so matchmaking is cheap and independent of how old the
 * source matches are. If the pool has nothing usable this falls back to
 * scanning recent finished matches live — which keeps the immediate promise
 * ("never leave a player waiting") true between two backfill ticks, and on a
 * brand-new deployment whose pool has not been filled yet.
 */
export async function findGhostRun(
  executor: any,
  {
    excludeUserId,
    minMoves = GHOST_MIN_RECORDED_MOVES,
  }: { excludeUserId: string; minMoves?: number },
): Promise<GhostRun | null> {
  const pooled = await readGhostPool(executor, { excludeUserId });
  if (pooled.length > 0) return pooled[0];

  const candidates = await readGhostCandidates(executor, {
    limit: CANDIDATE_LIMIT,
    minMoves,
    excludeUserId,
  });
  for (const candidate of candidates.slice(0, VERIFIED_ATTEMPTS)) {
    const runs = await buildGhostRunsFromCandidate(executor, candidate, { minMoves });
    if (runs.length > 0) return runs[0];
  }
  return null;
}

// ── The backfill ──────────────────────────────────────────────────────────

export type GhostBackfillResult = {
  /** Finished matches examined in this tick. */
  scanned: number;
  /** Runs written to the pool (a run already present is not counted twice). */
  recorded: number;
  /** Matches that could not supply a replay (too few moves / un-replayable). */
  skipped: number;
};

/**
 * Record ghost runs from EXISTING finished ranked matches.
 *
 * This is the job behind `/api/jobs/solitaire-ghost-pool`, and it is what keeps
 * the pool warm: it reads history rather than waiting for the next human duel,
 * so a fresh deployment (or a pool drained by the retention sweep) is refilled
 * from matches that already exist.
 *
 * Idempotent by construction:
 *   * the candidate query skips any match that already has a pool row, and
 *   * the insert is `ON CONFLICT (source_match_id, source_seat) DO NOTHING`,
 * so two overlapping ticks, or a retried HTTP call, can never duplicate a run.
 *
 * Bounded in two ways — `limit` matches per tick, and each match's own two
 * seats — so one call cannot walk the whole history. Candidates are newest
 * first: a match whose log cannot replay is skipped without stalling the sweep
 * behind it.
 *
 * The executor is passed in (rather than importing the database client) so the
 * worker and its tests share one call shape and this module stays free of a
 * top-level connection.
 */
export async function backfillGhostRuns(
  executor: any,
  {
    limit = BACKFILL_DEFAULT_LIMIT,
    minMoves = GHOST_MIN_RECORDED_MOVES,
  }: { limit?: number; minMoves?: number } = {},
): Promise<GhostBackfillResult> {
  const perTick = Math.max(1, Math.min(500, Math.floor(Number(limit) || BACKFILL_DEFAULT_LIMIT)));
  const candidates = await readGhostCandidates(executor, {
    limit: perTick,
    minMoves,
    onlyUnrecorded: true,
  });

  let recorded = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const runs = await buildGhostRunsFromCandidate(executor, candidate, { minMoves });
    if (runs.length === 0) {
      skipped += 1;
      continue;
    }

    for (const run of runs) {
      await executor.execute(sql`
        INSERT INTO solitaire_ghost_runs
          (source_match_id, source_seat, source_clerk_id, variant, variant_version,
           server_seed, server_seed_hash, deal_seed, deal, timeline, trail, ply,
           completed, completed_offset_ms, rating, trophies, ghost_name)
        VALUES
          (${run.sourceMatchId}::uuid, ${run.seat}, ${run.sourceClerkId},
           ${run.variant}, ${run.variantVersion},
           ${run.serverSeed}, ${run.serverSeedHash}, ${run.dealSeed},
           ${JSON.stringify(run.deal)}::jsonb,
           ${JSON.stringify(run.timeline)}::jsonb,
           ${JSON.stringify(run.trail)}::jsonb,
           ${run.ply}, ${run.completedOffsetMs != null},
           ${run.completedOffsetMs}, ${run.rating}, ${run.trophies},
           ${run.name})
        ON CONFLICT (source_match_id, source_seat) DO NOTHING
      `);
      recorded += 1;
    }
  }

  return { scanned: candidates.length, recorded, skipped };
}
