// src/lib/solitaire-puzzle/serverStore.ts
//
// THE SERVER-AUTHORITATIVE PUZZLE SESSION STORE.
//
// This module is the trust boundary for competitive and practice puzzle
// sessions. The ONLY client-authored values that reach it are a move (which
// cards, from where, to where) and the per-seat ply cursor. The puzzle set,
// the frozen start states, the stock order, the objectives, the current board,
// the solved count, the completion instant, the deadline and the final result
// are all owned and derived here.
//
// FAIRNESS: `createPuzzleSessionRecord` mints ONE selection seed, commits its
// hash and builds ONE manifest; BOTH seats are written from the same entry, as
// independent copies. Joining never rebuilds anything, and recovery re-reads
// the stored manifest — so both seats provably race the identical set in the
// identical order, under the same absolute GO/deadline instants.
//
// CONCURRENCY: every read-modify-write happens inside a `db.transaction` with
// `.for("update")` on the session row, and the move log's
// `(session_id, seat, ply)` unique key is the backstop against a duplicate or
// racing submission. A conflict is reported as 409, never applied twice.
//
// NO SETTLEMENT: there is no rating, trophy, wager, token or queue code in
// this file, and no such column exists on the table. Puzzle Ranked's reward
// rules are a later phase; practice can never be rated at all.

import { and, desc, eq, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
  solitairePuzzleSessionMoves,
  solitairePuzzleSessions,
  users,
} from "../../db/schema";
import { normalizeMove } from "../solitaire-duel/rules";
import { getServerSeedHash, randomHex } from "../solitaire-duel/seeds";
import { solitaireBotFor } from "../solitaire-duel/bots";
import { PUZZLE_AI_MAX_MOVES_PER_READ, planPuzzleAiSeat } from "./ai";
import { buildPracticeManifest } from "./manifest";
import { readPuzzleRewards, settlePuzzleRankedSession } from "./settlement";
import {
  PUZZLE_BATTLE_FORMAT,
  PUZZLE_SESSION_AI_INACTIVITY_MS,
  PUZZLE_SESSION_DEADLINE_MS,
  PUZZLE_SESSION_FORMAT,
  PUZZLE_SESSION_LIVES,
  PUZZLE_SESSION_MODE,
  PUZZLE_SESSION_PUZZLE_MS,
  PUZZLE_SESSION_REASON,
  PUZZLE_SESSION_RESULT,
  PUZZLE_SESSION_SEAT,
  PUZZLE_SESSION_STATUS,
  SOLITAIRE_PUZZLE_AI_PLAYER_ID,
  type PuzzleSessionMode,
  type PuzzleSessionReason,
  type PuzzleSessionResult,
  type PuzzleSessionSeat,
  type PuzzleSessionStatus,
} from "./constants";
import { buildPuzzleManifest, extendPuzzleManifest } from "./manifest";
import { puzzleSessionView } from "./projection";
import {
  applySeatMove,
  applySeatPuzzleTimeout,
  cloneSeatSnapshot,
  createSeatSnapshot,
  currentManifestEntry,
  isPuzzleSessionDue,
  isPuzzleSessionTerminal,
  otherSeat,
  resolvePuzzleOutcome,
  seatForUser,
  seatSnapshot,
} from "./state";
import type {
  PuzzleManifestEntry,
  PuzzleRankedHistoryEntry,
  PuzzleReward,
  PuzzleSeatSnapshot,
  PuzzleSessionSnapshot,
  PuzzleSessionView,
} from "./types";
import type { Card } from "../solitaire-duel/types";

type SessionRow = typeof solitairePuzzleSessions.$inferSelect;

export type StoreError = { error: string; status: number };

export type PuzzleSessionRead = {
  snapshot: PuzzleSessionSnapshot;
  seat: PuzzleSessionSeat;
  view: PuzzleSessionView;
  /** The viewer's own applied rating/trophy deltas (settled sessions only). */
  reward: PuzzleReward | null;
};

export type PuzzleMoveAccepted = {
  snapshot: PuzzleSessionSnapshot;
  seat: PuzzleSessionSeat;
  view: PuzzleSessionView;
  /** Cards this move legitimately turned face-up. */
  revealed: readonly Card[];
  /** illegal | no-progress | progress | complete — derived by the engine. */
  moveStatus: "no-progress" | "progress" | "complete";
  /** True when a legal move failed to advance the objective and cost a life. */
  lifeLost: boolean;
  /** True when the objective completed and the seat advanced to the next puzzle. */
  advancedPuzzle: boolean;
  /** True when this seat has now solved every puzzle in the manifest. */
  completedSession: boolean;
  /** True when the server settled the session on this move. */
  finished: boolean;
  /** The viewer's own applied rating/trophy deltas when this move settled it. */
  reward: PuzzleReward | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Route-level guard so a non-UUID id can never reach a Postgres uuid cast. */
export function isPuzzleSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Postgres unique-violation, however the driver nested it. */
function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (cursor && typeof cursor === "object" && !seen.has(cursor)) {
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    if (code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** Thrown inside a transaction so the duplicate write is rolled back, not kept. */
class DuplicateMoveError extends Error {}

function instantMs(value: unknown): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function toDate(ms: number | null): Date | null {
  return ms == null ? null : new Date(ms);
}

function err(error: string, status: number): StoreError {
  return { error, status };
}

/**
 * The opponent's display name for a settled result.
 *
 * Read ONLY after a session has finished, from the same users row the platform
 * already uses for handles. The synthetic practice bot has no account, so it
 * is never looked up (its roster name comes from the picker).
 */
async function opponentDisplayName(
  client: any,
  snapshot: PuzzleSessionSnapshot,
  seat: PuzzleSessionSeat,
): Promise<string | null> {
  const id =
    seat === PUZZLE_SESSION_SEAT.PLAYER1
      ? snapshot.player2Id
      : snapshot.player1Id;
  if (!id || id === SOLITAIRE_PUZZLE_AI_PLAYER_ID) return null;
  const [row] = await client
    .select({ name: users.name })
    .from(users)
    .where(eq(users.clerkId, id))
    .limit(1);
  return row?.name ? String(row.name) : null;
}

// ── Row → snapshot ────────────────────────────────────────────────────────

function seatFromRow(row: SessionRow, seat: PuzzleSessionSeat): PuzzleSeatSnapshot {
  const prefix = seat === PUZZLE_SESSION_SEAT.PLAYER1 ? "p1" : "p2";
  const value = <T>(name: string): T =>
    (row as unknown as Record<string, unknown>)[`${prefix}${name}`] as T;
  const stats = value<PuzzleSeatSnapshot["stats"]>("Stats");
  // Lives and the per-puzzle clock live inside the existing seat JSONB under
  // `match`, so this ruleset ships without a database migration (the release
  // pipeline deliberately never runs migrations).
  const match = (stats as unknown as { match?: { lives?: unknown; puzzleDeadlineAtMs?: unknown } })?.match;
  const lives = Number(match?.lives);
  const deadline = Number(match?.puzzleDeadlineAtMs);
  return {
    puzzleIndex: Number(value<number>("PuzzleIndex") ?? 0),
    solved: Number(value<number>("Solved") ?? 0),
    ply: Number(value<number>("Ply") ?? 0),
    state: value<PuzzleSeatSnapshot["state"]>("State"),
    stats,
    lastSolveAtMs: instantMs(value("LastSolveAt")),
    finishedAtMs: instantMs(value("FinishedAt")),
    lastActionAtMs: instantMs(value("LastActionAt")),
    lives: Number.isFinite(lives) ? lives : PUZZLE_SESSION_LIVES,
    puzzleDeadlineAtMs: Number.isFinite(deadline) && deadline > 0 ? deadline : null,
  };
}

/** Map a stored row into the authoritative server snapshot. */
export function sessionRowToSnapshot(row: SessionRow): PuzzleSessionSnapshot {
  const manifest = (row.manifest ?? []) as PuzzleManifestEntry[];
  return {
    id: String(row.id),
    mode: row.mode as PuzzleSessionMode,
    status: row.status as PuzzleSessionStatus,
    player1Id: row.player1Id,
    player2Id: row.player2Id ?? null,
    isAi: Boolean(row.isAi),
    aiDifficulty: row.aiDifficulty ?? null,
    manifest,
    puzzleCount: Number(row.puzzleCount ?? manifest.length),
    endless: row.format === PUZZLE_BATTLE_FORMAT,
    selectionSeed: row.selectionSeed,
    selectionHash: row.selectionHash,
    p1: seatFromRow(row, PUZZLE_SESSION_SEAT.PLAYER1),
    p2: seatFromRow(row, PUZZLE_SESSION_SEAT.PLAYER2),
    goAtMs: instantMs(row.goAt),
    deadlineAtMs: instantMs(row.deadlineAt),
    endedAtMs: instantMs(row.endedAt),
    result: (row.result ?? null) as PuzzleSessionResult | null,
    winnerId: row.winnerId ?? null,
    resolutionReason: (row.resolutionReason ?? null) as PuzzleSessionReason | null,
    createdAtMs: instantMs(row.createdAt) ?? 0,
    updatedAtMs: instantMs(row.updatedAt) ?? 0,
  };
}

/**
 * The per-seat column write for one accepted move.
 *
 * Written as an explicit branch rather than dynamic keys so it is visible at a
 * glance that a move touches ONLY the acting seat's columns.
 */
function statsWithMatch(next: PuzzleSeatSnapshot) {
  return {
    ...next.stats,
    match: {
      lives: next.lives,
      puzzleDeadlineAtMs: next.puzzleDeadlineAtMs,
    },
  };
}

function seatPatchFor(seat: PuzzleSessionSeat, next: PuzzleSeatSnapshot) {
  if (seat === PUZZLE_SESSION_SEAT.PLAYER1) {
    return {
      p1PuzzleIndex: next.puzzleIndex,
      p1Solved: next.solved,
      p1Ply: next.ply,
      p1State: next.state,
      p1Stats: statsWithMatch(next),
      p1LastSolveAt: toDate(next.lastSolveAtMs),
      p1FinishedAt: toDate(next.finishedAtMs),
      p1LastActionAt: toDate(next.lastActionAtMs),
    };
  }
  return {
    p2PuzzleIndex: next.puzzleIndex,
    p2Solved: next.solved,
    p2Ply: next.ply,
    p2State: next.state,
    p2Stats: statsWithMatch(next),
    p2LastSolveAt: toDate(next.lastSolveAtMs),
    p2FinishedAt: toDate(next.finishedAtMs),
    p2LastActionAt: toDate(next.lastActionAtMs),
  };
}

// ── Creation ──────────────────────────────────────────────────────────────

export type CreatePuzzleSessionInput = {
  mode: PuzzleSessionMode;
  player1Id: string;
  player2Id?: string | null;
  isAi?: boolean;
  aiDifficulty?: string | null;
  /** Server-generated selection entropy. Never client-supplied. */
  seed?: string;
  nowMs?: number;
  /** Absolute deadline in ms, or null for an untimed practice session. */
  deadlineAtMs?: number | null;
  /** `playing` starts the shared clock now; `waiting` holds the second seat. */
  status?: PuzzleSessionStatus;
  manifest?: readonly PuzzleManifestEntry[];
  /** Grow the frozen stream as seats advance instead of ending at five. */
  endless?: boolean;
  /** The caller's transaction, so matchmaking writes inside its own lock. */
  tx?: any;
};

/**
 * Insert one session row and return its authoritative snapshot.
 *
 * INTERNAL: no HTTP route exposes this. A future matchmaker calls
 * `createRankedPuzzleSession`; practice calls `createAiPuzzleSession`.
 */
export async function createPuzzleSessionRecord({
  mode,
  player1Id,
  player2Id = null,
  isAi = false,
  aiDifficulty = null,
  seed = randomHex(32),
  nowMs = Date.now(),
  deadlineAtMs = null,
  status,
  manifest,
  endless = false,
  tx,
}: CreatePuzzleSessionInput): Promise<PuzzleSessionSnapshot> {
  // A competitive seat can never be the synthetic practice bot: that seat is
  // unbeatable by construction (it has no account, no clock and no moves), and
  // its presence alone would mark the row as practice.
  if (!isAi && player2Id === SOLITAIRE_PUZZLE_AI_PLAYER_ID) {
    throw new Error("The practice bot cannot hold a competitive puzzle seat");
  }

  const resolvedManifest = manifest
    ? [...manifest]
    : buildPuzzleManifest(seed);
  const first = resolvedManifest[0];
  if (!first) throw new Error("A puzzle session needs at least one puzzle");

  const sessionStatus =
    status ?? (player2Id ? PUZZLE_SESSION_STATUS.PLAYING : PUZZLE_SESSION_STATUS.WAITING);
  const startsNow = sessionStatus === PUZZLE_SESSION_STATUS.PLAYING;
  const goAtMs = startsNow ? nowMs : null;
  const seat1 = createSeatSnapshot(first, {
    deadlineAtMs: startsNow ? nowMs + PUZZLE_SESSION_PUZZLE_MS : null,
  });
  const seat2 = cloneSeatSnapshot(seat1);

  const client: any = tx ?? db;
  const [row] = await client
    .insert(solitairePuzzleSessions)
    .values({
      format: endless ? PUZZLE_BATTLE_FORMAT : PUZZLE_SESSION_FORMAT,
      mode,
      status: sessionStatus,
      player1Id,
      player2Id: player2Id ?? null,
      isAi,
      aiDifficulty,
      puzzleCount: resolvedManifest.length,
      selectionSeed: seed,
      selectionHash: getServerSeedHash(seed),
      manifest: resolvedManifest,
      p1PuzzleIndex: seat1.puzzleIndex,
      p1Solved: seat1.solved,
      p1Ply: seat1.ply,
      p1State: seat1.state,
      p1Stats: seat1.stats,
      p2PuzzleIndex: seat2.puzzleIndex,
      p2Solved: seat2.solved,
      p2Ply: seat2.ply,
      p2State: seat2.state,
      p2Stats: seat2.stats,
      goAt: toDate(goAtMs),
      deadlineAt: toDate(deadlineAtMs),
      updatedAt: new Date(nowMs),
    })
    .returning();

  return sessionRowToSnapshot(row);
}

/**
 * A human-vs-human Puzzle Ranked session.
 *
 * Both seats share ONE manifest and ONE absolute deadline. With no second
 * player the row stays `waiting` with no clock, so a seat can never start
 * racing before its opponent is seated. This function does NOT enter any
 * public matchmaking queue — that flow is a later phase.
 */
export async function createRankedPuzzleSession({
  player1Id,
  player2Id = null,
  nowMs = Date.now(),
  seed = randomHex(32),
  manifest,
  endless = false,
}: {
  player1Id: string;
  player2Id?: string | null;
  nowMs?: number;
  seed?: string;
  manifest?: readonly PuzzleManifestEntry[];
  endless?: boolean;
}): Promise<PuzzleSessionSnapshot> {
  if (player2Id && player2Id === player1Id) {
    throw new Error("A ranked puzzle session needs two different players");
  }
  return createPuzzleSessionRecord({
    mode: PUZZLE_SESSION_MODE.RANKED,
    player1Id,
    player2Id,
    isAi: false,
    seed,
    nowMs,
    deadlineAtMs: player2Id ? nowMs + PUZZLE_SESSION_DEADLINE_MS : null,
    manifest,
    endless,
  });
}

/**
 * A human-vs-AI practice session.
 *
 * The AI occupies seat 2 from the identical frozen start state, so the
 * fairness invariant ("same puzzle, same visible information") is structural
 * rather than a matter of the bot's policy. Practice is untimed, carries no
 * rating/trophy columns and is marked `is_ai`, so no settlement path or public
 * queue can ever pick it up.
 */
export async function createAiPuzzleSession({
  userId,
  difficulty = null,
  nowMs = Date.now(),
  seed = randomHex(32),
  manifest,
  endless = false,
}: {
  userId: string;
  difficulty?: string | null;
  nowMs?: number;
  seed?: string;
  manifest?: readonly PuzzleManifestEntry[];
  endless?: boolean;
}): Promise<PuzzleSessionSnapshot> {
  return createPuzzleSessionRecord({
    mode: PUZZLE_SESSION_MODE.AI,
    player1Id: userId,
    player2Id: SOLITAIRE_PUZZLE_AI_PLAYER_ID,
    isAi: true,
    aiDifficulty: difficulty,
    seed,
    nowMs,
    // Untimed. The only clock is the store's cleanup baseline, never a loss.
    deadlineAtMs: null,
    status: PUZZLE_SESSION_STATUS.PLAYING,
    manifest,
    endless,
  });
}

/**
 * Create a Puzzle vs AI practice session against one of the SIX shipped bots.
 *
 * The bot id is resolved through the existing roster (`solitaireBotFor`), so the
 * stored `ai_difficulty` is exactly the identity the duel already uses and the
 * lobby already renders. An unknown id falls back to Ace, exactly like every
 * other legacy row in the platform; the HTTP route rejects it first.
 */
export async function createPuzzlePracticeSession({
  userId,
  botId,
  level = null,
  puzzleCount = 1,
  nowMs = Date.now(),
  seed = randomHex(32),
  manifest,
}: {
  userId: string;
  botId: string;
  level?: number | null;
  puzzleCount?: number;
  nowMs?: number;
  seed?: string;
  manifest?: readonly PuzzleManifestEntry[];
}): Promise<PuzzleSessionSnapshot> {
  const bot = solitaireBotFor(botId);
  return createAiPuzzleSession({
    userId,
    difficulty: bot.id,
    nowMs,
    seed,
    manifest: manifest ?? buildPracticeManifest({ seed, level, count: puzzleCount }),
    endless: manifest ? false : true,
  });
}

/** The documented practice cleanup window, exposed for the retention sweep. */
export const PUZZLE_SESSION_ABANDON_AFTER_MS = PUZZLE_SESSION_AI_INACTIVITY_MS;

// ── Deadline finalization ─────────────────────────────────────────────────

/**
 * Settle a live session whose absolute deadline has passed.
 *
 * Runs inside the caller's row-locked transaction, so the settlement is stamped
 * once: the `status` flip is the guard, and a later pass over the same row is a
 * no-op. The result is derived from the stored solved counts and solve
 * instants — never from a client claim.
 */
async function finalizeIfDue(tx: any, row: SessionRow, nowMs: number): Promise<SessionRow> {
  const snapshot = sessionRowToSnapshot(row);
  if (!isPuzzleSessionDue(snapshot, nowMs)) return row;

  const outcome = resolvePuzzleOutcome(snapshot, nowMs);
  if (!outcome) return row;

  const [updated] = await tx
    .update(solitairePuzzleSessions)
    .set({
      status: PUZZLE_SESSION_STATUS.FINISHED,
      result: outcome.result,
      winnerId: outcome.winnerId,
      resolutionReason: outcome.reason,
      endedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(eq(solitairePuzzleSessions.id, snapshot.id))
    .returning();

  const finalRow = updated ?? row;
  // The status flip above IS the once-only settlement guard: this runs inside
  // the same row-locked transaction that ended the session, and a later pass
  // over the row is no longer due.
  await settlePuzzleRankedSession(tx, sessionRowToSnapshot(finalRow));
  return finalRow;
}

function withManifestCapacity(
  snapshot: PuzzleSessionSnapshot,
  neededIndex: number,
): PuzzleSessionSnapshot {
  if (!snapshot.endless || snapshot.manifest.length > neededIndex) return snapshot;
  const manifest = extendPuzzleManifest(
    snapshot.manifest,
    snapshot.selectionSeed,
    neededIndex + 1,
  );
  return { ...snapshot, manifest, puzzleCount: manifest.length };
}

/**
 * Expire one seat's 60-second puzzle clock on a server read.
 *
 * A timeout costs a life and starts the next puzzle with a fresh clock. The
 * third loss finishes the match immediately, so the opponent wins without
 * needing to move again.
 */
async function expireSeatClock(
  tx: any,
  row: SessionRow,
  seat: PuzzleSessionSeat,
  nowMs: number,
): Promise<SessionRow> {
  const snapshot = sessionRowToSnapshot(row);
  const mine = seatSnapshot(snapshot, seat);
  if (mine.puzzleDeadlineAtMs == null || nowMs < mine.puzzleDeadlineAtMs) {
    return row;
  }

  const working = withManifestCapacity(snapshot, mine.puzzleIndex + 1);
  const timed = applySeatPuzzleTimeout({
    manifest: working.manifest,
    seat: mine,
    nowMs,
  });
  if (!timed.expired) return row;

  let next: PuzzleSessionSnapshot =
    seat === PUZZLE_SESSION_SEAT.PLAYER1
      ? { ...working, p1: timed.seat }
      : { ...working, p2: timed.seat };
  let finished = false;
  const outcome = resolvePuzzleOutcome(next, nowMs);
  if (outcome) {
    next = {
      ...next,
      status: PUZZLE_SESSION_STATUS.FINISHED,
      result: outcome.result,
      winnerId: outcome.winnerId,
      resolutionReason: outcome.reason,
      endedAtMs: nowMs,
    };
    finished = true;
  }

  const [updated] = await tx
    .update(solitairePuzzleSessions)
    .set({
      ...seatPatchFor(seat, timed.seat),
      manifest: next.manifest,
      puzzleCount: next.puzzleCount,
      ...(finished
        ? {
            status: next.status,
            result: next.result,
            winnerId: next.winnerId,
            resolutionReason: next.resolutionReason,
            endedAt: toDate(next.endedAtMs),
          }
        : {}),
      updatedAt: new Date(nowMs),
    })
    .where(eq(solitairePuzzleSessions.id, snapshot.id))
    .returning();

  if (finished && updated) {
    await settlePuzzleRankedSession(tx, sessionRowToSnapshot(updated));
  }
  return updated ?? row;
}

// ── AI practice pacing ────────────────────────────────────────────────────

/**
 * Let the practice bot play every move that has come due.
 *
 * A request does not just return the bot's last position: it advances the bot
 * by `planPuzzleAiSeat`, which applies the bot's own legal moves through the
 * same `applySeatMove` transition the human uses. The row lock makes the advance
 * once-only per due instant, and each move is appended to the same move log, so
 * a reload can never rewind or replay bot progress.
 *
 * The bot is deliberately advanced only from server reads/moves (there is no
 * background worker), which keeps practice request-driven and deterministic.
 */
async function advancePuzzleAi(
  tx: any,
  row: SessionRow,
  nowMs: number,
): Promise<SessionRow> {
  let snapshot = sessionRowToSnapshot(row);
  if (snapshot.mode !== PUZZLE_SESSION_MODE.AI) return row;
  if (snapshot.status !== PUZZLE_SESSION_STATUS.PLAYING) return row;
  if (!snapshot.aiDifficulty) return row;

  // Keep enough frozen stream for every move this read might apply.
  snapshot = withManifestCapacity(
    snapshot,
    snapshot.p2.puzzleIndex + PUZZLE_AI_MAX_MOVES_PER_READ + 2,
  );

  let p2 = snapshot.p2;
  // The bot owns the same 60-second puzzle clock as a human seat. A blown
  // clock costs it a life and starts the next puzzle fresh.
  const timed = applySeatPuzzleTimeout({
    manifest: snapshot.manifest,
    seat: p2,
    nowMs,
  });
  if (timed.expired) p2 = timed.seat;

  let finished = false;
  if ((p2.lives ?? 0) > 0) {
    const advance = planPuzzleAiSeat({ snapshot: { ...snapshot, p2 }, nowMs });
    if (advance) {
      for (const move of advance.moves) {
        await tx.insert(solitairePuzzleSessionMoves).values({
          sessionId: snapshot.id,
          seat: PUZZLE_SESSION_SEAT.PLAYER2,
          ply: move.ply,
          puzzleIndex: move.puzzleIndex,
          kind: move.kind,
          move: move.move,
          createdAt: new Date(move.atMs),
        });
      }
      p2 = advance.seat;
    }
  }

  let next: PuzzleSessionSnapshot = { ...snapshot, p2 };
  const outcome = resolvePuzzleOutcome(next, nowMs);
  if (outcome) {
    next = {
      ...next,
      status: PUZZLE_SESSION_STATUS.FINISHED,
      result: outcome.result,
      winnerId: outcome.winnerId,
      resolutionReason: outcome.reason,
      endedAtMs: nowMs,
    };
    finished = true;
  }

  if (p2 === snapshot.p2 && !finished && !timed.expired) return row;

  const [updated] = await tx
    .update(solitairePuzzleSessions)
    .set({
      ...seatPatchFor(PUZZLE_SESSION_SEAT.PLAYER2, next.p2),
      manifest: next.manifest,
      puzzleCount: next.puzzleCount,
      ...(finished
        ? {
            status: next.status,
            result: next.result,
            winnerId: next.winnerId,
            resolutionReason: next.resolutionReason,
            endedAt: toDate(next.endedAtMs),
          }
        : {}),
      updatedAt: new Date(nowMs),
    })
    .where(eq(solitairePuzzleSessions.id, snapshot.id))
    .returning();

  return updated ?? row;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * The authoritative snapshot for one participant.
 *
 * A non-participant gets a 403 and no data at all — not even the puzzle
 * metadata. A ranked session past its deadline is settled ON READ, so a race
 * can never be left live just because nobody happened to move.
 */
export async function fetchPuzzleSession({
  userId,
  sessionId,
  nowMs = Date.now(),
}: {
  userId: string;
  sessionId: string;
  nowMs?: number;
}): Promise<PuzzleSessionRead | StoreError> {
  if (!isPuzzleSessionId(sessionId)) return err("Invalid sessionId", 400);

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(solitairePuzzleSessions)
      .where(eq(solitairePuzzleSessions.id, sessionId))
      .for("update");

    if (!row) return err("Puzzle session not found", 404);

    const snapshot = sessionRowToSnapshot(row);
    const seat = seatForUser(snapshot, userId);
    if (!seat) return err("You are not a participant in this session", 403);

    // Practice: the bot moves first, so the read returns the position it has
    // actually reached by now. (A ranked row is untouched by this call.)
    const advanced = await advancePuzzleAi(tx, row, nowMs);
    const expired = await expireSeatClock(tx, advanced, seat, nowMs);
    const current = await finalizeIfDue(tx, expired, nowMs);
    const snapshotNow = sessionRowToSnapshot(current);
    const reward =
      snapshotNow.status === PUZZLE_SESSION_STATUS.FINISHED
        ? (await readPuzzleRewards({
            tx,
            matchIds: [snapshotNow.id],
            clerkId: userId,
          }))[snapshotNow.id] ?? null
        : null;
    return { snapshot: snapshotNow, seat, reward } as const;
  });

  if ("error" in result) return result as StoreError;
  const opponentName =
    result.snapshot.status === PUZZLE_SESSION_STATUS.FINISHED
      ? await opponentDisplayName(db, result.snapshot, result.seat)
      : null;
  return {
    ...result,
    view: puzzleSessionView(result.snapshot, result.seat, nowMs, {
      reward: result.reward,
      opponentName,
    }),
  };
}

/** The append-only accepted-move log for one session, in play order. */
export async function listPuzzleSessionMoves({
  sessionId,
}: {
  sessionId: string;
}): Promise<
  Array<{
    seat: PuzzleSessionSeat;
    ply: number;
    puzzleIndex: number;
    kind: string;
    move: unknown;
  }>
> {
  if (!isPuzzleSessionId(sessionId)) return [];
  const rows = await db
    .select()
    .from(solitairePuzzleSessionMoves)
    .where(eq(solitairePuzzleSessionMoves.sessionId, sessionId))
    .orderBy(solitairePuzzleSessionMoves.ply);
  return rows.map((row) => ({
    seat: row.seat as PuzzleSessionSeat,
    ply: Number(row.ply),
    puzzleIndex: Number(row.puzzleIndex),
    kind: row.kind,
    move: row.move,
  }));
}

// ── Forfeit / abandonment ─────────────────────────────────────────────────

/**
 * Concede a session, or cancel your own still-waiting search.
 *
 * A LIVE match is settled by the server: the opponent is the winner,
 * `resolution_reason` is `forfeit`, and the once-only settlement runs inside
 * this same row-locked transaction. A waiting search is merely cancelled and
 * settles nothing. Calling this on a terminal session is idempotent and can
 * never settle a second time.
 */
export async function forfeitPuzzleSession({
  userId,
  sessionId,
  nowMs = Date.now(),
}: {
  userId: string;
  sessionId: string;
  nowMs?: number;
}): Promise<PuzzleSessionRead | StoreError> {
  if (!isPuzzleSessionId(sessionId)) return err("Invalid sessionId", 400);

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(solitairePuzzleSessions)
      .where(eq(solitairePuzzleSessions.id, sessionId))
      .for("update");

    if (!row) return err("Puzzle session not found", 404);

    const snapshot = sessionRowToSnapshot(row);
    const seat = seatForUser(snapshot, userId);
    if (!seat) return err("You are not a participant in this session", 403);

    if (isPuzzleSessionTerminal(snapshot)) {
      return { snapshot, seat } as const;
    }

    if (snapshot.status === PUZZLE_SESSION_STATUS.WAITING) {
      const [cancelled] = await tx
        .update(solitairePuzzleSessions)
        .set({
          status: PUZZLE_SESSION_STATUS.CANCELLED,
          endedAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        })
        .where(eq(solitairePuzzleSessions.id, snapshot.id))
        .returning();
      // A cancelled search never settles: there was no match to decide.
      return { snapshot: sessionRowToSnapshot(cancelled ?? row), seat } as const;
    }

    if (!snapshot.player2Id || snapshot.player2Id === snapshot.player1Id) {
      return err("This session has no opponent", 409);
    }

    const winnerId =
      snapshot.player1Id === userId ? snapshot.player2Id : snapshot.player1Id;
    const lostSeat =
      seat === PUZZLE_SESSION_SEAT.PLAYER1
        ? PUZZLE_SESSION_RESULT.PLAYER2
        : PUZZLE_SESSION_RESULT.PLAYER1;

    const [updated] = await tx
      .update(solitairePuzzleSessions)
      .set({
        status: PUZZLE_SESSION_STATUS.FINISHED,
        result: lostSeat,
        winnerId,
        resolutionReason: PUZZLE_SESSION_REASON.FORFEIT,
        endedAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      })
      .where(eq(solitairePuzzleSessions.id, snapshot.id))
      .returning();

    const next = sessionRowToSnapshot(updated ?? row);
    await settlePuzzleRankedSession(tx, next);
    return { snapshot: next, seat } as const;
  });

  if ("error" in result) return result as StoreError;

  const reward =
    result.snapshot.status === PUZZLE_SESSION_STATUS.FINISHED
      ? (await readPuzzleRewards({
          tx: db,
          matchIds: [result.snapshot.id],
          clerkId: userId,
        }))[result.snapshot.id] ?? null
      : null;

  const opponentName =
    result.snapshot.status === PUZZLE_SESSION_STATUS.FINISHED
      ? await opponentDisplayName(db, result.snapshot, result.seat)
      : null;

  return {
    ...result,
    reward,
    view: puzzleSessionView(result.snapshot, result.seat, nowMs, {
      reward,
      opponentName,
    }),
  };
}

// ── History ───────────────────────────────────────────────────────────────

/**
 * The caller's settled Puzzle Ranked matches, newest first.
 *
 * Authorisation is by stored seat. Each entry carries only what both
 * participants could already see (solved counts, server-stamped solve
 * instants, the result) plus the CALLER'S OWN applied rating/trophy deltas
 * read from the shared journals. No board, manifest, stock order or solution
 * is read, let alone sent.
 */
export async function listPuzzleRankedHistory({
  userId,
  limit = 20,
  nowMs = Date.now(),
}: {
  userId: string;
  limit?: number;
  nowMs?: number;
}): Promise<PuzzleRankedHistoryEntry[]> {
  const capped = Math.min(50, Math.max(1, Number(limit) || 20));

  const rows = await db
    .select()
    .from(solitairePuzzleSessions)
    .where(
      and(
        eq(solitairePuzzleSessions.mode, PUZZLE_SESSION_MODE.RANKED),
        sql`${solitairePuzzleSessions.status} IN (${PUZZLE_SESSION_STATUS.FINISHED}, ${PUZZLE_SESSION_STATUS.CANCELLED})`,
        or(
          eq(solitairePuzzleSessions.player1Id, userId),
          eq(solitairePuzzleSessions.player2Id, userId),
        ),
      ),
    )
    .orderBy(desc(solitairePuzzleSessions.createdAt))
    .limit(capped);

  const snapshots = rows.map((row) => sessionRowToSnapshot(row));
  const rewards = await readPuzzleRewards({
    tx: db,
    matchIds: snapshots.map((snapshot) => snapshot.id),
    clerkId: userId,
  });

  const entries: PuzzleRankedHistoryEntry[] = [];
  for (const snapshot of snapshots) {
    // The SQL narrows the scan; these guards make the contract explicit and
    // keep a row that is not the caller's settled match out of the history.
    if (snapshot.mode !== PUZZLE_SESSION_MODE.RANKED) continue;
    if (snapshot.status !== PUZZLE_SESSION_STATUS.FINISHED && snapshot.status !== PUZZLE_SESSION_STATUS.CANCELLED) {
      continue;
    }
    if (snapshot.manifest.length === 0) continue;
    const seat = seatForUser(snapshot, userId);
    if (!seat) continue;
    const mine = seatSnapshot(snapshot, seat);
    const theirs = seatSnapshot(snapshot, otherSeat(seat));
    const reward = rewards[snapshot.id] ?? null;
    entries.push({
      sessionId: snapshot.id,
      seat,
      status: snapshot.status,
      opponentId:
        seat === PUZZLE_SESSION_SEAT.PLAYER1
          ? snapshot.player2Id
          : snapshot.player1Id,
      puzzleCount: snapshot.puzzleCount,
      youSolved: mine.solved,
      opponentSolved: theirs.solved,
      youLastSolveAtMs: mine.lastSolveAtMs,
      opponentLastSolveAtMs: theirs.lastSolveAtMs,
      goAtMs: snapshot.goAtMs,
      deadlineAtMs: snapshot.deadlineAtMs,
      endedAtMs: snapshot.endedAtMs,
      createdAtMs: snapshot.createdAtMs,
      result: puzzleSessionView(snapshot, seat, nowMs, { reward }).result,
    });
  }
  return entries;
}

// ── Moves ─────────────────────────────────────────────────────────────────

/**
 * Take one puzzle move for one seat.
 *
 * Order of checks, each of which refuses WITHOUT mutating anything:
 * payload shape → session exists → caller holds a seat → session is live →
 * the shared clock has started → the deadline has not passed → the cursor is
 * current → the move is legal on the server's board. Only then is the seat's
 * own columns patch written and the move appended to the log.
 */
export async function submitPuzzleMove({
  userId,
  sessionId,
  move,
  expectedPly,
  nowMs = Date.now(),
}: {
  userId: string;
  sessionId: string;
  /** The only client-authored move payload. Re-derived server-side. */
  move: unknown;
  /** The acting seat's expected ply, for staleness and duplicate detection. */
  expectedPly?: number;
  nowMs?: number;
}): Promise<PuzzleMoveAccepted | StoreError> {
  if (!isPuzzleSessionId(sessionId)) return err("Invalid sessionId", 400);

  const normalized = normalizeMove(move);
  // `in` rather than a truthiness check: this repo compiles with `strict: false`,
  // where a boolean-literal discriminant does not narrow the union.
  if ("error" in normalized) return err(normalized.error, 400);

  if (
    expectedPly !== undefined &&
    (!Number.isInteger(expectedPly) || (expectedPly as number) < 0)
  ) {
    return err("expectedPly must be a non-negative integer", 400);
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(solitairePuzzleSessions)
        .where(eq(solitairePuzzleSessions.id, sessionId))
        .for("update");

      if (!row) return err("Puzzle session not found", 404);

      const snapshot = sessionRowToSnapshot(row);

      // Membership is decided from the stored seats, never from the request.
      const seat = seatForUser(snapshot, userId);
      if (!seat) return err("You are not a participant in this session", 403);

      if (isPuzzleSessionTerminal(snapshot)) {
        return err("This puzzle session has ended", 409);
      }
      if (snapshot.status === PUZZLE_SESSION_STATUS.WAITING) {
        return err("This puzzle session is waiting for an opponent", 409);
      }
      if (snapshot.goAtMs != null && nowMs < snapshot.goAtMs) {
        return err("This puzzle session has not started", 409);
      }
      if (isPuzzleSessionDue(snapshot, nowMs)) {
        // Settle the result first, then refuse: a post-deadline move is never
        // applied, but the timeout outcome is persisted rather than lost.
        await finalizeIfDue(tx, row, nowMs);
        return err("The puzzle session deadline has passed", 409);
      }

      const mine = seatSnapshot(snapshot, seat);
      if (mine.puzzleDeadlineAtMs != null && nowMs >= mine.puzzleDeadlineAtMs) {
        // The clock is authoritative: persist the lost life (and any finished
        // result) before refusing the late move.
        await expireSeatClock(tx, row, seat, nowMs);
        return err(
          "Your 60-second puzzle clock expired; a life was lost",
          409,
        );
      }
      if (expectedPly !== undefined && expectedPly !== mine.ply) {
        return err(
          `Stale move: the server is at ply ${mine.ply}, not ${expectedPly}`,
          409,
        );
      }

      // Endless battles grow their frozen stream before a seat steps past its
      // current end, so a solve can never terminate the match by exhaustion.
      const working = withManifestCapacity(snapshot, mine.puzzleIndex + 1);
      const entry = currentManifestEntry(working.manifest, mine);
      if (!entry) return err("This seat has finished every puzzle", 409);

      const applied = applySeatMove({
        manifest: working.manifest,
        seat: mine,
        move: normalized.move,
        nowMs,
      });
      if (applied.status === "illegal") {
        return err("Illegal move", 422);
      }

      // Append FIRST: the unique (session, seat, ply) key is the duplicate /
      // racing-submission backstop, and a collision rolls the whole transaction
      // back instead of leaving a half-applied board.
      try {
        await tx.insert(solitairePuzzleSessionMoves).values({
          sessionId: snapshot.id,
          seat,
          ply: mine.ply,
          puzzleIndex: mine.puzzleIndex,
          kind: normalized.move.kind,
          move: normalized.move,
          createdAt: new Date(nowMs),
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new DuplicateMoveError();
        throw error;
      }

      let next: PuzzleSessionSnapshot =
        seat === PUZZLE_SESSION_SEAT.PLAYER1
          ? { ...working, p1: applied.seat }
          : { ...working, p2: applied.seat };
      let finished = false;

      if (
        snapshot.mode === PUZZLE_SESSION_MODE.AI &&
        seat === PUZZLE_SESSION_SEAT.PLAYER1 &&
        applied.completedSession
      ) {
        // Practice is untimed and single-player-per-seat: the human's own
        // completion ends it. The bot seat never decides a result.
        next = {
          ...next,
          status: PUZZLE_SESSION_STATUS.FINISHED,
          result: PUZZLE_SESSION_RESULT.PLAYER1,
          winnerId: snapshot.player1Id,
          resolutionReason: PUZZLE_SESSION_REASON.FINISH,
          endedAtMs: nowMs,
        };
        finished = true;
      } else {
        // Practice: the bot answers inside the SAME transaction, using the same
        // engine and the same move log. The human's accepted move starts the
        // clock for it; the bot is still paced by its own profile.
        if (snapshot.mode === PUZZLE_SESSION_MODE.AI) {
          const advance = planPuzzleAiSeat({ snapshot: next, nowMs });
          if (advance) {
            for (const entry of advance.moves) {
              await tx.insert(solitairePuzzleSessionMoves).values({
                sessionId: snapshot.id,
                seat: PUZZLE_SESSION_SEAT.PLAYER2,
                ply: entry.ply,
                puzzleIndex: entry.puzzleIndex,
                kind: entry.kind,
                move: entry.move,
                createdAt: new Date(entry.atMs),
              });
            }
            next = { ...next, p2: advance.seat };
          }
        }

        const outcome = resolvePuzzleOutcome(next, nowMs);
        if (outcome) {
          next = {
            ...next,
            status: PUZZLE_SESSION_STATUS.FINISHED,
            result: outcome.result,
            winnerId: outcome.winnerId,
            resolutionReason: outcome.reason,
            endedAtMs: nowMs,
          };
          finished = true;
        }
      }

      await tx
        .update(solitairePuzzleSessions)
        .set({
          ...seatPatchFor(PUZZLE_SESSION_SEAT.PLAYER1, next.p1),
          ...seatPatchFor(PUZZLE_SESSION_SEAT.PLAYER2, next.p2),
          manifest: next.manifest,
          puzzleCount: next.puzzleCount,
          status: next.status,
          result: next.result,
          winnerId: next.winnerId,
          resolutionReason: next.resolutionReason,
          endedAt: toDate(next.endedAtMs),
          updatedAt: new Date(nowMs),
        })
        .where(eq(solitairePuzzleSessions.id, snapshot.id));

      // Settle inside the same transaction, exactly once: the row lock plus the
      // status flip are the guard, and the shared writers journal per match.
      if (finished) await settlePuzzleRankedSession(tx, next);
      const reward = finished
        ? (await readPuzzleRewards({ tx, matchIds: [next.id], clerkId: userId }))[next.id] ?? null
        : null;
      // The popup names the person this seat beat or lost to; the lookup only
      // runs for a settled ranked row, never during a live poll.
      const opponentName = finished
        ? await opponentDisplayName(tx, next, seat)
        : null;

      return {
        snapshot: next,
        seat,
        view: puzzleSessionView(next, seat, nowMs, { reward, opponentName }),
        revealed: applied.revealed,
        moveStatus: applied.status as "no-progress" | "progress" | "complete",
        lifeLost: applied.lifeLost,
        advancedPuzzle: applied.advancedPuzzle,
        completedSession: applied.completedSession,
        finished,
        reward,
      } as const;
    });
  } catch (error) {
    if (error instanceof DuplicateMoveError) {
      return err("This move has already been applied", 409);
    }
    throw error;
  }
}
