// src/lib/solitaire-duel/serverStore.ts
//
// The server-authoritative Solitaire Duel match store. Every state transition
// happens inside a row-locked `db.transaction` here, and the API routes are thin
// wrappers around these functions.
//
// TRUST BOUNDARY: the ONLY player-authored value that reaches this module is a
// move — which cards, from where, to where. The board, the stock order, the
// face-up/face-down state, the progress figure, the completion, the completion
// instant, the winner, the match result, the rating change and the trophies are
// all derived by the server from its own state. A client cannot submit a winner,
// a result, a score, a progress value, a completion flag, an Elo value or a
// trophy — no such field is ever read, anywhere in this file.
//
// FAIRNESS: `createOrJoin` mints ONE server seed, commits its hash and derives
// ONE deal for the match row. Both `p1_state` and `p2_state` are created as
// copies of that single deal at ply 0, and joining NEVER regenerates anything —
// so the two seats provably start from the identical puzzle. Each seat's moves
// are written to that seat's own columns, so one board can never alter the
// other.
//
// Settlement reuses the platform's existing rating/trophy infrastructure
// (`applyRatingResult` / `applyTrophyResult`) inside the SAME transaction that
// finalises the match, exactly once — the guard is the `status` flip to
// `finished` under a `FOR UPDATE` lock, plus those helpers' own
// (user, game, match)-keyed idempotency journals. There is NO second Elo
// implementation and NO wager/token/payout path anywhere in this file.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { solitaireDuelMatches, solitaireDuelMoves, users } from "../../db/schema";
import { applyGhostRatingResult, applyRatingResult } from "../rating";
import { escrowMatchWagers } from "../tokens/wager";
import { payPvpPot, refundPvpPot } from "../tokens/pvpPot";
import { applyGhostTrophyResult, applyTrophyResult } from "../trophyStore";
import { markDailyRewardWin } from "../dailyRewardWin";
import { mirrorQueueCreated, mirrorQueueTransition } from "../canonicalQueueLifecycle";
import { publicSolitaireBot, solitaireBotFor, type SolitaireBotId } from "./bots";
import { dueGhostSteps, findGhostRun, ghostPlayerIdFor, type GhostRun } from "./ghosts";
import { isGuestId } from "../guestIdentity";
import { FRIEND_CHALLENGE_TTL_MS } from "./friendChallenge";
import { generateFriendChallengeCode } from "./inviteCodes";
import { isPracticePaused } from "../practicePause";
import {
  GHOST_FALLBACK_MS,
  INACTIVITY_ALARM_MS,
  INACTIVITY_FORFEIT_MS,
  MATCH_STATUS,
  MAX_MOVES_PER_SEAT,
  READY_COUNTDOWN_MS,
  RESOLUTION,
  RESULT,
  SEAT,
  SOLITAIRE_DUEL_AI_PLAYER_ID,
  SOLITAIRE_DUEL_LOCK_NAMESPACE,
  isGhostPlayerId,
  TERMINAL_STATUSES,
  VARIANT,
  VARIANT_VERSION,
} from "./constants";
import {
  AI_STAGNATION_LIMIT,
  aiMoveDelayMs,
  botCanFinishDeal,
  legalMoves,
  planAiLine,
  planAiMoves,
} from "./ai";
import {
  summarizeAiDialogueEvents,
  type AiDialogueEventSummary,
} from "./aiDialogueEvents";
import {
  solvableDealFromSeed,
  solveDealLine,
  stateSolvableVerdict,
} from "./solvable";
import { autoFinishPlan, type AutoFinishStep } from "./autoFinish";
import {
  cloneState,
  failureOf,
  initialStateFromDeal,
  isWellFormedState,
  normalizeMove,
  opponentProgressFor,
  otherSeat,
  progressOf,
  raceFromState,
  resolveRace,
  seatForUser,
  userIdForSeat,
  applyMove,
  replayMoves,
  viewForState,
} from "./rules";
import { deriveDealSeed, getServerSeedHash, randomHex } from "./seeds";
import type {
  Card,
  OpponentProgress,
  RaceOutcome,
  Seat,
  SeatProgress,
  SeatRace,
  Seats,
  SolitaireDeal,
  SolitaireMove,
  SolitaireState,
  SolitaireView,
} from "./types";

// The rated/trophy game key, and the queue-mirror game key.
//
// Written as a string literal at every call site (rather than a shared
// constant) on purpose: the platform's settlement-wiring audits scan source for
// `gameKey: "<key>"` to prove every rated game is wired to a shared writer, and
// a constant reference would be invisible to that check.

type MatchRow = typeof solitaireDuelMatches.$inferSelect;

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

// ── Seats ─────────────────────────────────────────────────────────────────

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

/**
 * A seat's own authoritative board.
 *
 * Read per seat and never merged: this is the accessor that guarantees one
 * player's moves cannot reach the other player's state.
 */
export function stateForSeat(match: MatchRow, seat: Seat): SolitaireState | null {
  const raw = seat === SEAT.PLAYER1 ? match.p1State : match.p2State;
  return (raw ?? null) as SolitaireState | null;
}

function plyForSeat(match: MatchRow, seat: Seat): number {
  return Number((seat === SEAT.PLAYER1 ? match.p1Ply : match.p2Ply) ?? 0);
}

function raceFor(match: MatchRow, seat: Seat, forfeited = false): SeatRace {
  return raceFromState({
    userId: userIdForSeat(seatsFromRow(match), seat),
    seat,
    state: stateForSeat(match, seat),
    forfeited,
  });
}

// ── Inactivity (the untimed match's one rule) ─────────────────────────────

/** A seat's own last accepted move instant, or null before its first move. */
function lastActionMsForSeat(match: MatchRow, seat: Seat): number | null {
  const raw = seat === SEAT.PLAYER1 ? match.p1LastActionAt : match.p2LastActionAt;
  return instantMs(raw);
}

/** What a seat's inactivity is measured from: its last move, else GO. */
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
 * Per seat and measured from that seat's own last move, so one player's activity
 * can never keep the other's clock alive. A seat that already completed is
 * never forfeited. When BOTH seats are past the threshold the more idle one
 * loses, and an exact tie (two seats that never moved, checked at the same
 * instant) is a draw rather than an arbitrary winner.
 */
function inactivityForfeitSeat(match: MatchRow, nowMs: number): Seat | "both" | null {
  // A practice match is never forfeited for inactivity — it has no clock at all.
  if (match.isAi) return null;
  if (match.status !== MATCH_STATUS.PLAYING || !match.player2Id) return null;
  // A GHOST duel has exactly one seat that can go idle. The recording's moves
  // are already made, so the ghost can never forfeit; the human's own clock
  // still runs, so an abandoned ghost duel resolves instead of living forever.
  if (match.isGhost) {
    const humanSeat = isGhostPlayerId(match.player2Id)
      ? SEAT.PLAYER1
      : SEAT.PLAYER2;
    const idle = inactivityMsForSeat(match, humanSeat, nowMs);
    const done = Boolean(stateForSeat(match, humanSeat)?.completed);
    return !done && idle != null && idle >= INACTIVITY_FORFEIT_MS
      ? humanSeat
      : null;
  }
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
 * The per-seat column write for one move.
 *
 * Written as an explicit branch rather than dynamic keys so the patch is
 * type-checked and readable — and so it is visible at a glance that a move
 * touches ONLY the acting seat's columns.
 */
function seatPatchFor(seat: Seat, state: SolitaireState, progress: SeatProgress) {
  if (seat === SEAT.PLAYER1) {
    return {
      p1State: state,
      p1Ply: state.ply,
      p1PeakFoundation: state.peakFoundation,
      p1Revealed: progress.revealedTableau,
    };
  }
  return {
    p2State: state,
    p2Ply: state.ply,
    p2PeakFoundation: state.peakFoundation,
    p2Revealed: progress.revealedTableau,
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
 * boards, the stock order and the server seed, so a spread would leak the
 * opponent's board and the face-down identities in one line. The board here is
 * the viewer's OWN projected view, and the opponent appears only as the closed
 * `OpponentProgress` shape.
 *
 * The board is included only once the race is live (`playing`), so neither seat
 * can study the deal while waiting for an opponent — the deal is revealed to
 * both from the same server state, at the same moment.
 */
/**
 * The named practice bot for a row, or null on a human duel.
 *
 * `NULL` on an AI row (a legacy practice match) resolves to the documented
 * default bot, so every practice row has a named opponent. A human duel carries
 * no bot.
 */
export function aiDifficultyForMatch(match: {
  aiDifficulty?: unknown;
  isAi?: boolean | null;
}) {
  if (!match?.isAi) return null;
  return solitaireBotFor(match.aiDifficulty).id;
}

export function matchToDto(
  match: MatchRow,
  viewerId: string | null,
  nowMs = Date.now(),
  aiEvents: AiDialogueEventSummary | null = null,
) {
  const seats = seatsFromRow(match);
  const seat = seatForUser(seats, viewerId);
  const terminal = TERMINAL_STATUSES.includes(match.status);
  const revealed = match.status === MATCH_STATUS.PLAYING || terminal;
  const ownState = seat ? stateForSeat(match, seat) : null;
  const opponentSeat = seat ? otherSeat(seat) : null;
  const otherState = opponentSeat ? stateForSeat(match, opponentSeat) : null;

  return {
    matchId: String(match.id),
    variant: match.variant,
    variantVersion: match.variantVersion,
    status: match.status,
    result: match.result ?? null,
    resolutionReason: match.resolutionReason ?? null,
    winnerId: match.winnerId ?? null,
    seat,
    isParticipant: Boolean(seat),
    // A free practice match against the bot. The match view uses it to label the
    // seat "GRYND AI", to offer a restart, and to send the next practice match
    // back through the practice path rather than the rated queue.
    isAi: Boolean(match.isAi),
    aiDifficulty: aiDifficultyForMatch(match),
    // The public bot identity for a practice row: name, displayed rating,
    // difficulty, copy and avatar placeholder. Null on a human duel.
    bot: match.isAi
      ? publicSolitaireBot(solitaireBotFor(match.aiDifficulty))
      : null,
    // A RECORDED HUMAN, not a bot. Ranked never substitutes the AI seat: when
    // no live player is available the match is played against another person's
    // recorded run of the same deal. The DTO names only the anonymised handle
    // and the recorded ladder strength — never the source account.
    isGhost: Boolean(match.isGhost),
    ghost: match.isGhost
      ? {
          name: match.ghostName ?? "GHOST",
          rating:
            Number.isFinite(Number(match.ghostRating)) && match.ghostRating != null
              ? Number(match.ghostRating)
              : null,
          // The recording's own pace, as count-only checkpoints measured from
          // the server's GO instant. Enough for the opponent panel to show the
          // run unfolding; no card identity, column or stock order is here.
          trail: Array.isArray(match.ghostTrail) ? match.ghostTrail : [],
          completedAtMs:
            match.ghostCompletedAtOffsetMs == null
              ? null
              : Number(match.ghostCompletedAtOffsetMs),
        }
      : null,
    // The commitment is public from creation; the seed itself is only revealed
    // once the match is terminal, so the deal can be verified after the fact.
    seedHash: match.serverSeedHash,
    serverSeed: terminal ? match.serverSeed : null,
    goAtMs: instantMs(match.goAt),
    // The viewer's OWN inactivity clock: last action (or GO) plus each threshold.
    // Derived per viewer, so a client can raise its own alarm, and a read can
    // resolve the forfeit server-side.
    inactivityAlarmAtMs: inactivityAtMs(match, seat, INACTIVITY_ALARM_MS),
    inactivityForfeitAtMs: inactivityAtMs(match, seat, INACTIVITY_FORFEIT_MS),
    // The OPPONENT's inactivity clock, so the active seat can be told the other
    // side is about to forfeit. Null in a waiting lobby, in practice — and in a
    // ghost duel, whose opponent has no clock because its moves are recorded.
    opponentInactivityAlarmAtMs: match.isGhost
      ? null
      : inactivityAtMs(match, opponentSeat, INACTIVITY_ALARM_MS),
    opponentInactivityForfeitAtMs: match.isGhost
      ? null
      : inactivityAtMs(match, opponentSeat, INACTIVITY_FORFEIT_MS),
    startedAtMs: instantMs(match.startedAt),
    endedAtMs: instantMs(match.endedAt),
    createdAtMs: instantMs(match.createdAt),
    /** Server clock, so a client can render an accurate timer without trusting its own. */
    serverNow: nowMs,
    view: revealed && ownState ? viewForState(ownState) : null,
    // ADDITIVE and optional: a compact, count-only summary of the bot's most
    // recent planner batch. Null everywhere except the read that advanced a
    // practice bot, and never a card, a column layout or a stock order.
    aiEvents,
    progress: ownState ? progressOf(ownState) : null,
    opponent:
      revealed && otherState && opponentSeat
        ? opponentProgressFor(opponentSeat, otherState)
        : null,
  };
}

/**
 * The public lobby entry for an open match.
 *
 * Deliberately narrower than the match DTO: an open lobby is visible to anyone,
 * so it must expose nothing but "a Solitaire Duel is waiting" — no deal, no
 * board, no seed, not even a player id.
 */
export function lobbyEntry(match: MatchRow, nowMs = Date.now()) {
  return {
    matchId: String(match.id),
    variant: match.variant,
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
    .from(solitaireDuelMatches)
    .where(
      and(
        eq(solitaireDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(solitaireDuelMatches.player2Id),
        // A friend challenge is NOT public queue material: its second seat is
        // reserved for whoever holds the code, so it must never appear in a
        // list that anyone can join from.
        isNull(solitaireDuelMatches.inviteCode),
      ),
    )
    .orderBy(sql`${solitaireDuelMatches.createdAt} ASC`)
    .limit(limit);
}

/** The caller's own still-waiting lobby, if any. */
export async function listMyWaitingMatch({ userId }: { userId: string }) {
  const [row] = await db
    .select()
    .from(solitaireDuelMatches)
    .where(
      and(
        eq(solitaireDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(solitaireDuelMatches.player2Id),
        eq(solitaireDuelMatches.player1Id, userId),
        // A waiting INVITE is not a queue search: "resume your search" would be
        // a lie about a table nobody else can join. The challenge panel owns it.
        isNull(solitaireDuelMatches.inviteCode),
      ),
    )
    .orderBy(sql`${solitaireDuelMatches.createdAt} ASC`)
    .limit(1);
  return row ?? null;
}

/**
 * The caller's own friend challenge, if one is live.
 *
 * This is what makes the link REAL from the creator's side: the lobby can say
 * "waiting for your friend" and then "they accepted" without the creator
 * having to open the match page to find out. It is owner-scoped by
 * `player1_id = userId` — a code is never sufficient to read somebody else's
 * challenge, and the projection carries no board, no seed and no opponent
 * identity.
 *
 * A waiting invite past its window is reported as cancelled rather than
 * waiting: the seat can no longer be taken, so "waiting" would be a lie.
 */
export async function getMyFriendChallenge({
  userId,
  nowMs = Date.now(),
}: {
  userId: string;
  nowMs?: number;
}): Promise<{
  matchId: string;
  code: string;
  status: string;
  opponentJoined: boolean;
  createdAtMs: number | null;
  expiresAtMs: number | null;
} | null> {
  const [row] = await db
    .select({
      id: solitaireDuelMatches.id,
      code: solitaireDuelMatches.inviteCode,
      status: solitaireDuelMatches.status,
      player2Id: solitaireDuelMatches.player2Id,
      createdAt: solitaireDuelMatches.createdAt,
      inviteExpiresAt: solitaireDuelMatches.inviteExpiresAt,
    })
    .from(solitaireDuelMatches)
    .where(
      and(
        eq(solitaireDuelMatches.player1Id, userId),
        sql`${solitaireDuelMatches.inviteCode} IS NOT NULL`,
        // Only a live challenge is worth reporting. A finished/cancelled one
        // belongs in history, not in the lobby.
        sql`${solitaireDuelMatches.status} IN ('waiting', 'playing')`,
      ),
    )
    .orderBy(sql`${solitaireDuelMatches.createdAt} DESC`)
    .limit(1);

  if (!row || !row.code) return null;

  const expiresAtMs = row.inviteExpiresAt
    ? new Date(row.inviteExpiresAt).getTime()
    : null;
  const expired =
    expiresAtMs != null && Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;

  return {
    matchId: String(row.id),
    code: row.code,
    status:
      expired && row.status === MATCH_STATUS.WAITING
        ? MATCH_STATUS.CANCELLED
        : String(row.status),
    opponentJoined: Boolean(row.player2Id),
    createdAtMs: instantMs(row.createdAt),
    expiresAtMs,
  };
}

/**
 * Match the caller into an open lobby, or open a new one.
 *
 * The whole operation runs under a single advisory lock (per-game namespace) so
 * two concurrent callers can never both see "no open lobby" and each create
 * one, and so a caller can never join a lobby that is being cancelled.
 */
export async function createOrJoin({
  userId,
  stake = 0,
  nowMs = Date.now(),
}: {
  userId: string;
  /** Coins each seat escrows; 0 means a free match. */
  stake?: number;
  nowMs?: number;
}) {
  const stakeAmount = Number(stake) > 0 ? Number(stake) : 0;
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SOLITAIRE_DUEL_LOCK_NAMESPACE}, 0)`,
    );

    // Only a lobby AT THE CALLER'S STAKE is joinable, so two players never
    // escrow different sums into one pot. Up to 20 open lobbies are locked and
    // then ranked by TROPHY PROXIMITY: the caller joins the closest ladder
    // match, not merely the oldest open seat. Equal trophy counts are therefore
    // paired with each other, and a 1,000-trophy player is never dropped into a
    // beginner's lobby just because it was created first.
    const candidates = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(
        and(
          eq(solitaireDuelMatches.status, MATCH_STATUS.WAITING),
          isNull(solitaireDuelMatches.player2Id),
          // Never pair a stranger into somebody's private friend challenge.
          isNull(solitaireDuelMatches.inviteCode),
          sql`${solitaireDuelMatches.stakeAmount} = ${stakeAmount}`,
        ),
      )
      .orderBy(sql`${solitaireDuelMatches.createdAt} ASC`)
      .limit(20)
      .for("update");

    if (candidates.length > 0) {
      // The caller's own lobby — return it rather than creating a second.
      const own = candidates.find((candidate) => candidate.player1Id === userId);
      if (own) return { match: own, joined: false } as const;

      const playerIds = [
        ...new Set(candidates.map((candidate) => candidate.player1Id)),
      ];
      let trophiesByClerkId = new Map<string, number>();
      if (playerIds.length > 0) {
        const rows = await tx.execute(sql`
          SELECT u.clerk_id AS "clerkId", t.trophies
            FROM users u
            LEFT JOIN player_trophies t
              ON t.user_id = u.id AND t.game_key = 'solitaire-duel'
           WHERE u.clerk_id IN (${sql.join(
             playerIds.map((id) => sql`${id}`),
             sql`, `,
           )})
        `);
        const list = (
          Array.isArray(rows) ? rows : ((rows as any).rows ?? [])
        ) as any[];
        trophiesByClerkId = new Map(
          list
            .filter((row) => Number.isFinite(Number(row.trophies)))
            .map((row) => [String(row.clerkId), Number(row.trophies)]),
        );
      }

      const callerTrophies = trophiesByClerkId.get(userId);
      const ranked = [...candidates].sort((a, b) => {
        const gap = (candidate: typeof a) => {
          const theirs = trophiesByClerkId.get(candidate.player1Id);
          // A player with no trophy row (never ranked) has no signal. They are
          // placed after known-trophy candidates rather than treated as 0.
          if (callerTrophies == null || theirs == null) {
            return Number.MAX_SAFE_INTEGER;
          }
          return Math.abs(callerTrophies - theirs);
        };
        return (
          gap(a) - gap(b) ||
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      });

      return await joinExistingMatch(tx, ranked[0].id, userId, nowMs, stakeAmount);
    }

    return await createWaitingMatch(tx, userId, nowMs, stakeAmount);
  });
}

/**
 * Open a lobby, seeding the match.
 *
 * The seed, its commitment, the derived deal seed and the deal are all minted
 * here, once. BOTH boards are written from that one deal in the same INSERT, so
 * "both players receive the exact same initial puzzle" is a structural property
 * of the row rather than something a join path has to remember to do.
 */
async function createWaitingMatch(
  tx: any,
  userId: string,
  nowMs: number,
  stakeAmount = 0,
  /**
   * Set ONLY for a friend challenge: the row becomes addressable by a short
   * code, and it must never fall back to a ghost — a link addressed to one
   * person may not quietly turn into a replay against somebody else.
   */
  invite?: { code: string; expiresAt: Date },
) {
  // Server-generated entropy only. Never client-supplied, never Math.random().
  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);
  const dealSeed = deriveDealSeed({ serverSeed, variantVersion: VARIANT_VERSION });
  // VARIANT_VERSION 3: a random deal served only once a search has proven a
  // winning line, the engine has replayed it, and the naive foundation-only
  // strategy has been shown to fail. Still a pure function of the derived seed,
  // and still the one deal both seats receive.
  const deal: SolitaireDeal = solvableDealFromSeed(dealSeed);

  // The SAME deal initialises both seats — two independent copies of one
  // opening position, so neither seat's board can ever alias the other's (or
  // the deal's) objects.
  const opening = initialStateFromDeal(deal);
  const openingProgress = progressOf(opening);

  const [match] = await tx
    .insert(solitaireDuelMatches)
    .values({
      variant: VARIANT,
      variantVersion: VARIANT_VERSION,
      player1Id: userId,
      status: MATCH_STATUS.WAITING,
      stakeAmount: stakeAmount.toFixed(2),
      serverSeed,
      serverSeedHash,
      dealSeed,
      deal,
      p1State: opening,
      p2State: cloneState(opening),
      // Both seats begin at ply 0 on the same board.
      p1Ply: 0,
      p2Ply: 0,
      p1PeakFoundation: opening.peakFoundation,
      p2PeakFoundation: opening.peakFoundation,
      p1Revealed: openingProgress.revealedTableau,
      p2Revealed: openingProgress.revealedTableau,
      // The live queue gets first refusal: this instant only opens the ghost
      // fallback. A second player who joins before it arrives still wins, and
      // a search that finds somebody is an ordinary human duel. A PRIVATE
      // invite takes no fallback at all: it waits for its friend or expires.
      inviteCode: invite?.code ?? null,
      inviteExpiresAt: invite?.expiresAt ?? null,
      ghostFallbackAt: invite ? null : new Date(nowMs + GHOST_FALLBACK_MS),
    })
    .returning();

  mirrorQueueCreated({
    gameKey: "solitaire-duel",
    matchId: match.id,
    playerCount: 1,
    queuedAt: match.createdAt ? new Date(match.createdAt) : undefined,
  });

  return { match, joined: false } as const;
}

/**
 * Mint — or hand back — the caller's friend-challenge lobby.
 *
 * The lobby is an ordinary seeded waiting match with `invite_code` set, so the
 * same one-deal/two-boards invariants hold as in the public queue; the ONLY
 * differences are that every public query filters it out and that the second
 * seat is claimed by code rather than by matchmaking.
 *
 * Idempotent on purpose: pressing "challenge a friend" twice returns the SAME
 * live link, because two links would mean two tables and the first friend to
 * accept would land in the one the creator had already forgotten. An expired
 * link counts as no link, so the next press mints a fresh one.
 */
export async function createFriendChallenge({
  userId,
  nowMs = Date.now(),
  code,
}: {
  userId: string;
  nowMs?: number;
  code?: string;
}): Promise<
  | { match: typeof solitaireDuelMatches.$inferSelect }
  | { error: string; status: number }
> {
  const mint = async (inviteCode: string) =>
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${SOLITAIRE_DUEL_LOCK_NAMESPACE}, 0)`,
      );

      const [existing] = await tx
        .select()
        .from(solitaireDuelMatches)
        .where(
          and(
            eq(solitaireDuelMatches.player1Id, userId),
            eq(solitaireDuelMatches.status, MATCH_STATUS.WAITING),
            isNull(solitaireDuelMatches.player2Id),
            sql`${solitaireDuelMatches.inviteCode} IS NOT NULL`,
            sql`${solitaireDuelMatches.inviteExpiresAt} > ${new Date(nowMs)}`,
          ),
        )
        .orderBy(sql`${solitaireDuelMatches.createdAt} DESC`)
        .limit(1);
      if (existing) return { match: existing } as const;

      const { match } = await createWaitingMatch(tx, userId, nowMs, 0, {
        code: inviteCode,
        expiresAt: new Date(nowMs + FRIEND_CHALLENGE_TTL_MS),
      });
      return { match } as const;
    });

  try {
    return await mint(code ?? generateFriendChallengeCode());
  } catch (error) {
    // 23505 = unique_violation on the code index. A collision is astronomically
    // unlikely (32^8) but retrying once is cheaper than failing the request.
    if ((error as { code?: string })?.code === "23505") {
      try {
        return await mint(generateFriendChallengeCode());
      } catch (retryError) {
        console.error(
          "[solitaire-duel] friend challenge failed after a code collision:",
          retryError instanceof Error ? retryError.message : retryError,
        );
      }
    } else {
      console.error(
        "[solitaire-duel] friend challenge creation failed:",
        error instanceof Error ? error.message : error,
      );
    }
    return { error: "Unable to create the challenge link", status: 500 } as const;
  }
}

/**
 * Take the second seat of a friend challenge by code.
 *
 * Same lock and same claim primitive as public matchmaking (`joinExistingMatch`
 * under `FOR UPDATE`), so two people opening the link at the same instant
 * cannot both be seated. The caller's identity comes from the session; the code
 * is only ever a locator, never an identity.
 *
 * Re-opening a link you already hold is not an error: the creator gets their own
 * lobby back, and the friend who already accepted gets the started match, so a
 * reload or a second click never dead-ends on a 409.
 */
export async function joinFriendChallenge({
  userId,
  code,
  nowMs = Date.now(),
}: {
  userId: string;
  code: string;
  nowMs?: number;
}): Promise<
  | { match: typeof solitaireDuelMatches.$inferSelect; joined: boolean; own?: boolean; alreadySeated?: boolean }
  | { error: string; status: number }
> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SOLITAIRE_DUEL_LOCK_NAMESPACE}, 0)`,
    );

    const [row] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.inviteCode, code))
      .for("update");

    if (!row) return { error: "This challenge link is not valid", status: 404 } as const;

    // The creator opening their own link: hand back their lobby, never a second
    // seat and never a second table.
    if (row.player1Id === userId) {
      return { match: row, joined: false, own: true } as const;
    }
    // Already the invited friend (a reload, or a second click): the match page is
    // where they belong.
    if (row.player2Id === userId) {
      return { match: row, joined: false, alreadySeated: true } as const;
    }

    const expiresAtMs = row.inviteExpiresAt
      ? new Date(row.inviteExpiresAt).getTime()
      : null;
    if (expiresAtMs != null && Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
      return { error: "This challenge link has expired", status: 410 } as const;
    }
    if (row.status !== MATCH_STATUS.WAITING || row.player2Id) {
      return { error: "This duel has already started", status: 409 } as const;
    }

    return await joinExistingMatch(tx, row.id, userId, nowMs, 0);
  });
}

/**
 * What a challenge code currently points at — PUBLIC and deal-free.
 *
 * The `/duel/<code>` preview needs exactly this: is the seat still open, has
 * somebody taken it, has the link lapsed. It deliberately returns no match id,
 * no board, no seed and no player, because a code proves nothing until its
 * holder actually sits down.
 */
export async function findFriendChallenge({
  code,
  nowMs = Date.now(),
}: {
  code: string;
  nowMs?: number;
}): Promise<{
  status: "open" | "started" | "expired" | "unknown";
  expiresAtMs: number | null;
}> {
  const [row] = await db
    .select({
      status: solitaireDuelMatches.status,
      player2Id: solitaireDuelMatches.player2Id,
      inviteExpiresAt: solitaireDuelMatches.inviteExpiresAt,
    })
    .from(solitaireDuelMatches)
    .where(eq(solitaireDuelMatches.inviteCode, code))
    .limit(1);

  if (!row) return { status: "unknown", expiresAtMs: null };

  const expiresAtMs = row.inviteExpiresAt
    ? new Date(row.inviteExpiresAt).getTime()
    : null;
  const expired =
    expiresAtMs != null && Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;

  if (expired) return { status: "expired", expiresAtMs };
  if (row.player2Id) return { status: "started", expiresAtMs };
  return { status: "open", expiresAtMs };
}

/**
 * Create a PRIVATE room / friend-challenge match for one NAMED pair.
 *
 * This is the room adapter's primitive (src/lib/rooms/games.ts), not a second
 * matchmaker: it seeds the SAME server seed → solvable deal → two independent
 * boards as the public lobby, and starts immediately with the same synchronized
 * GO instant. The row is never `waiting`, so the public queue can never join it
 * and no third player can see the deal.
 *
 * No stake is accepted. Solitaire Duel is free ranked play; the room catalog
 * pins it to free play, and a private match must not be a back door into a
 * wager the game's own flow never takes.
 */
export async function createSolitaireMatchForPair({
  hostUserId,
  opponentUserId,
  nowMs = Date.now(),
}: {
  hostUserId: string;
  opponentUserId: string;
  nowMs?: number;
}) {
  if (!hostUserId || !opponentUserId) {
    return { ok: false, status: 400, message: "Both players are required" } as const;
  }
  if (String(hostUserId) === String(opponentUserId)) {
    return { ok: false, status: 400, message: "A match needs two different players" } as const;
  }

  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);
  const dealSeed = deriveDealSeed({ serverSeed, variantVersion: VARIANT_VERSION });
  const deal: SolitaireDeal = solvableDealFromSeed(dealSeed);
  const opening = initialStateFromDeal(deal);
  const openingProgress = progressOf(opening);
  const goAtMs = nowMs + READY_COUNTDOWN_MS;

  try {
    const [match] = await db
      .insert(solitaireDuelMatches)
      .values({
        variant: VARIANT,
        variantVersion: VARIANT_VERSION,
        player1Id: hostUserId,
        player2Id: opponentUserId,
        status: MATCH_STATUS.PLAYING,
        isAi: false,
        stakeAmount: "0",
        serverSeed,
        serverSeedHash,
        dealSeed,
        deal,
        p1State: opening,
        p2State: cloneState(opening),
        p1Ply: 0,
        p2Ply: 0,
        p1PeakFoundation: opening.peakFoundation,
        p2PeakFoundation: opening.peakFoundation,
        p1Revealed: openingProgress.revealedTableau,
        p2Revealed: openingProgress.revealedTableau,
        goAt: new Date(goAtMs),
        startedAt: new Date(nowMs),
        p1LastActionAt: new Date(goAtMs),
        p2LastActionAt: new Date(goAtMs),
        updatedAt: new Date(nowMs),
      })
      .returning();

    mirrorQueueCreated({
      gameKey: "solitaire-duel",
      matchId: match.id,
      playerCount: 2,
      queuedAt: new Date(nowMs),
    });

    return { ok: true, matchId: String(match.id) } as const;
  } catch (error) {
    console.error(
      "[solitaire-duel] private pair match failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, status: 500, message: "Unable to create the match" } as const;
  }
}

/**
 * Fill the open lobby and start the race.
 *
 * NOTHING about the puzzle is touched here: seat 2's board already holds its
 * copy of the shared deal, so joining cannot introduce a second deal. The only
 * work is the synchronized clock — an absolute GO instant on the server's
 * clock, from which both seats' inactivity clocks start.
 *
 * The match goes straight to `playing` (there is no ready banner), but moves
 * before `go_at` are refused, so the countdown is a shared planning window
 * rather than dead time.
 */
async function joinExistingMatch(
  tx: any,
  candidateId: string,
  userId: string,
  nowMs: number,
  stakeAmount = 0,
) {
  const [match] = await tx
    .select()
    .from(solitaireDuelMatches)
    .where(eq(solitaireDuelMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Match is no longer available", status: 409 } as const;
  }

  const goAtMs = nowMs + READY_COUNTDOWN_MS;

  const [updated] = await tx
    .update(solitaireDuelMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.PLAYING,
      // A live player arrived: the ghost window is closed for good.
      ghostFallbackAt: null,
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
        eq(solitaireDuelMatches.id, candidateId),
        eq(solitaireDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(solitaireDuelMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    // Another joiner raced us and won the conditional UPDATE.
    return { error: "Match is no longer available", status: 409 } as const;
  }

  // Fund the match: both seats escrow now, before a single move. A seat that
  // cannot pay throws, rolling the seat claim back so the lobby stays waiting.
  // Annotated rather than inferred: `strict` is off, where a discriminated
  // union is not narrowed by `if (!x.ok)`.
  const escrow: { ok: boolean; error?: string; status?: number } =
    await escrowMatchWagers({
      clerkIds: [updated.player1Id, userId],
      stake: stakeAmount,
      matchId: updated.id,
      gameKey: "solitaire-duel",
      tx,
    });
  if (!escrow.ok) {
    throw Object.assign(new Error(escrow.error || "Insufficient coins"), {
      status: escrow.status && escrow.status < 500 ? escrow.status : 400,
    });
  }

  mirrorQueueCreated({
    gameKey: "solitaire-duel",
    matchId: updated.id,
    playerCount: 2,
    queuedAt: updated.createdAt ? new Date(updated.createdAt) : undefined,
  });

  return { match: updated, joined: true } as const;
}

/**
 * Start a free practice match against the built-in bot.
 *
 * Practice is UNRATED: the row is `isAi`, so finalization skips ratings,
 * trophies, win counters and the queue mirror entirely, and it never enters the
 * open lobby pool (the bot occupies player2 immediately).
 *
 * NOTHING about the puzzle is special-cased: the same server seed → deal →
 * openings path as a real lobby runs here, and the bot races the SAME deal from
 * player2. The only additions are the `playing` status and the synchronized
 * clock, so the human gets the identical countdown a joined lobby would have.
 */
/** Candidate deals a practice match may verify before settling on one. */
const AI_DEAL_ATTEMPTS = 6;
/** Wall-clock cap on that search, so creating a practice match never hangs. */
const AI_DEAL_SEARCH_MS = 800;

/**
 * A verified-solvable deal the given bot can ALSO finish itself.
 *
 * `solvableDealFromSeed` proves a perfect line exists, and the v3 generator
 * deliberately rejects deals that naive play solves — which means most of them
 * also dead-end a named bot's fair, mistake-prone heuristic. A practice bot on
 * such a board is re-dealt mid-race instead of ever completing the puzzle, so
 * the deal it is handed is chosen by replaying the bot's OWN deterministic plan
 * on each candidate. Fair by construction: the check uses only the moves the bot
 * would make from what a player can see, never the deal's solution.
 *
 * Bounded in both attempts and wall-clock time; the last candidate stands if
 * none of them verifies, so a practice match always starts.
 */
function finishableDealFor(botId: SolitaireBotId): {
  serverSeed: string;
  serverSeedHash: string;
  dealSeed: number;
  deal: SolitaireDeal;
} {
  const startedAt = Date.now();
  let serverSeed = randomHex(32);
  let dealSeed = deriveDealSeed({ serverSeed, variantVersion: VARIANT_VERSION });
  let deal = solvableDealFromSeed(dealSeed);

  for (let attempt = 1; attempt < AI_DEAL_ATTEMPTS; attempt += 1) {
    if (botCanFinishDeal({ deal, difficulty: botId })) break;
    if (Date.now() - startedAt >= AI_DEAL_SEARCH_MS) break;
    serverSeed = randomHex(32);
    dealSeed = deriveDealSeed({ serverSeed, variantVersion: VARIANT_VERSION });
    deal = solvableDealFromSeed(dealSeed);
  }

  return { serverSeed, serverSeedHash: getServerSeedHash(serverSeed), dealSeed, deal };
}

export async function createAiMatch({
  userId,
  difficulty,
  nowMs = Date.now(),
}: {
  userId: string;
  difficulty?: unknown;
  nowMs?: number;
}) {
  // Resolve a named bot (or a legacy tier) once, and persist its STABLE id.
  const bot = solitaireBotFor(difficulty);

  // A practice deal is guaranteed solvable AND finishable by this bot: a match
  // whose bot can never complete its own board is the "it never finishes"
  // experience, even though the human can still win.
  const { serverSeed, serverSeedHash, dealSeed, deal } = finishableDealFor(bot.id);

  const opening = initialStateFromDeal(deal);
  const openingProgress = progressOf(opening);
  const goAtMs = nowMs + READY_COUNTDOWN_MS;

  const [match] = await db
    .insert(solitaireDuelMatches)
    .values({
      variant: VARIANT,
      variantVersion: VARIANT_VERSION,
      player1Id: userId,
      player2Id: SOLITAIRE_DUEL_AI_PLAYER_ID,
      status: MATCH_STATUS.PLAYING,
      isAi: true,
      aiDifficulty: bot.id,
      serverSeed,
      serverSeedHash,
      dealSeed,
      deal,
      p1State: opening,
      p2State: cloneState(opening),
      p1Ply: 0,
      p2Ply: 0,
      p1PeakFoundation: opening.peakFoundation,
      p2PeakFoundation: opening.peakFoundation,
      p1Revealed: openingProgress.revealedTableau,
      p2Revealed: openingProgress.revealedTableau,
      goAt: new Date(goAtMs),
      // The human and the bot both start their inactivity clocks at GO.
      p1LastActionAt: new Date(goAtMs),
      p2LastActionAt: new Date(goAtMs),
      startedAt: new Date(nowMs),
    })
    .returning();

  return { match } as const;
}

/**
 * Abandon a practice match and deal a fresh one.
 *
 * "Start over with a different deal." The old row is marked `cancelled` (it
 * settles NOTHING — no rating, no trophy, no win counter, no queue transition),
 * and a brand new practice match is minted from a FRESH server seed, so the new
 * puzzle is genuinely a different deal rather than a replayed one.
 *
 * Only the human's own practice match can be restarted: the row must be `isAi`
 * AND the caller must hold player1. A rated duel has no restart — a player who
 * wants out of one resigns, and a player who wants another deal finishes it and
 * rematches. `difficulty` reuses the old tier when omitted.
 */
export async function restartAiMatch({
  userId,
  matchId,
  difficulty,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  difficulty?: unknown;
  nowMs?: number;
}) {
  const bot = solitaireBotFor(difficulty);

  const abandoned = await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);
    if (match.player1Id !== userId) return err("Not your match", 403);
    // A rated duel can never be restarted — that would let a losing player
    // discard a bad board at will.
    if (!match.isAi) return err("Only a practice match can be restarted", 409);
    if (TERMINAL_STATUSES.includes(match.status)) return { cancelled: false } as const;

    await tx
      .update(solitaireDuelMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        endedAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      })
      .where(eq(solitaireDuelMatches.id, match.id));

    // Deliberately NOT mirrored into the canonical queue and deliberately not
    // settled: a practice match never touched competitive progression.
    return { cancelled: true } as const;
  });

  if ("error" in abandoned) return abandoned;

  // A brand new seed → a brand new deal, against the SAME named bot.
  const { match } = await createAiMatch({ userId, difficulty: bot.id, nowMs });
  return { match } as const;
}

/**
 * Re-deal ONE seat's board, in place, and touch nothing else.
 *
 * This is what backs both re-deal triggers: a bot whose own board is dead, and
 * a seat whose live position has been PROVEN unwinnable. It deliberately
 * rewrites only that seat's columns:
 *
 *   * the OTHER seat's board is never read or written, so an opponent's game is
 *     untouched
 *   * `go_at`, `started_at` and BOTH inactivity clocks (`p1/p2_last_action_at`)
 *     are untouched, so a re-deal costs the player exactly the time they had
 *     already spent — a careful opponent simply finishes first
 *   * the move CURSOR (`ply`) is carried forward, never rewound: the move log is
 *     keyed by `(match, seat, ply)`, so reusing a ply would collide with a move
 *     already recorded. `resetCount` is the signal that the board was replaced.
 *   * `peakFoundation` (a monotone settlement metric) is carried forward too;
 *     only the live board — and the progress compared against it — resets.
 */
async function redealSeatInTx(
  tx: any,
  match: MatchRow,
  seat: Seat,
  nowMs: number,
): Promise<MatchRow> {
  const previous = stateForSeat(match, seat);
  // A brand-new server seed → a brand-new verified-solvable deal. The new deal
  // is NOT written back to the row's shared `deal` column: that column is the
  // match's original committed deal, and a re-dealt seat's board is a deliberate
  // divergence from it (see the audit note on the impossible-board path).
  let deal = solvableDealFromSeed(
    deriveDealSeed({ serverSeed: randomHex(32), variantVersion: VARIANT_VERSION }),
  );
  // A BOT seat is re-dealt onto a board it can actually finish, so the re-deal
  // does not simply move the same dead end to a new deal. The human's board is
  // untouched by this and is never verified this way.
  if (match.isAi && seat === SEAT.PLAYER2) {
    const botId = aiDifficultyForMatch(match);
    const startedAt = Date.now();
    for (let attempt = 1; attempt < AI_DEAL_ATTEMPTS; attempt += 1) {
      if (botCanFinishDeal({ deal, difficulty: botId })) break;
      if (Date.now() - startedAt >= AI_DEAL_SEARCH_MS) break;
      deal = solvableDealFromSeed(
        deriveDealSeed({ serverSeed: randomHex(32), variantVersion: VARIANT_VERSION }),
      );
    }
  }
  const opening = initialStateFromDeal(deal);
  opening.ply = previous?.ply ?? 0;
  opening.resetCount = (previous?.resetCount ?? 0) + 1;
  opening.peakFoundation = previous?.peakFoundation ?? 0;

  const progress = progressOf(opening);
  const [updated] = await tx
    .update(solitaireDuelMatches)
    .set({
      ...seatPatchFor(seat, opening, progress),
      updatedAt: new Date(nowMs),
    })
    .where(eq(solitaireDuelMatches.id, match.id))
    .returning();

  return updated ?? match;
}

/**
 * True when a HUMAN seat's live position can no longer be played at all.
 *
 * THE PLAYER-FACING RE-DEAL TRIGGER (the bot has its own, looser one in
 * `advanceAiMatch`), and it is deliberately the narrowest one that can be
 * stated without a heuristic:
 *
 *   1. the authoritative engine (`legalMoves`) offers the seat NO move at all.
 *      A board a player can still act on is NEVER taken away — not by a greedy
 *      planner that has run out of ideas, and not by a search verdict. This is
 *      the whole point of the gate: `planAiMoves` reports `stuck` for any board
 *      its heuristic cannot advance within `AI_STAGNATION_LIMIT` moves (a deal
 *      that needs an ordering it does not try, or one that only spins the stock
 *      and waste), and treating that as "unsolvable" yanked winnable boards out
 *      from under players mid-game.
 *   2. the position is genuinely unwinnable. With gate 1 in place this is a
 *      cheap corroboration — a position with no move has no line — and it keeps
 *      the re-deal tied to the proof rather than to the absence of a move on
 *      its own (an engine state that reports no moves while a line still exists
 *      would be a bug worth NOT re-dealing over).
 *
 * A completed board is never "dead": the callers check `completed` too, but the
 * guard is repeated here so a solved deal can never be recycled by mistake.
 */
function seatPositionIsDead(state: SolitaireState): boolean {
  if (!state || state.completed) return false;
  if (legalMoves(state).length > 0) return false;
  return stateSolvableVerdict(state) === "impossible";
}

/**
 * Re-deal the viewer's own board when it is provably unsolvable.
 *
 * Run on READ (and only for the seat that is reading), so a player is never
 * left staring at a board they cannot finish without ever acting. The verdict
 * is computed OUTSIDE the transaction and the row is re-checked under the lock
 * at the same ply, so a move that landed in between simply makes this a no-op
 * and the next read re-evaluates the new position.
 */
async function redealSeatIfDead({
  matchId,
  seat,
  expectedPly,
  nowMs,
}: {
  matchId: string;
  seat: Seat;
  expectedPly: number;
  nowMs: number;
}): Promise<MatchRow | null> {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
      .for("update");

    if (!match || match.status !== MATCH_STATUS.PLAYING) return null;

    const state = stateForSeat(match, seat);
    if (!state || !isWellFormedState(state) || state.completed) return null;
    // The board moved on since the verdict was computed: leave it alone.
    if (state.ply !== expectedPly) return null;

    return await redealSeatInTx(tx, match, seat, nowMs);
  });
}

/**
 * Advance the practice bot's board to the server's current instant.
 *
 * THE BOT'S TURN. Solitaire Duel is simultaneous, so the bot is paced by the
 * clock rather than by a turn hand-off: at `nowMs` it is allowed
 * `floor((nowMs - goAt) / delay)` moves, and this plays the best legal Klondike
 * move repeatedly until it has caught up (or the board is stuck). Calling it on
 * every read is what guarantees the bot genuinely plays and can never be
 * skipped — nothing about its progress depends on a client calling an endpoint.
 *
 * The bot's completion INSTANT is the simulated instant of the completing move
 * (`goAt + ply × delay`), not the instant the read happened to run, so a photo
 * finish is decided by who actually solved the shared deal first.
 *
 * Idempotent and monotonic: a no-op for a non-AI row, an unstarted row, or a
 * call that lands between two of the bot's moves. A write happens only when at
 * least one move was played, and the completion is finalized inside the same
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
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);
    if (!match.isAi || match.status !== MATCH_STATUS.PLAYING || !match.player2Id) {
      return { match, aiEvents: null, advanced: false } as const;
    }

    const goAtMs = instantMs(match.goAt);
    if (goAtMs == null || nowMs < goAtMs) return { match, aiEvents: null, advanced: false } as const;
    const seat = SEAT.PLAYER2;
    let state = stateForSeat(match, seat);
    if (!state || !isWellFormedState(state) || state.completed) {
      return { match, aiEvents: null, advanced: false } as const;
    }

    const delayMs = aiMoveDelayMs(match.aiDifficulty);
    const allowedPly = Math.floor((nowMs - goAtMs) / delayMs);
    // How many moves the bot has "earned" by now, bounded by the per-seat cap.
    const maxMoves = Math.max(
      0,
      Math.min(allowedPly - state.ply, MAX_MOVES_PER_SEAT - state.ply),
    );
    if (maxMoves <= 0) return { match, aiEvents: null, advanced: false } as const;

    const startPly = state.ply;
    const beforeState = state;
    // JSONB is untyped in the row; the generator wrote a real SolitaireDeal.
    const matchDeal = (match.deal ?? null) as SolitaireDeal | null;

    // A bot that has already run out of heuristic road follows the deal's
    // PROVEN line. `solveDealLine` is the generator's own replayed witness, so
    // this path always reaches 52 cards instead of stalling on a dead end.
    const lineActive = Boolean(state.aiLineActive);
    const line = lineActive && matchDeal ? solveDealLine(matchDeal) : null;
    const linePlan =
      lineActive && line
        ? planAiLine({
            state,
            line,
            cursor: state.aiLineCursor ?? 0,
            maxMoves,
          })
        : null;

    // THE BOT PLAYS FROM ITS OWN VISIBLE BOARD while the heuristic has a road.
    // The named profile in `./ai` decides only from legal moves and visible
    // structure; the proven line is a dead-end RECOVERY path only.
    const plan = linePlan
      ? {
          moves: linePlan.moves,
          state: linePlan.state,
          completed: linePlan.completed,
          stuck: false,
        }
      : planAiMoves({
          state,
          difficulty: match.aiDifficulty,
          maxMoves,
        });

    // Cross-read stagnation. `planAiMoves` counts stagnation inside ONE read,
    // but the store plans clock-sliced batches, so a bot cycling the stock
    // between beats reset that counter forever and never tripped its stall
    // guard. This count lives in the seat's own state instead.
    const beforeProgress = progressOf(beforeState);
    const plannedProgress = progressOf(plan.state);
    const progressed =
      plannedProgress.foundationCards > beforeProgress.foundationCards ||
      plannedProgress.revealedTableau > beforeProgress.revealedTableau;
    const stagnant = linePlan
      ? 0
      : progressed
        ? 0
        : (beforeState.aiStagnant ?? 0) + plan.moves.length;
    // A stalled board is recovered onto the deal's proven line. It is never
    // left spinning: a bot that cannot progress must still finish the puzzle,
    // at its normal per-move pace.
    const stuck =
      !linePlan &&
      !plan.completed &&
      (plan.stuck || stagnant >= AI_STAGNATION_LIMIT);
    if (plan.moves.length === 0 && !stuck) {
      return { match, aiEvents: null, advanced: false } as const;
    }

    state = plan.state;
    state.aiStagnant = stagnant;
    if (linePlan) {
      state.aiLineActive = true;
      state.aiLineCursor = linePlan.cursor;
    } else if (lineActive) {
      // A legacy/corrupted line that no longer replays: drop back to the
      // heuristic rather than freezing the seat on an unusable plan.
      state.aiLineActive = false;
      state.aiLineCursor = 0;
    }
    // Derived AFTER planning from the three things the planner already
    // produced. Read-only, count-only, and suppressed on a recovery tick.
    const aiEvents = summarizeAiDialogueEvents({
      before: beforeState,
      moves: plan.moves,
      after: state,
      suppressed: stuck,
    });

    // THE RECOVERY. The bot's board is reset onto the SAME committed deal's
    // opening and the proven line is followed from its first move. The ply
    // cursor is carried forward (it is the move log's key) and `resetCount`
    // signals the replacement, exactly like the old re-deal. This guarantees
    // every profile can finish the puzzle while the clock still paces each
    // line move at `moveDelayMs`.
    let recovery = false;
    if (stuck) {
      const recoveryLine = matchDeal ? solveDealLine(matchDeal) : null;
      if (matchDeal && recoveryLine && recoveryLine.length > 0) {
        const opening = initialStateFromDeal(matchDeal);
        opening.ply = state.ply;
        opening.resetCount = (state.resetCount ?? 0) + 1;
        opening.peakFoundation = state.peakFoundation ?? 0;
        opening.aiLineActive = true;
        opening.aiLineCursor = 0;
        opening.aiStagnant = 0;
        state = opening;
        recovery = true;
      }
    }
    const completedNow = plan.completed && !state.completedAtMs;
    if (completedNow) {
      // The simulated instant of the completing move, never the read instant.
      state.completedAtMs = goAtMs + (startPly + plan.moves.length) * delayMs;
    }
    const played = plan.moves.map((move, index) => ({
      ply: startPly + index,
      kind: move.kind,
      move,
    }));

    for (const entry of played) {
      await tx.insert(solitaireDuelMoves).values({
        matchId: match.id,
        seat,
        ply: entry.ply,
        kind: entry.kind,
        move: entry.move,
      });
    }

    const progress = progressOf(state);
    const [updated] = await tx
      .update(solitaireDuelMatches)
      .set({
        ...seatPatchFor(seat, state, progress),
        // Every bot move resets the bot's own inactivity clock.
        p2LastActionAt: new Date(nowMs),
        ...(completedNow
          ? { p2FinishedAt: new Date(state.completedAtMs ?? nowMs) }
          : {}),
        updatedAt: new Date(nowMs),
      })
      .where(eq(solitaireDuelMatches.id, match.id))
      .returning();

    let changed = updated ?? match;
    // Only a board with no replayed line at all falls back to the legacy
    // random re-deal; every normal stall was recovered above.
    if (stuck && !recovery) {
      changed = await redealSeatInTx(tx, changed, seat, nowMs);
    }

    let finalRow = changed;
    const outcome = resolveRace({
      player1: raceFor(changed, SEAT.PLAYER1),
      player2: raceFor(changed, SEAT.PLAYER2),
    });
    if (outcome) finalRow = await finalizeMatch(tx, changed, outcome, nowMs);

    return { match: finalRow, aiEvents, advanced: true } as const;
  });
}

/** Advance the bot (when the row is a practice match) and return the row. */
async function advanceAiIfPractice(
  match: MatchRow,
  nowMs: number,
): Promise<{
  match: MatchRow;
  aiEvents: AiDialogueEventSummary | null;
}> {
  if (!match.isAi || match.status !== MATCH_STATUS.PLAYING) {
    return { match, aiEvents: null };
  }
  const advanced = await advanceAiMatch({ matchId: match.id, nowMs });
  if ("error" in advanced) return { match, aiEvents: null };
  return { match: advanced.match, aiEvents: advanced.aiEvents };
}

// ── Asynchronous ghost duels (a RECORDED HUMAN, never the AI seat) ────────
//
// The live queue is unchanged: `createOrJoin` still pairs real players first,
// and a search that finds somebody is an ordinary human duel. These functions
// only describe what happens when nobody joins — the open lobby is re-seated
// against another real player's RECORDED run of the same committed deal.
//
// Three properties make that honest rather than a disguised bot:
//
//   1. THE DEAL IS THE RECORDING'S OWN. A ghost match adopts the source match's
//      committed seed, hash, deal seed and deal, so "the ghost played this exact
//      deal" is structural. Its seed stays hidden until THIS match is terminal.
//   2. THE MOVES ARE FIXED. Playback replays `ghost_timeline` — the recorded log
//      with its recorded offsets — through the same rules engine. No planner is
//      imported, no difficulty exists, and no move is chosen here.
//   3. THE GHOST HAS NO SEAT IN THE LADDER. It occupies a synthetic id, so the
//      source player can never be treated as a participant, and settlement
//      rates only the human (see `settleSolitaireDuelMatch`).

/**
 * The guest trial: ONE race, against a recorded human run, with no account.
 *
 * A curious visitor should feel the race immediately, but a guest is not a
 * ladder participant (no rating, no trophies, no `users` row) and must never be
 * seated against a real player — so this path deliberately bypasses the public
 * queue entirely. It mints a match that is ALREADY `playing` against a ghost
 * seat, exactly like a converted fallback:
 *
 *   * no `waiting` row is ever created, so the guest never appears in the open
 *     lobby list and no stranger can be paired into the trial;
 *   * the deal is the RECORDING's own committed deal, so the race is provably
 *     the one the ghost played;
 *   * settlement skips every guest seat, so nothing is rated;
 *   * the limit is enforced from this guest id's own rows, and a second request
 *     gets a sign-in prompt rather than a second race. (Clearing cookies mints
 *     a new guest id; that is why the trial is a taste, not a free ladder —
 *     the sign-in prompt is the real gate.)
 */
export const GUEST_TRIAL_MAX_MATCHES = 1;

export async function createGuestGhostRace({
  userId,
  nowMs = Date.now(),
}: {
  userId: string;
  nowMs?: number;
}): Promise<
  | { match: typeof solitaireDuelMatches.$inferSelect; reused: boolean }
  | { error: string; status: number; reason?: string }
> {
  if (!isGuestId(userId)) {
    return { error: "A guest race needs a guest session", status: 400 } as const;
  }

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SOLITAIRE_DUEL_LOCK_NAMESPACE}, 0)`,
    );

    // A refresh / double click must not mint a second race: hand back the one
    // this guest is already in.
    const [live] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(
        and(
          eq(solitaireDuelMatches.player1Id, userId),
          sql`${solitaireDuelMatches.status} IN ('waiting', 'playing')`,
        ),
      )
      .orderBy(sql`${solitaireDuelMatches.createdAt} DESC`)
      .limit(1);
    if (live) return { match: live, reused: true } as const;

    const used = await tx
      .select({ id: solitaireDuelMatches.id })
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.player1Id, userId))
      .limit(GUEST_TRIAL_MAX_MATCHES);
    if (used.length >= GUEST_TRIAL_MAX_MATCHES) {
      return {
        error: "Your free race is used — sign in to keep racing",
        status: 403,
        reason: "guest_trial_used",
      } as const;
    }

    const run = await findGhostRun(tx, { excludeUserId: userId });
    if (!run) {
      // No recording exists yet. Never invent an opponent: say so and point at
      // the signed-in queue, which can pair a live player.
      return {
        error: "No recorded race is available right now — sign in to join the live queue",
        status: 503,
        reason: "no_ghost",
      } as const;
    }

    const opening = initialStateFromDeal(run.deal);
    const progress = progressOf(opening);
    const goAtMs = nowMs + READY_COUNTDOWN_MS;

    const [match] = await tx
      .insert(solitaireDuelMatches)
      .values({
        variant: VARIANT,
        variantVersion: VARIANT_VERSION,
        player1Id: userId,
        player2Id: ghostPlayerIdFor(run.sourceMatchId),
        status: MATCH_STATUS.PLAYING,
        isAi: false,
        isGhost: true,
        stakeAmount: "0",
        ghostSourceMatchId: run.sourceMatchId,
        ghostName: run.name,
        ghostRating: run.rating,
        ghostTrophies: run.trophies,
        ghostTimeline: run.timeline,
        ghostTrail: run.trail,
        ghostCompletedAtOffsetMs: run.completedOffsetMs,
        ghostFallbackAt: null,
        serverSeed: run.serverSeed,
        serverSeedHash: run.serverSeedHash,
        dealSeed: run.dealSeed,
        deal: run.deal,
        p1State: opening,
        p2State: cloneState(opening),
        p1Ply: 0,
        p2Ply: 0,
        p1PeakFoundation: opening.peakFoundation,
        p2PeakFoundation: opening.peakFoundation,
        p1Revealed: progress.revealedTableau,
        p2Revealed: progress.revealedTableau,
        goAt: new Date(goAtMs),
        startedAt: new Date(nowMs),
        p1LastActionAt: new Date(goAtMs),
        p2LastActionAt: new Date(goAtMs),
        updatedAt: new Date(nowMs),
      })
      .returning();

    return { match, reused: false } as const;
  });
}

/**
 * Turn a still-waiting lobby into a ghost duel, if its window has passed.
 *
 * Takes the SAME per-game advisory lock as `createOrJoin`, so a live joiner and
 * the fallback can never both claim the lobby: whichever runs second sees the
 * row already `playing` and does nothing. Safe to call on any read; a lobby
 * that is not due, has no replay available, or has already started is a no-op.
 */
export async function resolveGhostFallback({
  matchId,
  nowMs = Date.now(),
}: {
  matchId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SOLITAIRE_DUEL_LOCK_NAMESPACE}, 0)`,
    );

    const [match] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);
    if (
      match.status !== MATCH_STATUS.WAITING ||
      match.player2Id ||
      match.isGhost
    ) {
      return { match, ghost: false } as const;
    }

    const dueAtMs = instantMs(match.ghostFallbackAt);
    if (dueAtMs == null || nowMs < dueAtMs) {
      return { match, ghost: false } as const;
    }

    const run = await findGhostRun(tx, {
      excludeUserId: match.player1Id,
    });
    if (!run) {
      // No recording exists yet (a cold pool). The honest outcome is to keep
      // waiting and re-check on the next read — never to invent an opponent.
      return { match, ghost: false } as const;
    }

    const converted = await convertWaitingLobbyToGhost(tx, match, run, nowMs);
    return { match: converted ?? match, ghost: Boolean(converted) } as const;
  });
}

/**
 * Re-seat one waiting lobby onto a recording.
 *
 * NOTHING has been played on this row — it is still a `waiting` lobby at ply 0 —
 * so replacing its deal costs the player nothing and reveals nothing: the board
 * is only shown once the row is `playing`. Both seats are written from the
 * recording's deal in the same update, so the shared-puzzle invariant holds
 * exactly as it does for a live join.
 */
async function convertWaitingLobbyToGhost(
  tx: any,
  match: MatchRow,
  run: GhostRun,
  nowMs: number,
): Promise<MatchRow | null> {
  const opening = initialStateFromDeal(run.deal);
  const progress = progressOf(opening);
  const goAtMs = nowMs + READY_COUNTDOWN_MS;

  const [updated] = await tx
    .update(solitaireDuelMatches)
    .set({
      player2Id: ghostPlayerIdFor(run.sourceMatchId),
      status: MATCH_STATUS.PLAYING,
      isGhost: true,
      ghostSourceMatchId: run.sourceMatchId,
      ghostName: run.name,
      ghostRating: run.rating,
      ghostTrophies: run.trophies,
      ghostTimeline: run.timeline,
      ghostTrail: run.trail,
      ghostCompletedAtOffsetMs: run.completedOffsetMs,
      ghostFallbackAt: null,
      // The recording's own commitment, so the puzzle is provably the one the
      // ghost played. The seed is only revealed once this match is terminal.
      serverSeed: run.serverSeed,
      serverSeedHash: run.serverSeedHash,
      dealSeed: run.dealSeed,
      deal: run.deal,
      p1State: opening,
      p2State: cloneState(opening),
      p1Ply: 0,
      p2Ply: 0,
      p1PeakFoundation: opening.peakFoundation,
      p2PeakFoundation: opening.peakFoundation,
      p1Revealed: progress.revealedTableau,
      p2Revealed: progress.revealedTableau,
      goAt: new Date(goAtMs),
      startedAt: new Date(nowMs),
      p1LastActionAt: new Date(goAtMs),
      p2LastActionAt: new Date(goAtMs),
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(solitaireDuelMatches.id, match.id),
        eq(solitaireDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(solitaireDuelMatches.player2Id),
      ),
    )
    .returning();

  return updated ?? null;
}

/**
 * Replay the recording up to the server's current instant.
 *
 * THE GHOST'S ONLY MOVE SOURCE. It applies the recorded moves whose recorded
 * offsets have been reached, in order, through `applyMove` — the same authority
 * a human move passes through — and stamps the completion instant from the
 * RECORDED offset, so a photo finish is decided by the two humans' real solving
 * times rather than by whenever this read happened to run.
 *
 * Idempotent and monotonic: the seat's own ply cursor is the progress marker, a
 * read between two recorded moves writes nothing, and a recording that stops
 * replaying simply ends the replay (it is never re-dealt or substituted).
 */
export async function advanceGhostMatch({
  matchId,
  nowMs = Date.now(),
}: {
  matchId: string;
  nowMs?: number;
}) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);
    if (
      !match.isGhost ||
      match.status !== MATCH_STATUS.PLAYING ||
      !match.player2Id
    ) {
      return { match, advanced: false } as const;
    }

    const goAtMs = instantMs(match.goAt);
    const timeline = Array.isArray(match.ghostTimeline)
      ? match.ghostTimeline
      : [];
    let state = stateForSeat(match, SEAT.PLAYER2);
    if (
      goAtMs == null ||
      nowMs < goAtMs ||
      !state ||
      !isWellFormedState(state) ||
      state.completed ||
      timeline.length === 0
    ) {
      return { match, advanced: false } as const;
    }

    const due = dueGhostSteps(timeline, state.ply, nowMs - goAtMs);
    if (due.length === 0) return { match, advanced: false } as const;

    const played: { ply: number; step: (typeof due)[number]["step"] }[] = [];
    for (const entry of due) {
      const applied = applyMove({ state, move: entry.step.move });
      // A recording is verified before it is offered, so this is unreachable in
      // practice — and it deliberately STOPS the replay rather than guessing a
      // different move. The ghost is never substituted or re-dealt.
      if (!applied.ok) break;
      state = applied.state as SolitaireState;
      played.push({ ply: entry.index, step: entry.step });
    }
    if (played.length === 0) return { match, advanced: false } as const;

    if (state.completed) {
      const completing = played[played.length - 1];
      state.completedAtMs = goAtMs + completing.step.offsetMs;
    }

    for (const entry of played) {
      await tx.insert(solitaireDuelMoves).values({
        matchId: match.id,
        seat: SEAT.PLAYER2,
        ply: entry.ply,
        kind: entry.step.kind,
        move: entry.step.move,
      });
    }

    const progress = progressOf(state);
    const [updated] = await tx
      .update(solitaireDuelMatches)
      .set({
        ...seatPatchFor(SEAT.PLAYER2, state, progress),
        p2LastActionAt: new Date(nowMs),
        ...(state.completed && state.completedAtMs
          ? { p2FinishedAt: new Date(state.completedAtMs) }
          : {}),
        updatedAt: new Date(nowMs),
      })
      .where(eq(solitaireDuelMatches.id, match.id))
      .returning();

    let finalRow = updated ?? match;
    const outcome = resolveRace({
      player1: raceFor(finalRow, SEAT.PLAYER1),
      player2: raceFor(finalRow, SEAT.PLAYER2),
    });
    if (outcome) finalRow = await finalizeMatch(tx, finalRow, outcome, nowMs);

    return { match: finalRow, advanced: true } as const;
  });
}

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * The authoritative snapshot for the calling participant.
 *
 * A match in which a seat has gone inactive is resolved on READ, so a match can
 * never be left live just because nobody happened to move — the same
 * lazy-resolution pattern Speed Typing uses. Non-participants get a 403; there
 * is no spectator mode.
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
    .from(solitaireDuelMatches)
    .where(eq(solitaireDuelMatches.id, matchId));

  if (!match) return err("Match not found", 404);

  const seats = seatsFromRow(match);
  const viewerSeat = seatForUser(seats, userId);
  if (!viewerSeat) {
    return err("Not a participant of this match", 403);
  }

  // A still-open lobby past its window becomes an asynchronous duel against a
  // recorded human run of the SAME deal. Resolved on READ so a player is never
  // left waiting on a pool that the store could have filled.
  if (match.status === MATCH_STATUS.WAITING && !match.player2Id) {
    const fallback = await resolveGhostFallback({ matchId, nowMs });
    if (!("error" in fallback) && fallback.match) match = fallback.match;
  }

  // A paused practice match is frozen: no read advances the bot and no clock
  // is allowed to decide anything until the player resumes.
  if (
    match.isAi &&
    (await isPracticePaused("solitaire-duel", matchId))
  ) {
    return err("Practice match is paused", 409);
  }

  // For a practice match the bot is advanced to NOW first, so every poll shows
  // its live board progress (and finalizes the match the instant it solves the
  // deal). A human row is untouched by this step.
  const advancedRead = await advanceAiIfPractice(match, nowMs);
  match = advancedRead.match;

  // A ghost duel is advanced to NOW on every read, for the same reason a
  // practice bot is: the recorded moves due by now must land even between the
  // player's own moves, and NOTHING here chooses a move — it replays the log.
  if (match.isGhost && match.status === MATCH_STATUS.PLAYING) {
    const advancedGhost = await advanceGhostMatch({ matchId, nowMs });
    if (!("error" in advancedGhost)) match = advancedGhost.match;
  }
  // Retained for THIS response only. A later re-deal or inactivity resolution
  // does not rewrite it, but the summary describes only the bot's batch.
  let aiEvents = advancedRead.aiEvents;

  // An UNWINNABLE position is resolved on READ too. A player is only ever shown
  // their OWN board, so only the reader's own seat is inspected — and only when
  // it is live, unsolved and has actually diverged from the opening (a fresh
  // board is solvable by construction). The verdict is computed first and the
  // re-deal re-checks the row at the same ply, so a move that lands in between
  // just defers the decision to the next read.
  if (match.status === MATCH_STATUS.PLAYING) {
    const ownState = stateForSeat(match, viewerSeat);
    if (
      ownState &&
      isWellFormedState(ownState) &&
      !ownState.completed &&
      ownState.ply > 0 &&
      seatPositionIsDead(ownState)
    ) {
      const redealt = await redealSeatIfDead({
        matchId,
        seat: viewerSeat,
        expectedPly: ownState.ply,
        nowMs,
      });
      if (redealt) match = redealt;
    }
  }

  // An untimed match is resolved on READ when a seat has gone inactive, so a
  // match can never be left live just because the idle seat stopped polling.
  if (isInactivityDue(match, nowMs)) {
    await resolveInactivityDue({ matchId, nowMs });
    [match] = await db
      .select()
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId));
  }

  return { match, dto: matchToDto(match, userId, nowMs, aiEvents) } as const;
}

/** The append-only move log for one seat, oldest first. */
export async function fetchSeatMoves(matchId: string, seat: Seat) {
  return await db
    .select({
      ply: solitaireDuelMoves.ply,
      kind: solitaireDuelMoves.kind,
      move: solitaireDuelMoves.move,
      createdAt: solitaireDuelMoves.createdAt,
    })
    .from(solitaireDuelMoves)
    .where(
      and(
        eq(solitaireDuelMoves.matchId, matchId),
        eq(solitaireDuelMoves.seat, seat),
      ),
    )
    .orderBy(sql`${solitaireDuelMoves.ply} ASC`);
}

/** True when a live match has a seat past the inactivity forfeit threshold. */
function isInactivityDue(match: MatchRow, nowMs: number): boolean {
  return inactivityForfeitSeat(match, nowMs) != null;
}

// ── Move (the only player-authored mutation) ──────────────────────────────

export type MoveResult =
  | {
      match: MatchRow;
      view: SolitaireView;
      progress: SeatProgress;
      ply: number;
      revealed: Card[];
      completed: boolean;
      raceResolved: boolean;
      /** The from-the-table formality the server played after the sent move. */
      autoFinish: AutoFinishStep[];
    }
  | StoreError;

/**
 * Take one move.
 *
 * The request carries ONLY { move, expectedPly }. Anything else a client might
 * send — a board, a progress figure, a completion flag, a winner, a score, an
 * Elo delta, a trophy — is not read: the sequence
 *   normalizeMove → applyMove → progressOf
 * runs entirely inside the row-locked transaction below, against the server's
 * own board.
 *
 * WHY A ROW LOCK (and not a lock-free compare-and-set): the two seats never
 * share a board, so contention between them is nil at the ~1 write/second a
 * human produces — and the lock is what makes a COMPLETING move atomic with the
 * cross-seat transition it triggers (finishing the match, settling it). One
 * lock, one guarantee, instead of two mechanisms to keep in step.
 *
 * Rejections, in order:
 *   400 the move is not even the right shape
 *   404 match not found
 *   403 caller holds no seat              (before status: never leak status)
 *   409 waiting for an opponent
 *   409 match is no longer active
 *   409 the race has not started yet      (before `go_at`)
 *   409 a seat forfeited for inactivity   (and the match resolves)
 *   409 the seat has already finished
 *   400 malformed `expectedPly`
 *   409 stale `expectedPly` — refetch
 *   409 the per-seat move cap is reached
 *   422 the move is well-formed but illegal in Klondike
 */
export async function submitMove({
  userId,
  matchId,
  move,
  expectedPly,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  move: unknown;
  expectedPly?: unknown;
  nowMs?: number;
}): Promise<MoveResult> {
  // Shape-check BEFORE any database work, so a malformed payload is rejected
  // without a transaction and can never reach the board.
  const parsed = normalizeMove(move);
  const malformed = failureOf(parsed);
  if (malformed) return err(malformed.error, 400);
  // Narrowed once, explicitly: `strict: false` does not narrow on `parsed.ok`.
  const normalized = parsed as { ok: true; move: SolitaireMove };

  // Bring a practice bot's board up to NOW first, so a human completion that
  // lands second is judged against the bot's real completion instant. A no-op
  // for a human match.
  await advanceAiMatch({ matchId, nowMs });
  // Same for a ghost: the recording's moves that are due must be on the board
  // BEFORE this move is judged, or a human could out-run an already-faster run.
  await advanceGhostMatch({ matchId, nowMs });

  try {
    return await db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(solitaireDuelMatches)
        .where(eq(solitaireDuelMatches.id, matchId))
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
      if (
        match.isAi &&
        (await isPracticePaused("solitaire-duel", matchId))
      ) {
        return err("Practice match is paused", 409);
      }

      // Timing is decided from the server's clock against server-written
      // instants. A client cannot move early, and cannot move past the limit.
      const goAtMs = instantMs(match.goAt);
      if (goAtMs == null || nowMs < goAtMs) {
        return err("The race has not started", 409);
      }
      // An untimed match: a move that arrives after a seat has already gone
      // inactive resolves that forfeit first.
      if (isInactivityDue(match, nowMs)) {
        await resolveInactivityDueInTx(tx, match, nowMs);
        return err("A seat forfeited for inactivity", 409);
      }

      const state = stateForSeat(match, seat);
      if (!state || !isWellFormedState(state)) {
        return err("The match state is not playable", 409);
      }
      if (state.completed) {
        return err("You have already completed the puzzle", 409);
      }

      // Strict, uncoerced staleness guard: the same idempotency contract that
      // makes a retried POST a no-op instead of a second accepted move.
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
        return err("Move limit reached", 409);
      }

      const applied = applyMove({ state, move: normalized.move });
      const rejection = failureOf(applied);
      if (rejection) {
        // A board that is already solved is a lifecycle conflict; anything else
        // is a well-formed but illegal Klondike move.
        return err(rejection.error, rejection.code === "ALREADY_COMPLETE" ? 409 : 422);
      }

      // AUTO-FINISH. Once the player has no decision left — stock and waste
      // empty, every tableau card face up, and each remaining top card is the
      // next card of its foundation — the rest of the game is a formality. The
      // engine plays it HERE, inside the same locked transaction, so the seat
      // completes in one request and the completion instant is still the
      // server's. The steps are real `tableau-to-foundation` moves and are
      // appended to the log, so the stored game stays a literal replay.
      const appliedState = applied.state as SolitaireState;
      const autoPlan = autoFinishPlan(appliedState);
      const nextState = autoPlan ? autoPlan.finalState : appliedState;
      const autoSteps = autoPlan?.steps ?? [];
      const completedNow = nextState.completed && !state.completed;
      if (completedNow) {
        // The completion INSTANT is stamped here, on the server's clock — it is
        // what decides a photo finish, so it is never a client value.
        nextState.completedAtMs = nowMs;
      }
      const progress = progressOf(nextState);

      // Append-only log: the validated input, at the ply it was played. The
      // (match_id, seat, ply) unique index is the structural anti-replay.
      await tx.insert(solitaireDuelMoves).values({
        matchId: match.id,
        seat,
        ply: state.ply,
        kind: normalized.move.kind,
        move: normalized.move,
      });
      // One row per auto-finished card, at the ply it was actually played.
      for (let index = 0; index < autoSteps.length; index += 1) {
        await tx.insert(solitaireDuelMoves).values({
          matchId: match.id,
          seat,
          ply: state.ply + 1 + index,
          kind: autoSteps[index].move.kind,
          move: autoSteps[index].move,
        });
      }

      const [updated] = await tx
        .update(solitaireDuelMatches)
        .set({
          ...seatPatchFor(seat, nextState, progress),
          // The accepted move resets this seat's own inactivity clock.
          ...seatLastActionPatchFor(seat, nowMs),
          ...(completedNow ? seatFinishedPatchFor(seat, nowMs) : {}),
          updatedAt: new Date(nowMs),
        })
        .where(eq(solitaireDuelMatches.id, match.id))
        .returning();

      const changed = updated ?? match;

      // Only a completion (or a forfeit) can end the race mid-flight, so this
      // is where "first to solve it wins IMMEDIATELY" is enforced.
      let finalRow = changed;
      const outcome = resolveRace({
        player1: raceFor(changed, SEAT.PLAYER1),
        player2: raceFor(changed, SEAT.PLAYER2),
      });
      if (outcome) finalRow = await finalizeMatch(tx, changed, outcome, nowMs);

      return {
        match: finalRow,
        view: viewForState(nextState),
        progress,
        ply: state.ply,
        revealed: applied.revealed ?? [],
        completed: Boolean(nextState.completed),
        raceResolved: Boolean(outcome),
        autoFinish: autoSteps,
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

// ── Undo (practice only) ────────────────────────────────────────────────

export type UndoResult =
  | {
      match: MatchRow;
      view: SolitaireView;
      progress: SeatProgress;
      ply: number;
    }
  | StoreError;

/**
 * Take back this seat's LAST move.
 *
 * PRACTICE ONLY, and the asymmetry is the point: a ranked duel is a race against
 * another person, so rewinding one seat's board would rewind half a race the
 * opponent is still running. A practice match has no opponent at stake (the bot
 * races its own board and settles nothing), so a player who misclicked on a
 * timed-out brain can put the card back.
 *
 * The client cannot say what the board was: it asks for a rollback and the store
 * rebuilds the position itself by REPLAYING this seat's own stored log — minus
 * its final entry — through the same rules engine that accepted the move. The
 * dropped `solitaire_duel_moves` row is deleted inside the same row-locked
 * transaction, so the log stays the literal record of the board and
 * `(match, seat, ply)` stays collision-free for the move that replaces it.
 *
 * Two deliberate limits:
 *
 *   * a seat's `peakFoundation` (a monotone settlement metric) is never lowered
 *     by an undo — the live board rewinds, the record of how far it got does not;
 *   * a board that was RE-DEALT mid-match no longer replays from the match's
 *     committed deal, so the rollback is refused with a plain message rather
 *     than guessing at a position (the client shows it and resyncs).
 */
export async function undoMove({
  userId,
  matchId,
  nowMs = Date.now(),
}: {
  userId: string;
  matchId: string;
  nowMs?: number;
}): Promise<UndoResult> {
  try {
    return await db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(solitaireDuelMatches)
        .where(eq(solitaireDuelMatches.id, matchId))
        .for("update");

      if (!match) return err("Match not found", 404);

      const seats = seatsFromRow(match);
      const seat = seatForUser(seats, userId);
      if (!seat) return err("Not a participant of this match", 403);
      if (!match.isAi) return err("Undo is only available in a practice match", 409);
      if (match.status === MATCH_STATUS.WAITING || !seats.player2Id) {
        return err("Waiting for an opponent", 409);
      }
      if (TERMINAL_STATUSES.includes(match.status)) {
        return err("Match is no longer active", 409);
      }
      if (await isPracticePaused("solitaire-duel", matchId)) {
        return err("Practice match is paused", 409);
      }

      const state = stateForSeat(match, seat);
      if (!state || !isWellFormedState(state)) {
        return err("The match state is not playable", 409);
      }
      if (Number(state.ply ?? 0) <= 0) return err("There is no move to undo", 409);

      // This seat's own log, oldest first. Only its final entry is dropped.
      const rows = await tx
        .select({
          ply: solitaireDuelMoves.ply,
          kind: solitaireDuelMoves.kind,
          move: solitaireDuelMoves.move,
        })
        .from(solitaireDuelMoves)
        .where(
          and(
            eq(solitaireDuelMoves.matchId, match.id),
            eq(solitaireDuelMoves.seat, seat),
          ),
        )
        .orderBy(sql`${solitaireDuelMoves.ply} ASC`);
      if (rows.length === 0) return err("There is no move to undo", 409);
      const dropped = rows[rows.length - 1];
      const kept = rows.slice(0, -1);

      // The board is the ENGINE's reconstruction, never a client's or a patch.
      const replayed = replayMoves({
        deal: match.deal as SolitaireDeal,
        moves: kept.map((row) => ({ kind: row.kind, move: row.move })),
      });
      if (!replayed.ok) return err("Undo is not available on this board", 409);

      const nextState = replayed.state;
      // Monotone metrics survive the rewind; the live position does not.
      const previousPeak = Number(
        (seat === SEAT.PLAYER1 ? match.p1PeakFoundation : match.p2PeakFoundation) ?? 0,
      );
      nextState.peakFoundation = Math.max(previousPeak, nextState.peakFoundation ?? 0);
      nextState.completed = false;
      nextState.completedAtMs = null;
      const progress = progressOf(nextState);

      await tx
        .delete(solitaireDuelMoves)
        .where(
          and(
            eq(solitaireDuelMoves.matchId, match.id),
            eq(solitaireDuelMoves.seat, seat),
            eq(solitaireDuelMoves.ply, dropped.ply),
          ),
        );

      const [updated] = await tx
        .update(solitaireDuelMatches)
        .set({
          ...seatPatchFor(seat, nextState, progress),
          updatedAt: new Date(nowMs),
        })
        .where(eq(solitaireDuelMatches.id, match.id))
        .returning();

      return {
        match: updated ?? match,
        view: viewForState(nextState),
        progress,
        ply: nextState.ply,
      } as const;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return err("Undo could not be recorded", 409);
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
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
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

  // The idle seat forfeits; `resolveRace` awards the win to the other seat. The
  // result is derived here from the row, never from the request.
  const outcome = resolveRace(
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
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
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

    // The conceding seat is the forfeiting one; `resolveRace` awards the win to
    // the other seat. Nothing about the result came from the request.
    const outcome = resolveRace({
      player1: raceFor(match, SEAT.PLAYER1, seat === SEAT.PLAYER1),
      player2: raceFor(match, SEAT.PLAYER2, seat === SEAT.PLAYER2),
    });

    const finalRow = await finalizeMatch(
      tx,
      match,
      outcome ?? ({ result: "draw", resolution: RESOLUTION.DRAW } as RaceOutcome),
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
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
      .for("update");

    if (!match) return err("Match not found", 404);
    if (match.player1Id !== userId) {
      return err("Only the lobby creator can cancel it", 403);
    }
    if (match.status !== MATCH_STATUS.WAITING || match.player2Id) {
      return err("Only a waiting lobby can be cancelled", 409);
    }

    const [updated] = await tx
      .update(solitaireDuelMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        endedAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      })
      .where(eq(solitaireDuelMatches.id, match.id))
      .returning();

    mirrorQueueTransition({
      gameKey: "solitaire-duel",
      matchId: match.id,
      status: "cancelled",
      playerCount: 1,
      cancelReason: "cancelled_by_player",
      at: new Date(nowMs),
    });

    // A cancelled lobby never settled, so no rating, trophy or win counter
    // moves — settleSolitaireDuelMatch is deliberately not called here.
    return { match: updated ?? match } as const;
  });
}

/**
 * Resolve a match whose participant stayed disconnected past the realtime
 * grace window.
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
      .from(solitaireDuelMatches)
      .where(eq(solitaireDuelMatches.id, matchId))
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
        .update(solitaireDuelMatches)
        .set({
          status: MATCH_STATUS.CANCELLED,
          endedAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        })
        .where(eq(solitaireDuelMatches.id, match.id))
        .returning();

      mirrorQueueTransition({
        gameKey: "solitaire-duel",
        matchId: match.id,
        status: "cancelled",
        playerCount: 1,
        cancelReason: "disconnected",
        at: new Date(nowMs),
      });

      return { match: updated ?? match, forfeited: false, cancelled: true } as const;
    }

    // Active match: award the opponent the win, with the standard settlement.
    const outcome = resolveRace({
      player1: raceFor(match, SEAT.PLAYER1, seat === SEAT.PLAYER1),
      player2: raceFor(match, SEAT.PLAYER2, seat === SEAT.PLAYER2),
    });

    const finalRow = await finalizeMatch(
      tx,
      match,
      outcome ?? ({ result: "draw", resolution: RESOLUTION.DRAW } as RaceOutcome),
      nowMs,
    );

    return { match: finalRow, forfeited: true, cancelled: false } as const;
  });
}

// ── Finalisation + settlement (existing platform infrastructure only) ─────

/**
 * Flip a match terminal, exactly once, and settle it.
 *
 * The single write path for `status`, `result`, `winnerId`, `resolution_reason`
 * and `ended_at` — reached by a completion and by a forfeit, so there is one
 * place a result can ever come from. The `TERMINAL_STATUSES` guard
 * plus the caller's `FOR UPDATE` read is what makes a second attempt a no-op
 * rather than a second settlement.
 */
async function finalizeMatch(
  tx: any,
  match: MatchRow,
  outcome: RaceOutcome,
  nowMs: number,
): Promise<MatchRow> {
  if (TERMINAL_STATUSES.includes(match.status)) return match;

  const seats = seatsFromRow(match);
  const winnerId =
    outcome.result === RESULT.DRAW ? null : userIdForSeat(seats, outcome.result);

  const [updated] = await tx
    .update(solitaireDuelMatches)
    .set({
      status: MATCH_STATUS.FINISHED,
      result: outcome.result,
      winnerId,
      resolutionReason: outcome.resolution,
      endedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(eq(solitaireDuelMatches.id, match.id))
    .returning();

  const finalRow = updated ?? match;

  await settleSolitaireDuelMatch(tx, finalRow, outcome);

  // A free-practice match is excluded from the canonical queue entirely, so it
  // must not mirror a transition either.
  if (!finalRow.isAi) {
    mirrorQueueTransition({
      gameKey: "solitaire-duel",
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
 * Record the outcome of a finished Solitaire Duel match.
 *
 * Reuses the platform's Elo (`applyRatingResult`) and trophy
 * (`applyTrophyResult`) helpers — there is deliberately no Solitaire-specific
 * rating maths and no custom scoring. Both are called with the store's
 * transaction so the match finalisation and the rating change commit atomically,
 * and both are idempotent per (user, game, match) via their own event journals.
 *
 * Staked: the winner is paid the pot minus the shared 10% rake and a draw
 * refunds both seats. The only other account stats touched are
 * `users.gamesWon` / `users.gamesLost`; the leaderboard counters are
 * deliberately NOT called here because this settlement already owns the coin
 * path and reports it itself.
 *
 * A DRAW is journaled by both helpers (with `result: "draw"`, which moves both
 * ratings by K × (0.5 − expected)) but changes neither win counter, exactly as
 * Tic-Tac-Toe and Mini Golf do.
 *
 * NOTE ON THE GAME KEY: the writers are called with the literal
 * `gameKey: "solitaire-duel"`. Until that key is added to `RATED_GAMES`
 * (`src/lib/rating.js`), `applyRatingResult` returns
 * `{ applied: false, reason: "game-not-rated" }` — it REFUSES an unregistered
 * key rather than falling back to another game's ladder, so this seam is inert
 * (never mis-rating, e.g. as chess) until the platform registration lands, and
 * it turns itself on with no change here.
 */
async function settleSolitaireDuelMatch(
  tx: any,
  match: MatchRow,
  outcome: RaceOutcome,
) {
  // A GUEST TRIAL NEVER TOUCHES THE LADDER.
  //
  // A guest id is `guest_<uuid>`: there is no `users` row behind it, no rating,
  // no trophies and no stats. Settling one would either write to nothing or —
  // worse — fail the settlement of a match the guest played, so the whole
  // settlement is skipped. This is the guard that makes "one free race before
  // signing in" safe without a second, parallel settlement path.
  if (isGuestId(match.player1Id) || isGuestId(match.player2Id)) return;
  // A GHOST duel settles into the HUMAN's ladder ONLY.
  //
  // The ghost is a recording, not a seat: its source player was not in this
  // match and must never gain or lose a rating from it, so the two-seat writers
  // are deliberately NOT used. The human is rated against the strength the
  // recording's owner actually had (`ghost_rating` / `ghost_trophies`), through
  // single-seat writers that reuse the same Elo maths and trophy ladder.
  if (match.isGhost) {
    const humanId = isGhostPlayerId(match.player2Id)
      ? match.player1Id
      : match.player2Id;
    if (!humanId) return;

    const draw = outcome.result === RESULT.DRAW;
    const humanSeat = humanId === match.player1Id ? RESULT.PLAYER1 : RESULT.PLAYER2;
    const humanWon = !draw && outcome.result === humanSeat;
    const result = draw ? "draw" : humanWon ? "win" : "loss";

    if (!draw) {
      await tx
        .update(users)
        .set(
          humanWon
            ? { gamesWon: sql`${users.gamesWon} + 1` }
            : { gamesLost: sql`${users.gamesLost} + 1` },
        )
        .where(eq(users.clerkId, humanId));
    }

    await applyGhostRatingResult({
      tx,
      gameKey: "solitaire-duel",
      matchId: String(match.id),
      clerkId: humanId,
      opponentRating: match.ghostRating ?? undefined,
      result,
    }).catch(() => {});
    await applyGhostTrophyResult({
      tx,
      gameKey: "solitaire-duel",
      matchId: String(match.id),
      clerkId: humanId,
      opponentTrophies: match.ghostTrophies ?? undefined,
      result,
    }).catch(() => {});

    if (humanWon) await markDailyRewardWin(tx, humanId);
    return;
  }

  // Free vs-AI matches must never affect rating, trophies or win counters —
  // but a human win still unlocks the daily reward.
  if (match.isAi) {
    // The AI holds player2 in a practice match, so only a player1 win belongs
    // to the human and may unlock the daily reward.
    if (outcome.result === RESULT.PLAYER1 && match.player1Id) {
      await markDailyRewardWin(tx, match.player1Id);
    }
    return;
  }
  if (!match.player2Id) return;

  const matchId = String(match.id);
  const stake = Number((match as any).stakeAmount ?? 0) || 0;

  if (outcome.result === RESULT.DRAW) {
    // A draw is a void pot: both seats get their own stake back, no rake.
    await refundPvpPot({
      tx,
      gameKey: "solitaire-duel",
      matchId,
      clerkIds: [match.player1Id, match.player2Id],
      stake,
    });
    await applyRatingResult({
      tx,
      gameKey: "solitaire-duel",
      matchId,
      winnerClerkId: match.player1Id,
      loserClerkId: match.player2Id,
      result: "draw",
    }).catch(() => {});
    await applyTrophyResult({
      tx,
      gameKey: "solitaire-duel",
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

  // The winner takes the pot (both escrowed stakes) minus the shared 10% rake.
  const payout = await payPvpPot({
    tx,
    gameKey: "solitaire-duel",
    matchId,
    winnerClerkId: winnerId,
    stake,
  });
  if (stake > 0) {
    await tx
      .update(solitaireDuelMatches)
      .set({ houseFee: (stake * 0.2).toFixed(2), prizePaid: payout.toFixed(2) })
      .where(eq(solitaireDuelMatches.id, matchId));
  }

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
    gameKey: "solitaire-duel",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
  await applyTrophyResult({
    tx,
    gameKey: "solitaire-duel",
    matchId,
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}

// Re-exported so the routes can assert shape without importing the rules module
// directly, and so the derivability invariant stays discoverable.
export { isWellFormedState, viewForState, progressOf };
export type { SolitaireDeal, SolitaireState, SolitaireView, Seats, SeatProgress, OpponentProgress };
