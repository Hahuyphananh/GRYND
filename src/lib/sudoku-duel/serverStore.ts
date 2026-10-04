// src/lib/sudoku-duel/serverStore.ts
//
// The server-authoritative Sudoku Duel match store. Every state transition
// happens inside a row-locked `db.transaction` here, and the API routes are thin
// wrappers around these functions.
//
// TRUST BOUNDARY: the ONLY player-authored value that reaches this module is an
// ACTION — "place value V at cell I" or "clear cell I". The board, the correct
// count, the mistake count, the penalty, the completion, the completion instant,
// the winner, the match result, the rating change and the trophies are all
// derived by the server from its own state. A client cannot submit a score, a
// winner, a completion time, a progress value, a mistake count, an Elo value or a
// trophy — no such field is ever read, anywhere in this file.
//
// FAIRNESS: `createOrJoin` mints ONE server seed, commits its hash and derives
// ONE puzzle for the match row. Both `p1_state` and `p2_state` are created as
// copies of that single clue grid, and joining NEVER regenerates anything — so
// the two seats provably start from the identical puzzle. Each seat's actions are
// written to that seat's own columns, so one board can never alter the other.
//
// SETTLEMENT reuses the platform's existing rating/trophy infrastructure
// (`applyRatingResult` / `applyTrophyResult`) inside the SAME transaction that
// finalises the match, exactly once — the guard is the `status` flip to
// `finished` under a `FOR UPDATE` lock, plus those helpers' own
// (user, game, match)-keyed idempotency journals. There is NO second Elo
// implementation and NO wager/token/payout path anywhere in this file.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
  ratingEvents,
  sudokuDuelMatches,
  sudokuDuelMoves,
  trophyEvents,
  users,
} from "../../db/schema";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { mirrorQueueCreated, mirrorQueueTransition } from "../canonicalQueueLifecycle";
import {
  ACTION_CODES,
  DEFAULT_DIFFICULTY,
  INACTIVITY_ALARM_MS,
  INACTIVITY_FORFEIT_MS,
  MATCH_STATUS,
  MAX_MOVES_PER_SEAT,
  READY_COUNTDOWN_MS,
  RESOLUTION,
  RESULT,
  SEAT,
  SUDOKU_DUEL_AI_PLAYER_ID,
  SUDOKU_DUEL_LOCK_NAMESPACE,
  TERMINAL_STATUSES,
  VARIANT,
  VARIANT_VERSION,
} from "./constants";
import { coerceAiDifficulty } from "../aiDifficulty";
import { aiMoveDelayMs, planAiMoves } from "./ai";
import { coerceSudokuDifficulty, generatePuzzle } from "./generator";
import {
  cloneSeatState,
  emptyGrid,
  failureOf,
  initialStateFromPuzzle,
  isGrid,
  isWellFormedSeatState,
  judgeAction,
  normalizeAction,
  opponentProgressFor,
  otherSeat,
  progressOf,
  raceFactsFor,
  resolveSudokuRace,
  seatForUser,
  seatProgressFor,
  userIdForSeat,
  viewForState,
} from "./rules";
import { derivePuzzleSeed, getServerSeedHash, randomHex } from "./seeds.js";
import type {
  Grid,
  Seat,
  SeatProgress,
  Seats,
  SudokuAction,
  SudokuProgress,
  SudokuPuzzle,
  SudokuRaceOutcome,
  SudokuSeatRace,
  SudokuSeatState,
  SudokuVerdict,
} from "./types";

// The rated/trophy game key is written as a string literal at every settlement
// call site (rather than a shared constant) on purpose: the platform's
// settlement-wiring audits scan source for `gameKey: "<key>"` to prove every
// rated game is wired to a shared writer, and a constant reference would be
// invisible to that check.

type MatchRow = typeof sudokuDuelMatches.$inferSelect;

export type StoreError = { error: string; status: number };

/**
 * Result of resolving a disconnected participant.
 *
 * Spelled as an explicit union rather than inferred: the route narrows it with
 * `"error" in result`, and this repo compiles with `strict: false`, where an
 * INFERRED union of structurally-similar object literals collapses and the
 * narrowing branch becomes `never`.
 */
export type DisconnectResult =
  | { match: MatchRow; forfeited: boolean; cancelled: boolean }
  | StoreError;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Route-level guard so a non-UUID id can never reach a Postgres uuid cast. */
export function isMatchId(value: unknown): value is string {
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

/** An instant column as epoch ms, or null. */
function instantMs(value: unknown): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function err(error: string, status: number): StoreError {
  return { error, status };
}

// ── Puzzle + seats ────────────────────────────────────────────────────────

/**
 * The authoritative puzzle record for a row.
 *
 * `solution` is carried here (the server needs it to judge actions) but is NEVER
 * placed on the client DTO — `matchToDto` builds that field by field.
 */
export function puzzleForMatch(match: MatchRow): SudokuPuzzle {
  const puzzle: Grid = isGrid(match.puzzle) ? match.puzzle : emptyGrid();
  const solution: Grid = isGrid(match.solution) ? match.solution : emptyGrid();
  return {
    variant: match.variant,
    variantVersion: Number(match.variantVersion) || VARIANT_VERSION,
    difficulty: coerceSudokuDifficulty(match.difficulty),
    seed: Number(match.puzzleSeed) >>> 0,
    puzzle,
    solution,
    givens: Number(match.givens) || 0,
  };
}

export function seatsFromRow(match: {
  player1Id: string;
  player2Id?: string | null;
}): Seats {
  return { player1Id: match.player1Id, player2Id: match.player2Id ?? null };
}

/** True when `userId` occupies either seat. */
export function isParticipant(
  match: { player1Id: string; player2Id?: string | null },
  userId: string | null,
): boolean {
  return Boolean(seatForUser(seatsFromRow(match), userId));
}

/** A seat's own authoritative board — the accessor that keeps one seat's board private. */
export function stateForSeat(match: MatchRow, seat: Seat): SudokuSeatState | null {
  const raw = seat === SEAT.PLAYER1 ? match.p1State : match.p2State;
  return (raw ?? null) as SudokuSeatState | null;
}

function raceFor(match: MatchRow, seat: Seat, forfeited = false): SudokuSeatRace {
  const puzzle = puzzleForMatch(match);
  return raceFactsFor({
    userId: userIdForSeat(seatsFromRow(match), seat),
    state: stateForSeat(match, seat),
    puzzle: puzzle.puzzle,
    solution: puzzle.solution,
    forfeited,
  });
}

// ── Inactivity (the untimed match's one rule) ─────────────────────────────

/** A seat's own last accepted action instant, or null before its first action. */
function lastActionMsForSeat(match: MatchRow, seat: Seat): number | null {
  const raw = seat === SEAT.PLAYER1 ? match.p1LastActionAt : match.p2LastActionAt;
  return instantMs(raw);
}

/** What a seat's inactivity is measured from: its last action, else GO. */
function inactivityBaselineMs(match: MatchRow, seat: Seat): number | null {
  const goAtMs = instantMs(match.goAt) ?? instantMs(match.startedAt);
  return lastActionMsForSeat(match, seat) ?? goAtMs;
}

/** The instant a threshold fires for `seat`, or null before the clock starts. */
function inactivityAtMs(
  match: MatchRow,
  seat: Seat | null,
  thresholdMs: number,
): number | null {
  // A practice match is fully untimed: the human may think as long as they like,
  // so no inactivity clock is even projected for it.
  if (!seat || match.isAi) return null;
  const base = inactivityBaselineMs(match, seat);
  return base == null ? null : base + thresholdMs;
}

function inactivityMsForSeat(match: MatchRow, seat: Seat, nowMs: number): number | null {
  const base = inactivityBaselineMs(match, seat);
  return base == null ? null : Math.max(0, nowMs - base);
}

/**
 * The seat that has gone inactive past the forfeit threshold, or null.
 *
 * Per seat and measured from that seat's own last action, so one player's
 * activity can never keep the other's clock alive. A seat that already completed
 * is never forfeited. When BOTH seats are past the threshold the more idle one
 * loses, and an exact tie (two seats that never acted, checked at the same
 * instant) is a draw rather than an arbitrary winner.
 */
function inactivityForfeitSeat(match: MatchRow, nowMs: number): Seat | "both" | null {
  // A practice match is never forfeited for inactivity — it has no clock at all.
  if (match.isAi) return null;
  if (match.status !== MATCH_STATUS.PLAYING || !match.player2Id) return null;
  const idle1 = inactivityMsForSeat(match, SEAT.PLAYER1, nowMs);
  const idle2 = inactivityMsForSeat(match, SEAT.PLAYER2, nowMs);
  const done1 = Boolean(stateForSeat(match, SEAT.PLAYER1)?.completed);
  const done2 = Boolean(stateForSeat(match, SEAT.PLAYER2)?.completed);
  const due1 = !done1 && idle1 != null && idle1 >= INACTIVITY_FORFEIT_MS;
  const due2 = !done2 && idle2 != null && idle2 >= INACTIVITY_FORFEIT_MS;
  if (!due1 && !due2) return null;
  if (due1 && due2) {
    if (idle1 === idle2) return "both";
    return (idle1 as number) > (idle2 as number) ? SEAT.PLAYER1 : SEAT.PLAYER2;
  }
  return due1 ? SEAT.PLAYER1 : SEAT.PLAYER2;
}

/** The per-seat column write that resets a seat's inactivity clock. */
function seatLastActionPatchFor(seat: Seat, nowMs: number) {
  return seat === SEAT.PLAYER1
    ? { p1LastActionAt: new Date(nowMs) }
    : { p2LastActionAt: new Date(nowMs) };
}

/**
 * The per-seat column write for one accepted action.
 *
 * Written as an explicit branch rather than dynamic keys so the patch is
 * type-checked and readable — and so it is visible at a glance that an action
 * touches ONLY the acting seat's columns.
 */
function seatPatchFor(seat: Seat, state: SudokuSeatState, correctCells: number) {
  if (seat === SEAT.PLAYER1) {
    return {
      p1State: state,
      p1Ply: state.ply,
      p1Correct: correctCells,
      p1Mistakes: state.mistakes,
      p1PenaltyMs: state.penaltyMs,
    };
  }
  return {
    p2State: state,
    p2Ply: state.ply,
    p2Correct: correctCells,
    p2Mistakes: state.mistakes,
    p2PenaltyMs: state.penaltyMs,
  };
}

function seatFinishedPatchFor(seat: Seat, nowMs: number) {
  return seat === SEAT.PLAYER1
    ? { p1FinishedAt: new Date(nowMs) }
    : { p2FinishedAt: new Date(nowMs) };
}

// ── DTOs ──────────────────────────────────────────────────────────────────

/**
 * Client-facing DTO for a match row, from `viewerId`'s perspective.
 *
 * Built field by field, never by spreading the row: the row holds BOTH seats'
 * boards AND the authoritative solution, so a spread would leak the answer key
 * in one line. The board here is the viewer's OWN projected view (whose shape
 * cannot carry a solution), and the opponent appears only as the closed
 * `OpponentProgress` shape.
 *
 * The board is included only once `playing`, so neither seat can study the puzzle
 * before the race is live — it is revealed to both from the same server state, at
 * the same moment.
 */
export function matchToDto(match: MatchRow, viewerId: string | null, nowMs = Date.now()) {
  const seats = seatsFromRow(match);
  const seat = seatForUser(seats, viewerId);
  const terminal = TERMINAL_STATUSES.includes(match.status);
  const revealed = match.status === MATCH_STATUS.PLAYING || terminal;
  const ownState = seat ? stateForSeat(match, seat) : null;
  const opponentSeat = seat ? otherSeat(seat) : null;
  const otherState = opponentSeat ? stateForSeat(match, opponentSeat) : null;
  const puzzle = puzzleForMatch(match);

  return {
    matchId: String(match.id),
    variant: match.variant,
    variantVersion: match.variantVersion,
    difficulty: puzzle.difficulty,
    givens: Number(match.givens) || 0,
    status: match.status,
    result: match.result ?? null,
    resolutionReason: match.resolutionReason ?? null,
    winnerId: match.winnerId ?? null,
    seat,
    isParticipant: Boolean(seat),
    // A free practice match against the bot. The opponent panel uses it to
    // label the seat "GRYND AI" and the result screen to skip the rated copy.
    isAi: Boolean(match.isAi),
    aiDifficulty: match.isAi ? coerceAiDifficulty(match.aiDifficulty) : null,
    // The commitment is public from creation; the seed itself is only revealed
    // once the match is terminal, so the puzzle can be verified after the fact.
    seedHash: match.serverSeedHash,
    serverSeed: terminal ? match.serverSeed : null,
    // NOT public before terminal: the puzzle seed is all a client needs to
    // regenerate the puzzle AND solve it (the generator is deterministic and
    // client-safe), so revealing it early would hand out the answer. It is
    // disclosed alongside the server seed once the match can no longer be
    // affected by it.
    puzzleSeed: terminal ? Number(match.puzzleSeed) >>> 0 : null,
    goAtMs: instantMs(match.goAt),
    // The viewer's OWN inactivity clock: last action (or GO) plus each threshold.
    // Derived per viewer, so a client can raise its own alarm, and a read can
    // resolve the forfeit server-side.
    inactivityAlarmAtMs: inactivityAtMs(match, seat, INACTIVITY_ALARM_MS),
    inactivityForfeitAtMs: inactivityAtMs(match, seat, INACTIVITY_FORFEIT_MS),
    // The OPPONENT's inactivity clock, so the active seat can be told the other
    // side is about to forfeit. Null in a waiting lobby and in practice.
    opponentInactivityAlarmAtMs: inactivityAtMs(match, opponentSeat, INACTIVITY_ALARM_MS),
    opponentInactivityForfeitAtMs: inactivityAtMs(match, opponentSeat, INACTIVITY_FORFEIT_MS),
    startedAtMs: instantMs(match.startedAt),
    endedAtMs: instantMs(match.endedAt),
    createdAtMs: instantMs(match.createdAt),
    /** Server clock, so a client can render an accurate timer without trusting its own. */
    serverNow: nowMs,
    // The viewer's OWN board, projected so it cannot carry a solution.
    view: revealed && ownState ? viewForState({ puzzle, grid: ownState.grid, ply: ownState.ply }) : null,
    progress: ownState ? seatProgressFor(puzzle.puzzle, puzzle.solution, ownState) : null,
    completed: Boolean(ownState?.completed),
    // The viewer's OWN completion instant (the server stamped it in the seat
    // state when the final cell was judged correct). It is the viewer's own
    // fact, so exposing it leaks nothing — and it is what lets the result
    // screen state the real completion time and the ADJUSTED competitive time
    // (completion − GO, plus the per-mistake penalty) without re-deriving them.
    completedAtMs: ownState?.completedAtMs ?? null,
    mistakeCount: ownState?.mistakes ?? 0,
    penaltyMs: ownState?.penaltyMs ?? 0,
    opponent:
      revealed && otherState && opponentSeat
        ? opponentProgressFor(opponentSeat, puzzle.puzzle, puzzle.solution, otherState)
        : null,
  };
}

/**
 * The public lobby entry for an open match.
 *
 * Deliberately narrower than the match DTO: an open lobby is visible to anyone,
 * so it must expose nothing but "a Sudoku Duel is waiting" — no puzzle, no
 * board, no solution, no seed, not even a player id.
 */
export function lobbyEntry(match: MatchRow, nowMs = Date.now()) {
  return {
    matchId: String(match.id),
    variant: match.variant,
    difficulty: coerceSudokuDifficulty(match.difficulty),
    givens: Number(match.givens) || 0,
    status: match.status,
    open: match.status === MATCH_STATUS.WAITING && !match.player2Id,
    seedHash: match.serverSeedHash,
    createdAtMs: instantMs(match.createdAt),
    serverNow: nowMs,
  };
}

// ── Lobby / matchmaking ───────────────────────────────────────────────────

/** Open lobbies, oldest first (the order create-or-join fills them in). */
export async function listOpenMatches({ limit = 30 }: { limit?: number } = {}) {
  return await db
    .select()
    .from(sudokuDuelMatches)
    .where(
      and(
        eq(sudokuDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(sudokuDuelMatches.player2Id),
      ),
    )
    .orderBy(sql`${sudokuDuelMatches.createdAt} ASC`)
    .limit(limit);
}

/** The caller's own still-waiting lobby, if any. */
export async function listMyWaitingMatch({ userId }: { userId: string }) {
  const [row] = await db
    .select()
    .from(sudokuDuelMatches)
    .where(
      and(
        eq(sudokuDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(sudokuDuelMatches.player2Id),
        eq(sudokuDuelMatches.player1Id, userId),
      ),
    )
    .orderBy(sql`${sudokuDuelMatches.createdAt} ASC`)
    .limit(1);
  return row ?? null;
}

/**
 * Match the caller into an open lobby, or open a new one.
 *
 * The whole operation runs under a single advisory lock (per-game namespace) so
 * two concurrent callers can never both see "no open lobby" and each create one,
 * and so a caller can never join a lobby that is being cancelled.
 */
export async function createOrJoin({
  userId,
  nowMs = Date.now(),
}: {
  userId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SUDOKU_DUEL_LOCK_NAMESPACE}, 0)`,
    );

    const [open] = await tx
      .select()
      .from(sudokuDuelMatches)
      .where(
        and(
          eq(sudokuDuelMatches.status, MATCH_STATUS.WAITING),
          isNull(sudokuDuelMatches.player2Id),
        ),
      )
      .orderBy(sql`${sudokuDuelMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (open) {
      // The caller's own lobby — return it rather than creating a second.
      if (open.player1Id === userId) return { match: open, joined: false } as const;
      return await joinExistingMatch(tx, open.id, userId, nowMs);
    }

    return await createWaitingMatch(tx, userId, nowMs);
  });
}

/**
 * Open a lobby, seeding the match.
 *
 * The seed, its commitment, the derived puzzle seed and the puzzle are all minted
 * here, once. BOTH boards are written from that one puzzle in the same INSERT, so
 * "both players receive the exact same puzzle, clues and difficulty" is a
 * structural property of the row rather than something a join path has to
 * remember to do.
 */
async function createWaitingMatch(tx: any, userId: string, nowMs: number) {
  // Server-generated entropy only. Never client-supplied, never Math.random().
  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);
  const puzzleSeed = derivePuzzleSeed({ serverSeed, variantVersion: VARIANT_VERSION });
  const generated = generatePuzzle({
    seed: puzzleSeed,
    difficulty: DEFAULT_DIFFICULTY,
    variantVersion: VARIANT_VERSION,
  });

  // The SAME clues initialise both seats — two independent copies of one opening
  // position, so neither seat's board can alias the other's.
  const opening = initialStateFromPuzzle(generated.puzzle);

  const [match] = await tx
    .insert(sudokuDuelMatches)
    .values({
      variant: VARIANT,
      variantVersion: VARIANT_VERSION,
      difficulty: generated.difficulty,
      player1Id: userId,
      status: MATCH_STATUS.WAITING,
      serverSeed,
      serverSeedHash,
      puzzleSeed,
      puzzle: generated.puzzle,
      solution: generated.solution,
      givens: generated.givens,
      p1State: opening,
      p2State: cloneSeatState(opening),
      p1Ply: 0,
      p2Ply: 0,
      p1Correct: 0,
      p2Correct: 0,
      p1Mistakes: 0,
      p2Mistakes: 0,
      p1PenaltyMs: 0,
      p2PenaltyMs: 0,
    })
    .returning();

  mirrorQueueCreated({
    gameKey: "sudoku-duel",
    matchId: match.id,
    playerCount: 1,
    queuedAt: match.createdAt ? new Date(match.createdAt) : undefined,
  });

  return { match, joined: false } as const;
}

/**
 * Fill the open lobby and start the race.
 *
 * NOTHING about the puzzle is touched here: seat 2's board already holds its copy
 * of the shared clues, so joining cannot introduce a second puzzle. The only work
 * is the synchronized clock — an absolute GO instant on the server's clock, from
 * which both seats' inactivity clocks start. Actions before `go_at` are refused,
 * so the countdown is a shared planning window rather than dead time.
 */
async function joinExistingMatch(tx: any, candidateId: string, userId: string, nowMs: number) {
  const [match] = await tx
    .select()
    .from(sudokuDuelMatches)
    .where(eq(sudokuDuelMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Match is no longer available", status: 409 } as const;
  }

  const goAtMs = nowMs + READY_COUNTDOWN_MS;

  const [updated] = await tx
    .update(sudokuDuelMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.PLAYING,
      goAt: new Date(goAtMs),
      // Both seats' inactivity clocks start at GO. No deadline is armed: the
      // match is untimed and only ends by completion, forfeit, disconnect or
      // the inactivity rule in `resolveInactivityDue`.
      p1LastActionAt: new Date(goAtMs),
      p2LastActionAt: new Date(goAtMs),
      startedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(sudokuDuelMatches.id, candidateId),
        eq(sudokuDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(sudokuDuelMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    // Another joiner raced us and won the conditional UPDATE.
    return { error: "Match is no longer available", status: 409 } as const;
  }

  mirrorQueueCreated({
    gameKey: "sudoku-duel",
    matchId: updated.id,
    playerCount: 2,
    queuedAt: updated.createdAt ? new Date(updated.createdAt) : undefined,
  });

  return { match: updated, joined: true } as const;
}

// ── Practice bot ──────────────────────────────────────────────────────────

/**
 * Start a free practice match against the built-in bot.
 *
 * Practice is UNRATED: the row is `isAi`, so finalization skips ratings,
 * trophies, win counters and the queue mirror entirely, and it never enters the
 * open lobby pool (the bot occupies player2 immediately). The bot is also
 * untimed: `inactivityAtMs` / `inactivityForfeitSeat` both short-circuit on
 * `isAi`, so the human may think as long as they like and only the bot's
 * completion can end the match from its side.
 *
 * NOTHING about the puzzle is special-cased: the same server seed → puzzle seed
 * → generator path as a real lobby runs here, and the bot races the SAME puzzle
 * from player2. The only additions are the `playing` status, the chosen tier and
 * the synchronized GO clock, so the human gets the identical countdown a joined
 * lobby would have.
 */
export async function createAiMatch({
  userId,
  difficulty,
  nowMs = Date.now(),
}: {
  userId: string;
  difficulty?: unknown;
  nowMs?: number;
}) {
  const tier = coerceAiDifficulty(difficulty);

  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);
  const puzzleSeed = derivePuzzleSeed({ serverSeed, variantVersion: VARIANT_VERSION });
  const generated = generatePuzzle({
    seed: puzzleSeed,
    difficulty: DEFAULT_DIFFICULTY,
    variantVersion: VARIANT_VERSION,
  });

  const opening = initialStateFromPuzzle(generated.puzzle);
  const goAtMs = nowMs + READY_COUNTDOWN_MS;

  const [match] = await db
    .insert(sudokuDuelMatches)
    .values({
      variant: VARIANT,
      variantVersion: VARIANT_VERSION,
      difficulty: generated.difficulty,
      player1Id: userId,
      player2Id: SUDOKU_DUEL_AI_PLAYER_ID,
      status: MATCH_STATUS.PLAYING,
      isAi: true,
      aiDifficulty: tier,
      serverSeed,
      serverSeedHash,
      puzzleSeed,
      puzzle: generated.puzzle,
      solution: generated.solution,
      givens: generated.givens,
      p1State: opening,
      p2State: cloneSeatState(opening),
      p1Ply: 0,
      p2Ply: 0,
      p1Correct: 0,
      p2Correct: 0,
      p1Mistakes: 0,
      p2Mistakes: 0,
      p1PenaltyMs: 0,
      p2PenaltyMs: 0,
      goAt: new Date(goAtMs),
      // Both seats' inactivity clocks start at GO (the bot's is never read).
      p1LastActionAt: new Date(goAtMs),
      p2LastActionAt: new Date(goAtMs),
      startedAt: new Date(nowMs),
    })
    .returning();

  return { match } as const;
}

/**
 * Advance the practice bot's board to the server's current instant.
 *
 * THE BOT'S TURN. Sudoku Duel is simultaneous, so the bot is paced by the clock
 * rather than by a turn hand-off: at `nowMs` it is allowed
 * `floor((nowMs - goAt) / delay)` actions, and this plays that many derived
 * placements in one pass (or until the puzzle is solved). Calling it on every
 * read is what guarantees the bot genuinely plays and can never be skipped —
 * its progress does not depend on a client calling an endpoint.
 *
 * Each action is judged by the SAME `judgeAction` a human's action goes through,
 * at the SIMULATED instant the move was "due" (`goAt + ply × delay`), so the
 * bot's completion instant is the instant it actually solved the shared puzzle
 * rather than the instant a read happened to run — which is what lets a photo
 * finish be decided fairly.
 *
 * Idempotent and monotonic: a no-op for a non-AI row, an unstarted row, or a
 * call that lands between two of the bot's moves. A write happens only when at
 * least one action was played, and the completion is finalized inside the same
 * transaction.
 */
export async function advanceAiMatch({
  matchId,
  nowMs = Date.now(),
}: {
  matchId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(sudokuDuelMatches)
      .where(eq(sudokuDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);
    if (!match.isAi || match.status !== MATCH_STATUS.PLAYING || !match.player2Id) {
      return { match, advanced: false } as const;
    }

    const goAtMs = instantMs(match.goAt);
    if (goAtMs == null || nowMs < goAtMs) return { match, advanced: false } as const;

    const seat = SEAT.PLAYER2;
    const state = stateForSeat(match, seat);
    if (!state || !isWellFormedSeatState(state) || state.completed) {
      return { match, advanced: false } as const;
    }

    const delayMs = aiMoveDelayMs(match.aiDifficulty);
    const allowedPly = Math.floor((nowMs - goAtMs) / delayMs);
    const maxMoves = Math.max(
      0,
      Math.min(allowedPly - state.ply, MAX_MOVES_PER_SEAT - state.ply),
    );
    if (maxMoves <= 0) return { match, advanced: false } as const;

    const puzzle = puzzleForMatch(match);
    const startPly = state.ply;
    let current = cloneSeatState(state);
    const played: SudokuAction[] = [];

    for (let n = 0; n < maxMoves; n += 1) {
      const plan = planAiMoves({
        grid: current.grid,
        maxMoves: 1,
        difficulty: match.aiDifficulty,
      });
      const action = plan.actions[0];
      if (!action) break;
      const judged = judgeAction({
        puzzle: puzzle.puzzle,
        solution: puzzle.solution,
        state: current,
        action,
        nowMs: goAtMs + (startPly + n + 1) * delayMs,
      });
      const rejection = failureOf(judged);
      if (rejection) break;
      const ok = judged as {
        ok: true;
        state: SudokuSeatState;
        progress: SudokuProgress;
      };
      current = ok.state;
      played.push(action);
      if (current.completed) break;
    }

    if (played.length === 0) return { match, advanced: false } as const;

    for (let n = 0; n < played.length; n += 1) {
      await tx.insert(sudokuDuelMoves).values({
        matchId: match.id,
        seat,
        ply: startPly + n,
        kind: played[n].kind,
        action: played[n],
      });
    }

    const progress = progressOf(puzzle.puzzle, current.grid, puzzle.solution);
    const [updated] = await tx
      .update(sudokuDuelMatches)
      .set({
        ...seatPatchFor(seat, current, progress.correctEntries),
        // Every bot action resets the bot's own inactivity clock.
        p2LastActionAt: new Date(nowMs),
        ...(current.completed && !state.completed
          ? { p2FinishedAt: new Date(current.completedAtMs ?? nowMs) }
          : {}),
        updatedAt: new Date(nowMs),
      })
      .where(eq(sudokuDuelMatches.id, match.id))
      .returning();

    const changed = updated ?? match;
    let finalRow = changed;
    const outcome = resolveSudokuRace({
      player1: raceFor(changed, SEAT.PLAYER1),
      player2: raceFor(changed, SEAT.PLAYER2),
    });
    if (outcome) finalRow = await finalizeMatch(tx, changed, outcome, nowMs);

    return { match: finalRow, advanced: true } as const;
  });
}

/** Advance the bot (when the row is a practice match) and return the row. */
async function advanceAiIfPractice(match: MatchRow, nowMs: number): Promise<MatchRow> {
  if (!match.isAi || match.status !== MATCH_STATUS.PLAYING) return match;
  const advanced = await advanceAiMatch({ matchId: match.id, nowMs });
  return "error" in advanced ? match : advanced.match;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * The authoritative snapshot for the calling participant.
 *
 * A match in which a seat has gone inactive is resolved ON READ, so a match can
 * never be left live just because nobody happened to move — the same
 * lazy-resolution pattern Solitaire Duel and Speed Typing use. Non-participants
 * get a 403; there is no spectator mode.
 */
export async function fetchMatch({
  userId,
  matchId,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}) {
  let [match] = await db
    .select()
    .from(sudokuDuelMatches)
    .where(eq(sudokuDuelMatches.id, matchId));

  if (!match) return err("Match not found", 404);

  const seats = seatsFromRow(match);
  if (!seatForUser(seats, userId)) {
    return err("Not a participant of this match", 403);
  }

  // For a practice match the bot is advanced to NOW first, so every poll shows
  // its live board progress (and finalizes the match the instant it solves the
  // puzzle). A human row is untouched by this step.
  match = await advanceAiIfPractice(match, nowMs);

  // An untimed match is resolved on READ when a seat has gone inactive, so a
  // match can never be left live just because the idle seat stopped polling.
  if (isInactivityDue(match, nowMs)) {
    await resolveInactivityDue({ matchId, nowMs });
    [match] = await db
      .select()
      .from(sudokuDuelMatches)
      .where(eq(sudokuDuelMatches.id, matchId));
  }

  return { match, dto: matchToDto(match, userId, nowMs) } as const;
}

/** The append-only action log for one seat, oldest first. */
export async function fetchSeatMoves(matchId: string, seat: Seat) {
  return await db
    .select({
      ply: sudokuDuelMoves.ply,
      kind: sudokuDuelMoves.kind,
      action: sudokuDuelMoves.action,
      createdAt: sudokuDuelMoves.createdAt,
    })
    .from(sudokuDuelMoves)
    .where(
      and(
        eq(sudokuDuelMoves.matchId, matchId),
        eq(sudokuDuelMoves.seat, seat),
      ),
    )
    .orderBy(sql`${sudokuDuelMoves.ply} ASC`);
}

/**
 * The rating/trophy movement the settlement wrote for ONE participant of a
 * settled match.
 *
 * Read straight off the two shared journals (`rating_events` / `trophy_events`,
 * keyed uniquely by (user, game, match)) that `applyRatingResult` and
 * `applyTrophyResult` write inside the settling transaction. This function only
 * READS: it cannot move a rating, a trophy, a result or an Elo value, and it
 * ignores every argument but the caller's own identity and the match id — so it
 * can never be used to settle, re-settle or forge anything.
 *
 * Because the journals are the (user, game, match)-keyed idempotency guard the
 * writers themselves use, a match that was settled exactly once has exactly one
 * row here, and a settlement that was refused (an unregistered game key, an AI
 * match, a cancelled lobby) leaves no row at all — in which case this returns
 * null and the result screen simply shows no movement rather than inventing one.
 *
 * The same rows are the platform's match history for a rated duel: opponent,
 * both ratings and the delta, per side.
 */
export type SudokuSettlementMovement = {
  outcome: "win" | "loss" | "draw";
  elo: { before: number; after: number; delta: number } | null;
  trophies: { before: number; after: number; delta: number } | null;
} | null;

export async function settlementForMatch({
  clerkId,
  matchId,
}: {
  clerkId: string | null | undefined;
  matchId: string | null | undefined;
}): Promise<SudokuSettlementMovement> {
  if (!clerkId || !matchId) return null;

  // The journals key on `users.id`, so resolve the caller's account row first —
  // the ledger is only ever read for the signed-in identity, never for an id
  // supplied by the request.
  const [account] = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, String(clerkId)))
    .limit(1);
  const userId = account?.id;
  if (!userId) return null;

  const [rating] = await db
    .select()
    .from(ratingEvents)
    .where(
      and(
        eq(ratingEvents.userId, userId),
        eq(ratingEvents.gameKey, "sudoku-duel"),
        eq(ratingEvents.matchId, String(matchId)),
      ),
    )
    .limit(1);

  const [trophy] = await db
    .select()
    .from(trophyEvents)
    .where(
      and(
        eq(trophyEvents.userId, userId),
        eq(trophyEvents.gameKey, "sudoku-duel"),
        eq(trophyEvents.matchId, String(matchId)),
      ),
    )
    .limit(1);

  if (!rating && !trophy) return null;

  const rawOutcome = String(rating?.outcome ?? trophy?.outcome ?? "");
  const outcome: "win" | "loss" | "draw" =
    rawOutcome === "win" || rawOutcome === "loss" || rawOutcome === "draw"
      ? rawOutcome
      : "draw";

  const movement = (
    row: { ratingBefore?: unknown; ratingAfter?: unknown; trophiesBefore?: unknown; trophiesAfter?: unknown; delta?: unknown } | undefined,
  ) =>
    row
      ? {
          before: Number(row.ratingBefore ?? row.trophiesBefore) || 0,
          after: Number(row.ratingAfter ?? row.trophiesAfter) || 0,
          delta: Number(row.delta) || 0,
        }
      : null;

  return { outcome, elo: movement(rating), trophies: movement(trophy) };
}

/** True when a live match has a seat past the inactivity forfeit threshold. */
function isInactivityDue(match: MatchRow, nowMs: number): boolean {
  return inactivityForfeitSeat(match, nowMs) != null;
}

// ── Action (the only player-authored mutation) ────────────────────────────

export type MoveResult =
  | {
      match: MatchRow;
      verdict: SudokuVerdict;
      correct: boolean;
      progress: SeatProgress;
      ply: number;
      completed: boolean;
      raceResolved: boolean;
    }
  | StoreError;

/**
 * Take one action.
 *
 * The request carries ONLY `{ action, expectedPly }`. Anything else a client
 * might send — a board, a solution, a correct-cell count, a progress figure, a
 * mistake count, a completion flag, a completion instant, a winner, a score, an
 * Elo delta, a trophy — is not read: the sequence
 *   normalizeAction → judgeAction → persist
 * runs entirely inside the row-locked transaction below, against the server's own
 * puzzle and solution.
 *
 * A CORRECT placement is written and advances verified progress. An INCORRECT one
 * is NOT written and does NOT reveal the answer: it increments the mistake count,
 * adds the +1s penalty and leaves progress unchanged — but the action itself is
 * accepted, and the response says `correct: false`.
 *
 * Rejections, in order:
 *   400 the action is not even the right shape
 *   404 match not found
 *   403 caller holds no seat              (before status: never leak status)
 *   409 waiting for an opponent
 *   409 match is no longer active
 *   409 the race has not started yet      (before `go_at`)
 *   409 a seat forfeited for inactivity   (and the match resolves)
 *   409 the seat has already finished
 *   400 malformed `expectedPly`
 *   409 stale `expectedPly` — refetch
 *   409 the per-seat action cap is reached
 *   422 the action is well-formed but not applicable (a clue cell, an
 *       out-of-range value, an already-correct cell, an empty cell to clear)
 */
export async function submitMove({
  userId,
  matchId,
  action,
  expectedPly,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  action: unknown;
  expectedPly?: unknown;
  nowMs?: number;
}): Promise<MoveResult> {
  // Shape-check BEFORE any database work, so a malformed payload is rejected
  // without a transaction and can never reach the board.
  const parsed = normalizeAction(action);
  const malformed = failureOf(parsed);
  if (malformed) return err(malformed.error, 400);
  // Narrowed once, explicitly: `strict: false` does not narrow on `parsed.ok`.
  const normalized = parsed as { ok: true; action: SudokuAction };

  try {
    return await db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(sudokuDuelMatches)
        .where(eq(sudokuDuelMatches.id, matchId))
        .for("update");

      if (!match) return err("Match not found", 404);

      const seats = seatsFromRow(match);
      const seat = seatForUser(seats, userId);
      if (!seat) return err("Not a participant of this match", 403);
      if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
        return err("Waiting for an opponent", 409);
      }
      if (TERMINAL_STATUSES.includes(match.status)) {
        return err("Match is no longer active", 409);
      }

      // Timing is decided from the server's clock against server-written
      // instants. A client cannot act early, and cannot act past the limit.
      const goAtMs = instantMs(match.goAt);
      if (goAtMs == null || nowMs < goAtMs) {
        return err("The match has not started", 409);
      }
      // An untimed match: an action that arrives after a seat has already gone
      // inactive resolves that forfeit first.
      if (isInactivityDue(match, nowMs)) {
        await resolveInactivityDueInTx(tx, match, nowMs);
        return err("A seat forfeited for inactivity", 409);
      }

      const state = stateForSeat(match, seat);
      if (!state || !isWellFormedSeatState(state)) {
        return err("The match state is not playable", 409);
      }
      if (state.completed) {
        return err("You have already completed the puzzle", 409);
      }

      // Strict, uncoerced staleness guard: the same idempotency contract that
      // makes a retried POST a no-op instead of a second accepted action.
      if (expectedPly !== undefined && expectedPly !== null) {
        if (
          typeof expectedPly !== "number" ||
          !Number.isInteger(expectedPly) ||
          expectedPly < 0
        ) {
          return err("Invalid expectedPly", 400);
        }
        if (expectedPly !== state.ply) {
          return err("Stale move — refetch the match", 409);
        }
      }
      if (state.ply >= MAX_MOVES_PER_SEAT) {
        return err("Action limit reached", 409);
      }

      const puzzle = puzzleForMatch(match);
      const judged = judgeAction({
        puzzle: puzzle.puzzle,
        solution: puzzle.solution,
        state,
        action: normalized.action,
        nowMs,
      });
      const rejection = failureOf(judged);
      if (rejection) {
        // A malformed envelope is a client error; anything else is a well-formed
        // action that simply does not apply to this board/cell.
        return err(
          rejection.error,
          rejection.code === ACTION_CODES.BAD_ACTION ? 400 : 422,
        );
      }

      // Narrowed once, explicitly: `strict: false` does not narrow on `ok`.
      const ok = judged as {
        ok: true;
        verdict: SudokuVerdict;
        correct: boolean;
        state: SudokuSeatState;
        progress: SudokuProgress;
      };
      const nextState = ok.state;
      const progress = ok.progress;
      const correctCells = progress.correctEntries;
      const completedNow = Boolean(nextState.completed) && !state.completed;

      // Append-only log: the validated input, at the ply it was played. The
      // (match_id, seat, ply) unique index is the structural anti-replay.
      await tx.insert(sudokuDuelMoves).values({
        matchId: match.id,
        seat,
        ply: state.ply,
        kind: normalized.action.kind,
        action: normalized.action,
      });

      const [updated] = await tx
        .update(sudokuDuelMatches)
        .set({
          ...seatPatchFor(seat, nextState, correctCells),
          // The accepted action resets this seat's own inactivity clock.
          ...seatLastActionPatchFor(seat, nowMs),
          ...(completedNow ? seatFinishedPatchFor(seat, nowMs) : {}),
          updatedAt: new Date(nowMs),
        })
        .where(eq(sudokuDuelMatches.id, match.id))
        .returning();

      const changed = updated ?? match;

      // Only a completion (or a forfeit) can end the race mid-flight, so this is
      // where "an adjusted-time winner is decided the moment a board is filled"
      // is enforced.
      let finalRow = changed;
      const outcome = resolveSudokuRace({
        player1: raceFor(changed, SEAT.PLAYER1),
        player2: raceFor(changed, SEAT.PLAYER2),
      });
      if (outcome) finalRow = await finalizeMatch(tx, changed, outcome, nowMs);

      return {
        match: finalRow,
        verdict: ok.verdict,
        correct: ok.correct,
        progress: seatProgressFor(puzzle.puzzle, puzzle.solution, nextState),
        ply: state.ply,
        completed: Boolean(nextState.completed),
        raceResolved: Boolean(outcome),
      } as const;
    });
  } catch (error) {
    // A replayed ply lost the race and was rejected by the storage-layer unique
    // index. The transaction has already rolled back, so report a clean 409
    // rather than a 500.
    if (isUniqueViolation(error)) {
      return err("Move already recorded", 409);
    }
    throw error;
  }
}

// ── Resolution ───────────────────────────────────────────────────────────

export type DueResolution =
  | { match: MatchRow; resolved: boolean }
  | StoreError;

// ── Inactivity resolution ─────────────────────────────────────────────────

/**
 * Resolve a live match in which a seat has gone inactive past the forfeit
 * threshold, awarding the opponent the win.
 *
 * Safe to call at any time and from any path: it re-checks the status under the
 * row lock and does nothing unless a seat is genuinely, still, idle. This is the
 * only path that can end a match nobody is playing.
 */
export async function resolveInactivityDue({
  matchId,
  nowMs = Date.now(),
}: {
  matchId: string;
  nowMs?: number;
}): Promise<DueResolution> {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(sudokuDuelMatches)
      .where(eq(sudokuDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);
    return await resolveInactivityDueInTx(tx, match, nowMs);
  });
}

async function resolveInactivityDueInTx(
  tx: any,
  match: MatchRow,
  nowMs: number,
): Promise<{ match: MatchRow; resolved: boolean }> {
  const forfeitSeat = inactivityForfeitSeat(match, nowMs);
  if (!forfeitSeat) return { match, resolved: false };

  // The idle seat forfeits; `resolveSudokuRace` awards the win to the other
  // seat. The result is derived here from the row, never from the request.
  const outcome = resolveSudokuRace(
    forfeitSeat === "both"
      ? {
          player1: raceFor(match, SEAT.PLAYER1, true),
          player2: raceFor(match, SEAT.PLAYER2, true),
        }
      : {
          player1: raceFor(match, SEAT.PLAYER1, forfeitSeat === SEAT.PLAYER1),
          player2: raceFor(match, SEAT.PLAYER2, forfeitSeat === SEAT.PLAYER2),
        },
  );
  if (!outcome) return { match, resolved: false };

  const finalRow = await finalizeMatch(tx, match, outcome, nowMs);
  return { match: finalRow, resolved: true };
}

// ── Forfeit / cancel ──────────────────────────────────────────────────────

/** Concede: the opponent wins the match, with the same settlement path. */
export async function forfeitMatch({
  userId,
  matchId,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(sudokuDuelMatches)
      .where(eq(sudokuDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);

    const seats = seatsFromRow(match);
    const seat = seatForUser(seats, userId);
    if (!seat) return err("Not a participant of this match", 403);
    if (TERMINAL_STATUSES.includes(match.status)) {
      return err("Match is no longer active", 409);
    }
    if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
      return err("Only an active match can be forfeited", 409);
    }

    // The conceding seat is the forfeiting one; the ladder awards the win to the
    // other seat. Nothing about the result came from the request.
    const outcome = resolveSudokuRace({
      player1: raceFor(match, SEAT.PLAYER1, seat === SEAT.PLAYER1),
      player2: raceFor(match, SEAT.PLAYER2, seat === SEAT.PLAYER2),
    });

    const finalRow = await finalizeMatch(
      tx,
      match,
      outcome ?? ({ result: "draw", resolution: RESOLUTION.DRAW } as SudokuRaceOutcome),
      nowMs,
    );

    return { match: finalRow } as const;
  });
}

/** Cancel an open lobby. Only the creator, and only while still waiting. */
export async function cancelMatch({
  userId,
  matchId,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(sudokuDuelMatches)
      .where(eq(sudokuDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);
    if (match.player1Id !== userId) {
      return err("Only the lobby creator can cancel it", 403);
    }
    if (match.status !== MATCH_STATUS.WAITING || match.player2Id) {
      return err("Only a waiting lobby can be cancelled", 409);
    }

    const [updated] = await tx
      .update(sudokuDuelMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        endedAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      })
      .where(eq(sudokuDuelMatches.id, match.id))
      .returning();

    mirrorQueueTransition({
      gameKey: "sudoku-duel",
      matchId: match.id,
      status: "cancelled",
      playerCount: 1,
      cancelReason: "cancelled_by_player",
      at: new Date(nowMs),
    });

    // A cancelled lobby never settled, so no rating, trophy or win counter
    // moves — settleSudokuDuelMatch is deliberately not called here.
    return { match: updated ?? match } as const;
  });
}

/**
 * Resolve a match whose participant stayed disconnected past the realtime grace
 * window.
 *
 *   • active match → the opponent is awarded the win (standard settlement)
 *   • open lobby   → cancelled, so an abandoned lobby never lingers
 *   • terminal     → no-op, reported (not an error) so the realtime retry loop
 *                    stops instead of hammering the endpoint
 */
export async function forfeitMatchOnDisconnect({
  userId,
  matchId,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}): Promise<DisconnectResult> {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(sudokuDuelMatches)
      .where(eq(sudokuDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);

    const seats = seatsFromRow(match);
    const seat = seatForUser(seats, userId);
    if (!seat) return err("Not a participant of this match", 403);

    if (TERMINAL_STATUSES.includes(match.status)) {
      return { match, forfeited: false, cancelled: false } as const;
    }

    // Still an open lobby: release it. There is no opponent to award a win to,
    // and a cancelled lobby never settles, so no rating or stat is touched.
    if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
      const [updated] = await tx
        .update(sudokuDuelMatches)
        .set({
          status: MATCH_STATUS.CANCELLED,
          endedAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        })
        .where(eq(sudokuDuelMatches.id, match.id))
        .returning();

      mirrorQueueTransition({
        gameKey: "sudoku-duel",
        matchId: match.id,
        status: "cancelled",
        playerCount: 1,
        cancelReason: "disconnected",
        at: new Date(nowMs),
      });

      return { match: updated ?? match, forfeited: false, cancelled: true } as const;
    }

    // Active match: award the opponent the win, with the standard settlement.
    const outcome = resolveSudokuRace({
      player1: raceFor(match, SEAT.PLAYER1, seat === SEAT.PLAYER1),
      player2: raceFor(match, SEAT.PLAYER2, seat === SEAT.PLAYER2),
    });

    const finalRow = await finalizeMatch(
      tx,
      match,
      outcome ?? ({ result: "draw", resolution: RESOLUTION.DRAW } as SudokuRaceOutcome),
      nowMs,
    );

    return { match: finalRow, forfeited: true, cancelled: false } as const;
  });
}

// ── Finalisation + settlement (existing platform infrastructure only) ─────

/**
 * Flip a match terminal, exactly once, and settle it.
 *
 * The single write path for `status`, `result`, `winner_id`, `resolution_reason`
 * and `ended_at` — reached by a completion and by a forfeit, so there is one
 * place a result can ever come from. The `TERMINAL_STATUSES` guard
 * plus the caller's `FOR UPDATE` read is what makes a second attempt a no-op
 * rather than a second settlement.
 */
async function finalizeMatch(
  tx: any,
  match: MatchRow,
  outcome: SudokuRaceOutcome,
  nowMs: number,
): Promise<MatchRow> {
  if (TERMINAL_STATUSES.includes(match.status)) return match;

  const seats = seatsFromRow(match);
  const winnerId =
    outcome.result === RESULT.DRAW ? null : userIdForSeat(seats, outcome.result);

  const [updated] = await tx
    .update(sudokuDuelMatches)
    .set({
      status: MATCH_STATUS.FINISHED,
      result: outcome.result,
      winnerId,
      resolutionReason: outcome.resolution,
      endedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(eq(sudokuDuelMatches.id, match.id))
    .returning();

  const finalRow = updated ?? match;

  await settleSudokuDuelMatch(tx, finalRow, outcome);

  // A free-practice match would be excluded from the canonical queue entirely,
  // so it must not mirror a transition either.
  if (!finalRow.isAi) {
    mirrorQueueTransition({
      gameKey: "sudoku-duel",
      matchId: finalRow.id,
      status: "completed",
      playerCount: 2,
      cancelReason: null,
      at: new Date(nowMs),
    });
  }

  return finalRow;
}

/**
 * Record the outcome of a finished Sudoku Duel match.
 *
 * Reuses the platform's Elo (`applyRatingResult`) and trophy
 * (`applyTrophyResult`) helpers — there is deliberately no Sudoku-specific rating
 * maths. Both are called with the store's transaction so the match finalisation
 * and the rating change commit atomically, and both are idempotent per
 * (user, game, match) via their own event journals.
 *
 * No wager, no token, no payout: the game is unstaked, so the only account stats
 * touched are `users.gamesWon` / `users.gamesLost`. The leaderboard counters are
 * deliberately NOT called because `applyLeaderboardCounters` is wager-gated.
 *
 * A DRAW is journaled by both helpers (with `result: "draw"`) but changes neither
 * win counter, exactly as the other duels do.
 *
 * NOTE ON THE GAME KEY: the writers are called with the literal
 * `gameKey: "sudoku-duel"`. Until that key is added to `RATED_GAMES`
 * (`src/lib/rating.js`), `applyRatingResult` returns
 * `{ applied: false, reason: "game-not-rated" }` — it REFUSES an unregistered
 * key rather than falling back to another game's ladder, so this seam is inert
 * (never mis-rating, e.g. as chess) until platform registration lands, and it
 * turns itself on with no change here.
 */
async function settleSudokuDuelMatch(
  tx: any,
  match: MatchRow,
  outcome: SudokuRaceOutcome,
) {
  // A practice match (none today) must never affect rating, trophies or counters.
  if (match.isAi) return;
  if (!match.player2Id) return;

  const matchId = String(match.id);

  if (outcome.result === RESULT.DRAW) {
    await applyRatingResult({
      tx,
      gameKey: "sudoku-duel",
      matchId,
      winnerClerkId: match.player1Id,
      loserClerkId: match.player2Id,
      result: "draw",
    }).catch(() => {});
    await applyTrophyResult({
      tx,
      gameKey: "sudoku-duel",
      matchId,
      winnerClerkId: match.player1Id,
      loserClerkId: match.player2Id,
      result: "draw",
    }).catch(() => {});
    return;
  }

  const winnerId =
    outcome.result === RESULT.PLAYER1 ? match.player1Id : match.player2Id;
  const loserId =
    outcome.result === RESULT.PLAYER1 ? match.player2Id : match.player1Id;
  if (!winnerId || !loserId || winnerId === loserId) return;

  await tx
    .update(users)
    .set({ gamesWon: sql`${users.gamesWon} + 1` })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({ gamesLost: sql`${users.gamesLost} + 1` })
    .where(eq(users.clerkId, loserId));

  await applyRatingResult({
    tx,
    gameKey: "sudoku-duel",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
  await applyTrophyResult({
    tx,
    gameKey: "sudoku-duel",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}

// Re-exported so the routes can assert shape without importing the rules module
// directly, and so the derivability invariant stays discoverable.
export {
  isWellFormedSeatState,
  progressOf,
  seatForUser,
  viewForState,
} from "./rules";
export type {
  Seat,
  SeatProgress,
  Seats,
  SudokuSeatState,
  SudokuView,
} from "./types";
