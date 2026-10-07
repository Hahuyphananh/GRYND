// src/lib/mines-pvp/serverStore.js
//
// Server-side canonical helpers for the Mines PvP ("Mines Duel") match
// system — SIMULTANEOUS, INDEPENDENT-BOARD scoring model.
//
// The state machine:
//   waiting → ready → active → finished
//   (waiting/ready/active → cancelled)
//
//   • `waiting`  — host has created a lobby, no opponent yet.
//   • `ready`    — both seats filled; a short 3-second banner runs while
//                  the server holds the single 180-second match timer.
//   • `active`   — both players play AT WILL and AT THE SAME TIME on
//                  their OWN server-generated board. There are no turns.
//   • `finished` — both boards completed, or the match timer expired.
//                  The score/tiebreak ladder names the winner (or a
//                  deterministic draw).
//
// Everything here is server-authoritative. The client can only ever send
// a `cellIndex`; it can never submit a score, a mine value, a mine
// position, a completion, a timer or another seat's action.
//
// Mirrors the architectural shape of the other PvP stores (advisory-lock
// matchmaking, FOR UPDATE row locks, conditional updates, best-effort
// stat side-effects) while implementing the Mines-specific rules.

import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { STAKES_RETIRED, normalizeStake } from "../games/stakes";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { getFrameDecorations } from "../cosmetics";
import {
  glows,
  minesPvpMatches,
  minesPvpRounds,
  tokenSubscriptions,
  users,
} from "../../db/schema";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../stripe/subscriptions";
import { sendSystemNotificationEmail } from "../emails/system";
import { mirrorMinesQueued, mirrorMinesTransition } from "./canonicalLifecycle";
import { guestSeatSummary, isGuestId } from "../guestIdentity";
import { coerceAiDifficulty } from "../aiDifficulty";
import {
  AI_PICK_DELAY_MS,
  GRID_CELLS,
  MATCH_STATUS,
  MATCH_TIMER_SECONDS,
  MAX_STAKE,
  MIN_STAKE,
  MINES_AI_PLAYER_ID,
  MINES_PER_MATCH,
  MINES_PVP_LOCK_NAMESPACE,
  PICKABLE_STATES,
  READY_WINDOW_MS,
  RESULT,
  SCORE,
  TERMINAL_STATES,
  WIN_REASON,
  ACTION_KIND,
  applyScoreDelta,
  chooseAiActionForSeat,
  correctFlagsForSeat,
  flagsForSeat,
  generateBoardPair,
  isBoardComplete,
  isFreeAiMatch,
  isMine,
  mineValueAt,
  nearestMineDistance,
  normalizeFlags,
  revealedForSeat,
  resolveScoredMatch,
} from "./constants";

// ── Helpers ───────────────────────────────────────────────────────────

// The two seat labels, in a stable order.
const SEATS = ["player1", "player2"];

function seatRow(match, seat) {
  return seat === "player2" ? match?.p2Board : match?.p1Board;
}

function scoreForSeat(match, seat) {
  return Number(seat === "player2" ? match?.p2Score : match?.p1Score) || 0;
}

function isSeatLocked(match, seat) {
  return Boolean(seat === "player2" ? match?.p2Locked : match?.p1Locked);
}

// Stable deterministic hash from numeric stake to a signed 32-bit int.
// Used purely as the second key of the two-key pg_advisory_xact_lock for
// stake-keyed matchmaking.
function hashStakeToInt(stake) {
  const fixed = Number(stake).toFixed(2);
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < fixed.length; i += 1) {
    h ^= fixed.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV-1a 32-bit prime
  }
  return (h | 0) & 0x7fffffff;
}

export function seatForUser(match, userId) {
  if (!match || !userId) return null;
  if (match.player1Id === userId) return "player1";
  if (match.player2Id === userId) return "player2";
  return null;
}

export function isParticipant(match, userId) {
  return seatForUser(match, userId) !== null;
}

// Format a seat-stats update patch onto the match row. Single source of
// truth so the two seats can never be written to each other's columns.
function statsPatch(seat, { score, safeRevealed, minesHit, correctFlagCount, incorrectFlagCount, completed, completedAt, locked }) {
  const p = seat === "player2";
  const patch = {};
  if (score !== undefined) patch[p ? "p2Score" : "p1Score"] = score;
  if (safeRevealed !== undefined) patch[p ? "p2SafeRevealed" : "p1SafeRevealed"] = safeRevealed;
  if (minesHit !== undefined) patch[p ? "p2MinesHit" : "p1MinesHit"] = minesHit;
  if (correctFlagCount !== undefined) patch[p ? "p2CorrectFlagCount" : "p1CorrectFlagCount"] = correctFlagCount;
  if (incorrectFlagCount !== undefined) patch[p ? "p2IncorrectFlagCount" : "p1IncorrectFlagCount"] = incorrectFlagCount;
  if (completed !== undefined) patch[p ? "p2Completed" : "p1Completed"] = completed;
  if (completedAt !== undefined) patch[p ? "p2CompletedAt" : "p1CompletedAt"] = completedAt;
  if (locked !== undefined) patch[p ? "p2Locked" : "p1Locked"] = locked;
  return patch;
}

// ── Parameter validation ──────────────────────────────────────────────
export function validateMatchParams({ stakeAmount, minesCount }) {
  const stake = Number(stakeAmount);
  const mines = Number(minesCount);
  if (
    !STAKES_RETIRED &&
    (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE)
  ) {
    return {
      ok: false,
      error: `Stake must be a number in [${MIN_STAKE}, ${MAX_STAKE}]`,
    };
  }
  if (minesCount != null && mines !== MINES_PER_MATCH) {
    return { ok: false, error: `Mines count is fixed at ${MINES_PER_MATCH}` };
  }
  return { ok: true };
}

// ── Lobby listing ─────────────────────────────────────────────────────
export async function listOpenMatches({ limit = 30 } = {}) {
  return db
    .select({
      id: minesPvpMatches.id,
      player1Id: minesPvpMatches.player1Id,
      stakeAmount: minesPvpMatches.stakeAmount,
      minesCount: minesPvpMatches.minesCount,
      createdAt: minesPvpMatches.createdAt,
    })
    .from(minesPvpMatches)
    .where(
      and(
        eq(minesPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(minesPvpMatches.player2Id),
      ),
    )
    .orderBy(sql`${minesPvpMatches.createdAt} DESC`)
    .limit(limit);
}

// ── Create a free human-vs-AI match ───────────────────────────────────
export async function createAiMatch({ userId, minesCount, difficulty }) {
  if (!userId) return { error: "Unauthorized", status: 401 };

  const aiDifficulty = coerceAiDifficulty(difficulty);

  if (minesCount != null && Number(minesCount) !== MINES_PER_MATCH) {
    return { error: `Mines count is fixed at ${MINES_PER_MATCH}`, status: 400 };
  }

  const { board1, board2 } = generateBoardPair(MINES_PER_MATCH);
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [match] = await db
    .insert(minesPvpMatches)
    .values({
      player1Id: userId,
      player2Id: MINES_AI_PLAYER_ID,
      stakeAmount: "0.00",
      minesCount: MINES_PER_MATCH,
      status: MATCH_STATUS.READY,
      isAi: true,
      aiDifficulty,
      firstPlayerId: userId,
      // Legacy single-board field mirrors seat 1; live play uses the
      // per-seat boards.
      board: board1,
      p1Board: board1,
      p2Board: board2,
      roundTimerSeconds: 20,
      roundDeadline: readyDeadline,
      matchTimerSeconds: MATCH_TIMER_SECONDS,
      startedAt: new Date(),
    })
    .returning();

  mirrorMinesQueued({
    matchId: match.id,
    playerCount: 2,
    queuedAt: match.createdAt ? new Date(match.createdAt) : undefined,
    mode: `ai:${MINES_PER_MATCH}`,
  });

  return { match, joined: true };
}

// ── Create / Join matchmaking ─────────────────────────────────────────
export async function createOrJoin({ userId, stakeAmount, minesCount }) {
  void minesCount; // a client value is never trusted; the constant wins
  stakeAmount = normalizeStake(stakeAmount);
  const validation = validateMatchParams({
    stakeAmount,
    minesCount: MINES_PER_MATCH,
  });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }

  const lockKey = hashStakeToInt(stakeAmount);

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${MINES_PVP_LOCK_NAMESPACE}, ${lockKey})`,
    );

    const [openMatch] = await tx
      .select()
      .from(minesPvpMatches)
      .where(
        and(
          eq(minesPvpMatches.status, MATCH_STATUS.WAITING),
          isNull(minesPvpMatches.player2Id),
          eq(minesPvpMatches.stakeAmount, Number(stakeAmount).toFixed(2)),
        ),
      )
      .orderBy(sql`${minesPvpMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (openMatch) {
      if (openMatch.player1Id === userId) {
        return { match: openMatch, joined: false };
      }
      return await joinExistingMatch(tx, openMatch.id, userId, stakeAmount);
    }

    return await createWaitingMatch(tx, userId, stakeAmount);
  });
}

async function createWaitingMatch(tx, userId, stakeAmount) {
  // Both boards are generated HERE and locked before any joiner arrives.
  const { board1, board2 } = generateBoardPair(MINES_PER_MATCH);
  const [match] = await tx
    .insert(minesPvpMatches)
    .values({
      player1Id: userId,
      stakeAmount: Number(stakeAmount).toFixed(2),
      minesCount: MINES_PER_MATCH,
      status: MATCH_STATUS.WAITING,
      board: board1,
      p1Board: board1,
      p2Board: board2,
      roundTimerSeconds: 20,
      matchTimerSeconds: MATCH_TIMER_SECONDS,
      startedAt: null,
    })
    .returning();

  if (Number(stakeAmount) >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `User ${userId} created mines PvP lobby (${stakeAmount} stake).`,
      metadata: { userId, stakeAmount, minesCount: MINES_PER_MATCH, matchId: match.id },
    }).catch(() => {});
  }

  mirrorMinesQueued({
    matchId: match.id,
    playerCount: 1,
    queuedAt: match.createdAt ? new Date(match.createdAt) : undefined,
    mode: `pvp:${MINES_PER_MATCH}`,
  });
  return { match, joined: false };
}

async function joinExistingMatch(tx, candidateId, userId, stakeAmount) {
  const [match] = await tx
    .select()
    .from(minesPvpMatches)
    .where(eq(minesPvpMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Lobby no longer available", status: 409 };
  }

  // Both boards are already fixed; joining only opens the ready banner.
  void stakeAmount;
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(minesPvpMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.READY,
      firstPlayerId: match.player1Id,
      currentTurnUserId: null,
      roundDeadline: readyDeadline,
      startedAt: new Date(),
    })
    .where(
      and(
        eq(minesPvpMatches.id, candidateId),
        eq(minesPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(minesPvpMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    return { error: "Lobby no longer available", status: 409 };
  }

  mirrorMinesQueued({
    matchId: updated.id,
    playerCount: 2,
    queuedAt: updated.createdAt ? new Date(updated.createdAt) : undefined,
    mode: `pvp:${Number(updated.minesCount)}`,
  });
  return { match: updated, joined: true };
}

// ── Cancel (creator only, while waiting) ──────────────────────────────
export async function cancelMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(minesPvpMatches)
      .where(eq(minesPvpMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 };
    if (match.status !== MATCH_STATUS.WAITING) {
      return { error: "Match cannot be cancelled after opponent joins", status: 400 };
    }
    if (match.player1Id !== userId) {
      return { error: "Only the creator can cancel", status: 403 };
    }

    const [updated] = await tx
      .update(minesPvpMatches)
      .set({ status: MATCH_STATUS.CANCELLED, endedAt: new Date() })
      .where(eq(minesPvpMatches.id, matchId))
      .returning();

    mirrorMinesTransition({
      matchId,
      status: "cancelled",
      cancelReason: "user_cancelled",
      playerCount: 1,
    });
    return { match: updated };
  });
}

// ── Resign from an active match ───────────────────────────────────────
export async function resignMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(minesPvpMatches)
      .where(eq(minesPvpMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) return { error: "Forbidden", status: 403 };
    if (TERMINAL_STATES.has(match.status)) {
      return { error: "Match already finished", status: 400 };
    }
    if (match.status === MATCH_STATUS.WAITING) {
      return { error: "Use cancel to leave a waiting match", status: 400 };
    }

    const updated = await resolveMatch(tx, match, {
      winnerId: otherSeatId(match, userId),
      reason: WIN_REASON.RESIGN,
    });
    return { match: updated, resigned: true };
  });
}

// ── Disconnect forfeit ────────────────────────────────────────────────
// Called by /api/mines-pvp/disconnect-forfeit when a participant's socket
// has stayed disconnected past the realtime-server grace window.
//
// Adaptations for SIMULTANEOUS play — a temporary blip must never:
//   • award a win,              → the realtime grace window is the only trigger
//   • freeze the opponent,      → nothing is frozen; the duel has no turns
//   • modify the score, or      → the forfeit never touches scoring columns
//   • modify the board.         → the boards are never read or written here
//
// Also ignored (no forfeit) when:
//   • the match is already terminal (idempotent),
//   • the disconnecting seat already COMPLETED/locked its board — a finisher
//     walking away must not be punished; the opponent plays to the timer,
//   • the match is a free vs-AI practice match,
//   • the match is still WAITING (no opponent) → cancel it instead.
export async function forfeitMatchOnDisconnect({ loserClerkId, matchId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, loserClerkId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (TERMINAL_STATES.has(match.status)) {
      return { match, forfeited: false, cancelled: false, ignored: true };
    }
    if (isFreeAiMatch(match)) {
      // Practice matches are never forfeited on a disconnect.
      return { match, forfeited: false, cancelled: false, ignored: true };
    }

    const seat = seatForUser(match, loserClerkId);

    // Waiting lobby with no opponent → cancel (the creator left).
    if (match.status === MATCH_STATUS.WAITING || !match.player2Id) {
      const [cancelled] = await tx
        .update(minesPvpMatches)
        .set({ status: MATCH_STATUS.CANCELLED, endedAt: new Date() })
        .where(eq(minesPvpMatches.id, match.id))
        .returning();
      mirrorMinesTransition({
        matchId: match.id,
        status: "cancelled",
        cancelReason: "disconnect",
        playerCount: 1,
      });
      return { match: cancelled || match, forfeited: false, cancelled: true };
    }

    // A player who already CLEARED their board keeps their result; the
    // opponent simply plays to the clock. No forfeit.
    if (isSeatLocked(match, seat)) {
      return { match, forfeited: false, cancelled: false, ignored: true };
    }

    const winnerId = otherSeatId(match, loserClerkId);
    const updated = await resolveMatch(tx, match, {
      winnerId,
      reason: WIN_REASON.DISCONNECT,
    });
    return { match: updated, forfeited: true, cancelled: false };
  });
}

async function fetchMatchForUpdate(tx, matchId) {
  const [match] = await tx
    .select()
    .from(minesPvpMatches)
    .where(eq(minesPvpMatches.id, matchId))
    .for("update");
  return match;
}

function otherSeatId(match, userId) {
  if (!match) return null;
  if (match.player1Id === userId) return match.player2Id ?? null;
  if (match.player2Id === userId) return match.player1Id ?? null;
  return null;
}

// ── Ready → active ────────────────────────────────────────────────────
// Opens the SINGLE 180-second match timer. Both players start from this
// one server timestamp.
async function advanceFromReady(tx, match) {
  const timerSeconds = Number(match.matchTimerSeconds) || MATCH_TIMER_SECONDS;
  // ONE shared start instant for both seats: `startedAt` marks when play
  // actually begins (after the ready banner) and `matchDeadline` is the
  // single server-authoritative 180s clock derived from the same `now`.
  const now = Date.now();
  const startedAt = new Date(now);
  const deadline = new Date(now + timerSeconds * 1000);
  await tx
    .update(minesPvpMatches)
    .set({
      status: MATCH_STATUS.ACTIVE,
      currentTurnUserId: null,
      roundDeadline: null,
      startedAt,
      matchDeadline: deadline,
    })
    .where(
      and(
        eq(minesPvpMatches.id, match.id),
        eq(minesPvpMatches.status, MATCH_STATUS.READY),
      ),
    );

  const [refreshed] = await tx
    .select()
    .from(minesPvpMatches)
    .where(eq(minesPvpMatches.id, match.id));
  return refreshed || match;
}

// ── Shared update helper ──────────────────────────────────────────────
// Conditional on the status we validated against, so a racing action can
// never double-apply. Returns the fresh row (or null on a lost race).
async function patchMatch(tx, matchId, status, patch) {
  const [updated] = await tx
    .update(minesPvpMatches)
    .set(patch)
    .where(
      and(
        eq(minesPvpMatches.id, matchId),
        eq(minesPvpMatches.status, status),
      ),
    )
    .returning();
  return updated || null;
}

// ── Reveal a tile (the main action) ───────────────────────────────────
// Server-authoritative. The caller may only name a cell on their OWN
// board; the server decides the outcome, the score change and whether the
// board just completed.
export async function pickTile({ userId, matchId, cellIndex }) {
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) {
    return {
      error: `cellIndex must be an integer in [0, ${GRID_CELLS - 1}]`,
      status: 400,
    };
  }

  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) return { error: "Forbidden", status: 403 };
    if (!PICKABLE_STATES.has(match.status)) {
      return { error: "Match is not active", status: 400 };
    }
    if (isMatchExpired(match)) {
      return { error: "Match timer has expired", status: 400 };
    }

    const seat = seatForUser(match, userId);
    if (isSeatLocked(match, seat)) {
      return { error: "Your board is already locked", status: 400 };
    }

    return await applyReveal(tx, match, { userId, seat, cellIndex: idx });
  });
}

// ── Flag a tile ───────────────────────────────────────────────────────
// Correct flag: award the mine's value (server-minted), confirm the mine
// and check completion. Wrong flag: −10, the wrong-flag state is kept
// until that tile is eventually revealed.
export async function flagTile({ userId, matchId, cellIndex }) {
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) {
    return {
      error: `cellIndex must be an integer in [0, ${GRID_CELLS - 1}]`,
      status: 400,
    };
  }

  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) return { error: "Forbidden", status: 403 };
    if (!PICKABLE_STATES.has(match.status)) {
      return { error: "Match is not active", status: 400 };
    }
    if (isMatchExpired(match)) {
      return { error: "Match timer has expired", status: 400 };
    }

    const seat = seatForUser(match, userId);
    if (isSeatLocked(match, seat)) {
      return { error: "Your board is already locked", status: 400 };
    }

    return await applyFlag(tx, match, { userId, seat, cellIndex: idx });
  });
}

// ── Unflag a tile ─────────────────────────────────────────────────────
// Removes a WRONG flag marker so a misclick can be corrected. A CONFIRMED
// mine (a correct flag, which already awarded its value and counts toward
// completion) can NOT be unflagged — that would let a player re-flag the same
// mine and farm its value. Unflagging does NOT refund the −10: the penalty is
// permanent, only the marker is cleared.
export async function unflagTile({ userId, matchId, cellIndex }) {
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) {
    return {
      error: `cellIndex must be an integer in [0, ${GRID_CELLS - 1}]`,
      status: 400,
    };
  }

  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) return { error: "Forbidden", status: 403 };
    if (!PICKABLE_STATES.has(match.status)) {
      return { error: "Match is not active", status: 400 };
    }
    if (isMatchExpired(match)) {
      return { error: "Match timer has expired", status: 400 };
    }

    const seat = seatForUser(match, userId);
    if (isSeatLocked(match, seat)) {
      return { error: "Your board is already locked", status: 400 };
    }

    const flags = flagsForSeat(match, seat);
    const correctFlags = correctFlagsForSeat(match, seat);
    if (!flags.includes(idx)) {
      return { error: "Cell is not flagged", status: 409 };
    }
    if (correctFlags.includes(idx)) {
      return { error: "Cannot unflag a confirmed mine", status: 409 };
    }

    const newFlags = flags.filter((c) => c !== idx);
    const patch = {
      [seat === "player2" ? "p2Flags" : "p1Flags"]: newFlags,
    };
    const updated = await patchMatch(tx, match.id, match.status, patch);
    if (!updated) {
      return { error: "Match state changed, please retry", status: 409 };
    }
    return {
      match: updated,
      justResolved: false,
      seat,
      unflagged: true,
      scoreDelta: 0,
    };
  });
}

function isMatchExpired(match) {
  return Boolean(
    match?.matchDeadline &&
      new Date(match.matchDeadline).getTime() <= Date.now(),
  );
}

// ── applyReveal (shared by a human reveal and the AI) ─────────────────
async function applyReveal(tx, match, { userId, seat, cellIndex }) {
  const board = seatRow(match, seat);
  const revealed = revealedForSeat(match, seat);
  const flags = flagsForSeat(match, seat);
  const correctFlags = correctFlagsForSeat(match, seat);

  if (revealed.includes(cellIndex)) {
    return { error: "Cell already revealed", status: 409 };
  }
  // A mine you have already CONFIRMED by flagging is known — revealing it
  // would only self-destruct, so the server refuses.
  if (correctFlags.includes(cellIndex)) {
    return { error: "Cell already confirmed as a mine", status: 409 };
  }

  const mine = isMine(board, cellIndex);
  const scoreBefore = scoreForSeat(match, seat);
  let score = scoreBefore;
  let safeRevealed = Number(seat === "player2" ? match.p2SafeRevealed : match.p1SafeRevealed) || 0;
  let minesHit = Number(seat === "player2" ? match.p2MinesHit : match.p1MinesHit) || 0;

  if (mine) {
    score = applyScoreDelta(score, SCORE.MINE_HIT);
    minesHit += 1;
  } else {
    score = applyScoreDelta(score, SCORE.SAFE_TILE);
    safeRevealed += 1;
  }

  const newRevealed = normalizeFlags([...revealed, cellIndex]);
  // Revealing a WRONG-flagged tile resolves it — the flag is cleared (the
  // `incorrectFlagCount` stat stays as a permanent record).
  const newFlags = flags.filter((c) => c !== cellIndex);

  const completion = completeIfDone({
    match,
    board,
    seat,
    revealed: newRevealed,
    correctFlags,
    score,
  });

  const patch = {
    [seat === "player2" ? "p2Revealed" : "p1Revealed"]: newRevealed,
    [seat === "player2" ? "p2Flags" : "p1Flags"]: newFlags,
    ...statsPatch(seat, {
      score: completion.score,
      safeRevealed,
      minesHit,
      completed: completion.completed,
      completedAt: completion.completedAt,
      locked: completion.locked,
    }),
  };

  const updated = await patchMatch(tx, match.id, match.status, patch);
  if (!updated) {
    return { error: "Match state changed, please retry", status: 409 };
  }

  const settled = await maybeResolve(tx, updated);
  return {
    match: settled,
    justResolved: settled.status === MATCH_STATUS.FINISHED,
    revealedMine: mine,
    completed: completion.completed,
    seat,
    // Exact server-minted score change for this action (a realtime hint; the
    // score itself is authoritative on the returned row).
    scoreDelta: completion.score - scoreBefore,
    scoreReason: completion.completed
      ? "complete"
      : mine
        ? "mine_hit"
        : "safe",
  };
}

// ── applyFlag (shared by a human flag and the AI) ─────────────────────
async function applyFlag(tx, match, { userId, seat, cellIndex }) {
  const board = seatRow(match, seat);
  const revealed = revealedForSeat(match, seat);
  const flags = flagsForSeat(match, seat);
  const correctFlags = correctFlagsForSeat(match, seat);

  if (revealed.includes(cellIndex)) {
    return { error: "Cell already revealed", status: 409 };
  }
  if (flags.includes(cellIndex)) {
    return { error: "Cell already flagged", status: 409 };
  }

  const mine = isMine(board, cellIndex);
  const scoreBefore = scoreForSeat(match, seat);
  let score = scoreBefore;
  let correctFlagCount = Number(seat === "player2" ? match.p2CorrectFlagCount : match.p1CorrectFlagCount) || 0;
  let incorrectFlagCount = Number(seat === "player2" ? match.p2IncorrectFlagCount : match.p1IncorrectFlagCount) || 0;
  let newCorrectFlags = correctFlags;
  let mineValue = null;

  if (mine) {
    // The mine's value is minted HERE from the server-only board. A client
    // can never name it.
    mineValue = mineValueAt(board, cellIndex);
    score = applyScoreDelta(score, mineValue ?? 0);
    correctFlagCount += 1;
    newCorrectFlags = normalizeFlags([...correctFlags, cellIndex]);
  } else {
    score = applyScoreDelta(score, SCORE.WRONG_FLAG);
    incorrectFlagCount += 1;
  }

  const newFlags = normalizeFlags([...flags, cellIndex]);

  const completion = completeIfDone({
    match,
    board,
    seat,
    revealed,
    correctFlags: newCorrectFlags,
    score,
  });

  const patch = {
    [seat === "player2" ? "p2Flags" : "p1Flags"]: newFlags,
    [seat === "player2" ? "p2CorrectFlags" : "p1CorrectFlags"]: newCorrectFlags,
    ...statsPatch(seat, {
      score: completion.score,
      correctFlagCount,
      incorrectFlagCount,
      completed: completion.completed,
      completedAt: completion.completedAt,
      locked: completion.locked,
    }),
  };

  const updated = await patchMatch(tx, match.id, match.status, patch);
  if (!updated) {
    return { error: "Match state changed, please retry", status: 409 };
  }

  const settled = await maybeResolve(tx, updated);
  return {
    match: settled,
    justResolved: settled.status === MATCH_STATUS.FINISHED,
    flagCorrect: mine,
    mineValue: mine ? mineValue : null,
    seat,
    scoreDelta: completion.score - scoreBefore,
    scoreReason: completion.completed
      ? "complete"
      : mine
        ? "correct_flag"
        : "wrong_flag",
  };
}

// Award the +100 completion bonus, mark complete + locked, if this action
// resolved the whole board. Pure-ish: returns the (possibly bumped) score
// and the completion patch fields.
function completeIfDone({ match, board, seat, revealed, correctFlags, score }) {
  const already = Boolean(seat === "player2" ? match.p2Completed : match.p1Completed);
  if (already) {
    return { score, completed: true, completedAt: match.p2CompletedAt ?? match.p1CompletedAt ?? null, locked: true };
  }
  if (!isBoardComplete(board, revealed, correctFlags)) {
    return { score, completed: false, completedAt: null, locked: false };
  }
  return {
    score: applyScoreDelta(score, SCORE.BOARD_COMPLETE),
    completed: true,
    completedAt: new Date(),
    locked: true,
  };
}

// ── Resolve when both boards are done, or the timer expires ───────────
async function maybeResolve(tx, match) {
  if (TERMINAL_STATES.has(match.status)) return match;
  const bothComplete = Boolean(match.p1Completed) && Boolean(match.p2Completed);
  const expired = isMatchExpired(match);
  if (!bothComplete && !expired) return match;
  return await resolveMatch(tx, match, { reason: WIN_REASON.SCORE });
}

// Snapshot one seat's complete final state for the persisted replay row.
// Server-only: reads the match row (+ its per-seat arrays), never a client.
function finalStateForSeat(match, seat) {
  const p = seat === "player2";
  return {
    score: Number(p ? match?.p2Score : match?.p1Score) || 0,
    safeRevealed:
      Number(p ? match?.p2SafeRevealed : match?.p1SafeRevealed) || 0,
    minesHit: Number(p ? match?.p2MinesHit : match?.p1MinesHit) || 0,
    correctFlagCount:
      Number(p ? match?.p2CorrectFlagCount : match?.p1CorrectFlagCount) || 0,
    incorrectFlagCount:
      Number(p ? match?.p2IncorrectFlagCount : match?.p1IncorrectFlagCount) ||
      0,
    completed: Boolean(p ? match?.p2Completed : match?.p1Completed),
    completedAt: (p ? match?.p2CompletedAt : match?.p1CompletedAt) ?? null,
    revealed: revealedForSeat(match, seat),
    flags: flagsForSeat(match, seat),
    correctFlags: correctFlagsForSeat(match, seat),
  };
}

// ── The single settle path ────────────────────────────────────────────
// `winnerId` is optional: a resignation names the opponent explicitly; a
// scored finish derives the winner from the tiebreak ladder.
async function resolveMatch(tx, match, { winnerId = null, reason } = {}) {
  if (!match) return match;
  if (TERMINAL_STATES.has(match.status)) return match;

  let result;
  if (winnerId) {
    if (winnerId === match.player1Id) result = RESULT.PLAYER1;
    else if (winnerId === match.player2Id) result = RESULT.PLAYER2;
    else return match; // defensive: a non-seat "winner" is a bug
  } else {
    result = resolveScoredMatch(match);
  }

  if (result === RESULT.DRAW) {
    winnerId = null;
  } else if (!winnerId) {
    winnerId = result === RESULT.PLAYER1 ? match.player1Id : match.player2Id;
  }

  const isAi = isFreeAiMatch(match);

  // Persist the replay snapshot first (both boards + final scores).
  await tx.insert(minesPvpRounds).values({
    matchId: match.id,
    roundNumber: 1,
    boardSnapshot: match.p1Board ?? match.board ?? { size: 10, mines: [], values: {} },
    p2BoardSnapshot: match.p2Board ?? { size: 10, mines: [], values: {} },
    p1Score: Number(match.p1Score) || 0,
    p2Score: Number(match.p2Score) || 0,
    // Full per-seat final state so the replay is self-contained (both
    // scores, both boards, mine values, revealed tiles, flags, mines hit
    // and completion times). See migration 0202.
    p1FinalState: finalStateForSeat(match, "player1"),
    p2FinalState: finalStateForSeat(match, "player2"),
    roundWinner: result,
    winReason: reason ?? null,
  });

  const [updated] = await tx
    .update(minesPvpMatches)
    .set({
      status: MATCH_STATUS.FINISHED,
      currentTurnUserId: null,
      roundDeadline: null,
      matchDeadline: null,
      result,
      winnerId,
      winReason: reason ?? null,
      houseFee: "0.00",
      prizePaid: "0.00",
      endedAt: new Date(),
    })
    .where(eq(minesPvpMatches.id, match.id))
    .returning();

  const finalRow = updated || match;
  mirrorMinesTransition({
    matchId: match.id,
    status: "completed",
    playerCount: [match.player1Id, match.player2Id].filter(Boolean).length,
  });

  // Best-effort stat side-effects (failures don't roll the match). Skipped
  // for AI matches and for draws.
  if (!isAi && winnerId) {
    await recordPvPResult(tx, finalRow, winnerId, result).catch(() => {});
  }

  return finalRow;
}

// Best-effort stat side-effect — mirrors the other PvP stores.
async function recordPvPResult(tx, match, winnerId, result) {
  const loserId =
    result === RESULT.PLAYER1 ? match.player2Id : match.player1Id;
  if (!winnerId || !loserId) return;

  await tx
    .update(users)
    .set({ gamesWon: sql`${users.gamesWon} + 1` })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({ gamesLost: sql`${users.gamesLost} + 1` })
    .where(eq(users.clerkId, loserId));

  applyLeaderboardCounters({
    clerkId: winnerId,
    game: "mines-pvp",
    outcome: "win",
    isPvpWin: true,
  }).catch(() => {});
  applyLeaderboardCounters({
    clerkId: loserId,
    game: "mines-pvp",
    outcome: "loss",
  }).catch(() => {});

  await applyRatingResult({
    tx,
    gameKey: "mines-pvp",
    matchId: String(match.id),
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
  await applyTrophyResult({
    tx,
    gameKey: "mines-pvp",
    matchId: String(match.id),
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}

// ── AI turn (server-driven) ───────────────────────────────────────────
// The bot plays on its OWN board through the SAME `applyReveal` /
// `applyFlag` pipeline a human uses. Idempotent: a no-op once the bot's
// board is locked or the match is over.
async function playAiTurnInTransaction(tx, match) {
  if (!PICKABLE_STATES.has(match.status)) return match;
  if (isMatchExpired(match)) return match;
  const seat = "player2";
  if (isSeatLocked(match, seat)) return match;
  if (match.player2Id !== MINES_AI_PLAYER_ID) return match;

  const board = seatRow(match, seat);
  const revealed = revealedForSeat(match, seat);
  const correctFlags = correctFlagsForSeat(match, seat);
  const flags = flagsForSeat(match, seat);
  const resolved = normalizeFlags([...revealed, ...correctFlags]);

  // Reconstruct the public clues the bot has actually seen (safe reveals
  // only) from its own board — this is exactly the information a human
  // seat holds, never the hidden layout.
  const revealedEntries = revealed
    .filter((cell) => !isMine(board, cell))
    .map((cell) => ({ cell, hint: nearestMineDistance(board, cell) }));

  const action = chooseAiActionForSeat({
    revealed: revealedEntries,
    flags,
    resolved,
    difficulty: match.aiDifficulty,
  });
  if (!action) return match;

  const applied =
    action.kind === ACTION_KIND.FLAG
      ? await applyFlag(tx, match, {
          userId: MINES_AI_PLAYER_ID,
          seat,
          cellIndex: action.cellIndex,
        })
      : await applyReveal(tx, match, {
          userId: MINES_AI_PLAYER_ID,
          seat,
          cellIndex: action.cellIndex,
        });

  return applied?.match ?? match;
}

// Public AI endpoint entry: let the authenticated human wake the bot.
export async function playAiTurn({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isFreeAiMatch(match) || match.player1Id !== userId) {
      return { error: "Forbidden", status: 403 };
    }
    if (TERMINAL_STATES.has(match.status)) {
      return { match, justResolved: false, alreadyPlayed: true };
    }
    if (match.status === MATCH_STATUS.WAITING || match.status === MATCH_STATUS.READY) {
      return { error: "Match has not started yet", status: 400 };
    }
    // Play up to a bounded burst so the bot keeps pace with a fast human.
    let current = match;
    for (let i = 0; i < 8; i += 1) {
      current = await playAiTurnInTransaction(tx, current);
      if (current.status !== MATCH_STATUS.ACTIVE) break;
    }
    return { match: current, justResolved: current.status === MATCH_STATUS.FINISHED, alreadyPlayed: false };
  });
}

// ── Status fetch with auto-advance + auto-resolve ─────────────────────
export async function fetchMatchWithAutoResolve(userId, matchId) {
  const result = await db.transaction(async (tx) => {
    let match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) return { error: "Forbidden", status: 403 };

    const before = phaseSignature(match);

    // 1) Ready banner elapsed → go live (opens the single 180s timer).
    if (
      match.status === MATCH_STATUS.READY &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      match = await advanceFromReady(tx, match);
    }

    // 2) Active match: settle on expiry, else let the bot play its board.
    if (match.status === MATCH_STATUS.ACTIVE) {
      if (isMatchExpired(match)) {
        match = await maybeResolve(tx, match);
      } else if (isFreeAiMatch(match)) {
        for (let i = 0; i < 12; i += 1) {
          match = await playAiTurnInTransaction(tx, match);
          if (match.status !== MATCH_STATUS.ACTIVE) break;
        }
      }
      match = await maybeResolve(tx, match);
    }

    return { match, advanced: phaseSignature(match) !== before };
  });

  if (result?.match) {
    return { ...result, match: scrubMatchForViewer(result.match) };
  }
  return result;
}

function phaseSignature(match) {
  if (!match) return "";
  return [
    match.status ?? "",
    Number(match.p1Score) || 0,
    Number(match.p2Score) || 0,
    Boolean(match.p1Completed),
    Boolean(match.p2Completed),
    match.matchDeadline ? new Date(match.matchDeadline).getTime() : "",
  ].join("|");
}

// ── Scrub / canonicalise server state before serialisation ────────────
// This does NOT decide per-viewer visibility (matchView.js does). It only
// canonicalises the arrays and stamps board-derived counters.
export function scrubMatchForViewer(match) {
  if (!match) return match;
  const isFinished = match.status === MATCH_STATUS.FINISHED;
  const boardFields = {
    p1Flags: flagsForSeat(match, "player1"),
    p2Flags: flagsForSeat(match, "player2"),
    p1Revealed: revealedForSeat(match, "player1"),
    p2Revealed: revealedForSeat(match, "player2"),
    p1CorrectFlagCells: correctFlagsForSeat(match, "player1"),
    p2CorrectFlagCells: correctFlagsForSeat(match, "player2"),
  };
  if (isFinished) {
    return { ...match, ...boardFields };
  }
  // Legacy single-board field is nulled while live (it mirrors seat 1).
  return { ...match, ...boardFields, board: null };
}

// ── Round history ─────────────────────────────────────────────────────
export async function fetchMatchRounds(matchId) {
  return db
    .select()
    .from(minesPvpRounds)
    .where(eq(minesPvpRounds.matchId, matchId))
    .orderBy(sql`${minesPvpRounds.roundNumber} ASC`);
}

export async function fetchMatch(matchId) {
  const [match] = await db
    .select()
    .from(minesPvpMatches)
    .where(eq(minesPvpMatches.id, matchId));
  return match || null;
}

// ── User enrichment (player names + icons) ────────────────────────────
export async function enrichMatchWithPlayers(match) {
  if (!match) return match;

  const clerkIds = [];
  if (match.player1Id && match.player1Id !== MINES_AI_PLAYER_ID) {
    clerkIds.push(match.player1Id);
  }
  if (match.player2Id && match.player2Id !== MINES_AI_PLAYER_ID) {
    clerkIds.push(match.player2Id);
  }

  const summary = {};
  if (clerkIds.length > 0) {
    try {
      const rows = await db
        .select({
          clerkId: users.clerkId,
          displayName: users.name,
          iconKey: users.selectedIcon,
          equippedCosmetics: users.equippedCosmetics,
          chatColor: users.chatColor,
          glowColor: glows.color,
          isPremium: sql`(${tokenSubscriptions.status} IS NOT NULL)`,
        })
        .from(users)
        .leftJoin(
          glows,
          and(eq(glows.key, users.selectedGlow), eq(glows.enabled, true)),
        )
        .leftJoin(
          tokenSubscriptions,
          and(
            eq(tokenSubscriptions.clerkId, users.clerkId),
            inArray(tokenSubscriptions.status, ACTIVE_SUBSCRIPTION_STATUSES),
          ),
        )
        .where(inArray(users.clerkId, clerkIds));
      const decorations = await getFrameDecorations(
        rows.map((r) => r.equippedCosmetics),
      );
      const decorationByClerkId = new Map(
        rows.map((r, index) => [r.clerkId, decorations[index]]),
      );
      for (const r of rows) {
        if (!r || !r.clerkId) continue;
        summary[r.clerkId] = {
          id: r.clerkId,
          displayName: r.displayName || r.clerkId,
          iconKey: r.iconKey || "default",
          profileFrame: decorationByClerkId.get(r.clerkId) || null,
          nameColor:
            r.glowColor || (Boolean(r.isPremium) ? r.chatColor || null : null),
        };
      }
    } catch (err) {
      console.warn(
        "[mines-pvp] enrichMatchWithPlayers: users lookup failed:",
        err && err.message ? err.message : err,
      );
    }
  }

  const seatSummary = (clerkId, fallbackName) => {
    if (!clerkId) return null;
    // A guest has no `users` row to enrich — hand back the guest seat so the
    // client draws the "G" badge instead of the default catalog icon.
    if (isGuestId(clerkId)) return guestSeatSummary(clerkId);
    return (
      summary[clerkId] || {
        id: clerkId,
        displayName: fallbackName || clerkId,
        iconKey: "default",
        profileFrame: null,
        nameColor: null,
        missing: true,
      }
    );
  };

  const aiPlayer = {
    id: MINES_AI_PLAYER_ID,
    displayName: "GRYND AI",
    iconKey: "default",
    profileFrame: null,
    nameColor: null,
  };

  return {
    ...match,
    players: {
      p1:
        match.player1Id === MINES_AI_PLAYER_ID
          ? aiPlayer
          : seatSummary(match.player1Id),
      p2:
        match.player2Id === MINES_AI_PLAYER_ID
          ? aiPlayer
          : seatSummary(match.player2Id),
    },
  };
}

// Re-exported so tests / route helpers can reason about the seat set.
export { SEATS, AI_PICK_DELAY_MS };
