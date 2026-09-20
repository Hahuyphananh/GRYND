// src/lib/memory-grid/serverStore.js
//
// Server-side canonical helpers for the Memory Grid match system.
//
// Why a dedicated serverStore (mirrors `src/lib/mines-pvp/
// serverStore.js` + `src/lib/plinko-pvp/serverStore.js`):
//   The match state machine has to be authoritative on the server:
//     * matchmaking lock (stake-keyed) prevents lobby-race duplicates
//     * server generates the round pattern (grid size + active tile
//       indices) deterministically from the match's server seed and
//       keeps it hidden until the round's memorize phase (revealed
//       to BOTH players simultaneously) or match finish
//     * SIMULTANEOUS play — no turns. Both players memorize and
//       reconstruct the same pattern at the same time; the round
//       resolves only once BOTH seats have submitted or been AFK
//       auto-locked (synchronized-commit pattern mirrored from
//       plinko-pvp's p1_ready/p2_ready flags)
//     * per-seat submission flags (`p1_submitted`/`p2_submitted`) so
//       a submitter freezes their grid and waits for the opponent
//     * reconstruct deadline auto-lock per seat (AFK → score 0)
//     * round resolution when both seats are in → next round (grid
//       grows 3×3 → 5×5, then a 6×6 TIEBREAK round when the 5 rounds
//       end on equal TOTAL cumulative scores) or match resolution
//     * end-state resolution on total cumulative round scores
//       (higher total wins; equal totals → round 6 tiebreak is
//       dealt, and a round-6 tie is a DRAW refunding 95% per player
//       — 5% rake per side)
//     * 90/10 payout split (winner gets 1.9× stake, house keeps 0.1×)
//     * tile pattern hidden from clients except during the memorize
//       phase (and the post-match reveal)
//   Centralising this in a tiny module keeps the API routes thin
//   and makes the state machine testable in isolation.
//
// State machine (both players are always in the same phase):
//   waiting → ready → active { memorize → reconstruct → result }
//   (round 1..5; a round resolves once both seats submit, the round
//   snapshot is shown for RESULT_WINDOW_MS, then the next round opens,
//   or the round-6 tiebreak is dealt on equal totals, or the match
//   finishes) → finished
//   (waiting/ready/active → cancelled)

import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { applyPrestigeResult } from "../prestige";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { getProfileFramesByKeys, pickProfileFrameKey } from "../cosmetics";
import {
  memoryGridMatches,
  memoryGridRounds,
  users,
} from "../../db/schema";
import { sendSystemNotificationEmail } from "../emails/system";
import {
  derivePatternSeed,
  getServerSeedHash,
  randomHex,
} from "./seeds";
import {
  ACTIVE_STATES,
  MATCH_STATUS,
  MAX_STAKE,
  MEMORY_GRID_AI_PLAYER_ID,
  MEMORY_GRID_LOCK_NAMESPACE,
  MIN_STAKE,
  OVERTIME_DRAW_FEE_PCT,
  PHASES,
  RECONSTRUCT_DEADLINE_MS,
  RESULT,
  RESULT_WINDOW_MS,
  ROUNDS_PER_MATCH,
  READY_WINDOW_MS,
  SUBMIT_STATES,
  TIEBREAK_ROUND_NUMBER,
  assessReconstruction,
  aiSubmissionDelayMs,
  chooseAiReconstruction,
  computeFinalRoundScore,
  computePayout,
  generatePattern,
  isFreeAiMatch,
  matchWinnerFromTotals,
  reconstructDeadlineFromStart,
  reconstructionStarted,
  roundConfig,
  roundWinnerFromScores,
  speedMultiplierFromCompletion,
} from "./constants";

// ── Helpers ───────────────────────────────────────────────────────────

// Per-row pacing helper: derive the reconstruct-window duration in ms
// from a match row, falling back to the server-side default if the
// column is null/0. Lets admin tooling override per-match pacing via
// `round_timer_seconds` without code changes (mirrors mines-pvp /
// roulette-pvp `roundDeadlineMs`).
function reconstructWindowMs(match) {
  const t = Number(match?.roundTimerSeconds);
  if (Number.isFinite(t) && t > 0) return t * 1000;
  return RECONSTRUCT_DEADLINE_MS;
}

// Reconstruct-window elapsed time at submission (ms) — the "completion
// time" the server records for each reconstruction. The phase's start
// is recovered from the row: roundDeadline is always set to
// (reconstructStart + window) when the reconstruct phase opens, so
// reconstructStart = roundDeadline - window. Clamped at 0 (a
// submission can legitimately arrive at the exact phase start).
function completionTimeMsFor(match) {
  const deadline = match?.roundDeadline
    ? new Date(match.roundDeadline).getTime()
    : null;
  if (deadline === null || !Number.isFinite(deadline)) return 0;
  return Math.max(0, Date.now() - (deadline - reconstructWindowMs(match)));
}

// Stable deterministic hash from numeric stake to a signed 32-bit int.
// Used purely as the second key of the two-key pg_advisory_xact_lock
// for stake-keyed matchmaking (mirrors mines-pvp `hashStakeToInt`).
function hashStakeToInt(stake) {
  const fixed = Number(stake).toFixed(2);
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < fixed.length; i += 1) {
    h ^= fixed.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV-1a 32-bit prime
  }
  return (h | 0) & 0x7fffffff;
}

// Seat label ("player1" | "player2") for a user in a given match row.
// Returns null if the user is not a participant.
export function seatForUser(match, userId) {
  if (!match || !userId) return null;
  if (match.player1Id === userId) return "player1";
  if (match.player2Id === userId) return "player2";
  return null;
}

export function    isParticipant(match, userId) {
  return seatForUser(match, userId) !== null;
}

// The OTHER seat (player1 ↔ player2).
function otherSeat(seat) {
  return seat === "player1" ? "player2" : "player1";
}

// Validate the stake at lobby creation time. Returns
// `{ ok: true }` on success, `{ ok: false, error }` otherwise.
export function validateMatchParams({ stakeAmount }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
    return {
      ok: false,
      error: `Stake must be a number in [${MIN_STAKE}, ${MAX_STAKE}]`,
    };
  }
  return { ok: true };
}

// ── Lobby helpers ─────────────────────────────────────────────────────

// Open (waiting) matches for the casino lobby listing. Most recent
// first; `player2Id IS NULL` is the canonical "open" predicate.
export async function listOpenMatches({ limit = 30 } = {}) {
  return db
    .select({
      id: memoryGridMatches.id,
      player1Id: memoryGridMatches.player1Id,
      stakeAmount: memoryGridMatches.stakeAmount,
      createdAt: memoryGridMatches.createdAt,
    })
    .from(memoryGridMatches)
    .where(
      and(
        eq(memoryGridMatches.status, "waiting"),
        isNull(memoryGridMatches.player2Id),
      ),
    )
    .orderBy(sql`${memoryGridMatches.createdAt} DESC`)
    .limit(limit);
}

// ── Create a free human-vs-AI match ───────────────────────────────────
//
// The bot occupies player2. No stake is escrowed and the normal Memory
// Grid phase/scoring flow is reused; the server submits the bot's
// reconstruction once its calibrated delay has elapsed.
export async function createAiMatch({ userId }) {
  if (!userId) return { error: "Unauthorized", status: 401 };

  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  return await db.transaction(async (tx) => {
    const [match] = await tx
      .insert(memoryGridMatches)
      .values({
        player1Id: userId,
        player2Id: MEMORY_GRID_AI_PLAYER_ID,
        stakeAmount: "0.00",
        status: MATCH_STATUS.READY,
        isAi: true,
        serverSeed,
        serverSeedHash,
        phase: null,
        roundTimerSeconds: 15,
        roundNumber: 1,
        roundDeadline: readyDeadline,
        startedAt: new Date(),
      })
      .returning();

    // The serial match id is part of the provably-fair pattern seed, so
    // the first board is filled immediately after the insert.
    const [withBoard] = await tx
      .update(memoryGridMatches)
      .set({
        board: generatePattern(1, {
          seed: derivePatternSeed({
            serverSeed,
            matchId: match.id,
            roundNumber: 1,
          }),
        }),
      })
      .where(eq(memoryGridMatches.id, match.id))
      .returning();

    return { match: withBoard || match, joined: true };
  });
}

// Run one server-authoritative AI reconstruction when it is due. This
// helper is used both by the polling path and the explicit recovery
// endpoint, and always writes through applySubmission so scoring,
// locking, round snapshots, and resolution stay identical to PvP.
async function playAiTurnInTransaction(tx, match) {
  if (!match || !isFreeAiMatch(match)) {
    return { match, alreadyPlayed: true };
  }
  if (match.player2Id !== MEMORY_GRID_AI_PLAYER_ID) {
    return { match, alreadyPlayed: true };
  }
  if (match.status !== MATCH_STATUS.ACTIVE || match.phase !== PHASES.RECONSTRUCT) {
    return { match, alreadyPlayed: true };
  }
  if (match.p2Submitted) {
    return { match, alreadyPlayed: true };
  }

  const deadline = match.roundDeadline
    ? new Date(match.roundDeadline).getTime()
    : Number.NaN;
  const windowMs = reconstructWindowMs(match);
  const reconstructStartedAt = deadline - windowMs;
  const delay = aiSubmissionDelayMs({
    matchId: match.id,
    roundNumber: match.roundNumber,
  });
  if (!Number.isFinite(reconstructStartedAt) || Date.now() < reconstructStartedAt + delay) {
    return { match, alreadyPlayed: false, waiting: true };
  }

  const picks = chooseAiReconstruction({
    pattern: match.board,
    roundNumber: match.roundNumber,
    seed: `${match.id}:${match.serverSeed}`,
  });
  const outcome = await applySubmission(
    tx,
    match,
    "player2",
    picks,
    false,
    MEMORY_GRID_AI_PLAYER_ID,
  );
  return {
    ...outcome,
    alreadyPlayed: false,
    aiPicks: picks,
  };
}

// Explicit, authenticated recovery endpoint for the client. Normal
// progress also happens from fetchMatchWithAutoResolve polling, so a
// failed trigger cannot leave an AI match stuck.
export async function playAiTurn({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isFreeAiMatch(match) || match.player1Id !== userId) {
      return { error: "Forbidden", status: 403 };
    }
    return await playAiTurnInTransaction(tx, match);
  });
}

// ── Create / Join matchmaking ─────────────────────────────────────────
//
// Single-transaction stake-keyed matchmaking (mirrors mines-pvp):
//
//   1. Postgres `pg_advisory_xact_lock` keyed on
//      (MEMORY_GRID_LOCK_NAMESPACE, hash(stake)) serialises every
//      concurrent matchmaker for the same stake across all workers.
//   2. `FOR UPDATE` + re-fetch + conditional UPDATE filtering on
//      `status='waiting' AND player2_id IS NULL` catches the
//      "creator cancelled in parallel" race.
export async function createOrJoin({ userId, stakeAmount }) {
  const validation = validateMatchParams({ stakeAmount });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }

  const lockKey = hashStakeToInt(stakeAmount);

  return await db.transaction(async (tx) => {
    // Acquire stake-keyed advisory lock; auto-released on commit/rollback.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${MEMORY_GRID_LOCK_NAMESPACE}, ${lockKey})`,
    );

    // 1) Look for an existing open match with matching stake.
    const [openMatch] = await tx
      .select()
      .from(memoryGridMatches)
      .where(
        and(
          eq(memoryGridMatches.status, "waiting"),
          isNull(memoryGridMatches.player2Id),
          eq(memoryGridMatches.stakeAmount, Number(stakeAmount).toFixed(2)),
        ),
      )
      .orderBy(sql`${memoryGridMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (openMatch) {
      if (openMatch.player1Id === userId) {
        // Caller's own existing lobby — just return it.
        return { match: openMatch, joined: false };
      }
      return await joinExistingMatch(tx, openMatch.id, userId, stakeAmount);
    }

    // 2) No open match — create a fresh waiting match.
    return await createWaitingMatch(tx, userId, stakeAmount);
  });
}

async function createWaitingMatch(tx, userId, stakeAmount) {
  // Deduct creator stake (atomic: only if balance is sufficient).
  const [creator] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${stakeAmount}` })
    .where(
      and(
        eq(users.clerkId, userId),
        sql`${users.balance} >= ${stakeAmount}`,
      ),
    )
    .returning({ balance: users.balance });

  if (!creator) {
    return { error: "Insufficient balance", status: 400 };
  }

  // Shared SERVER seed for every round's pattern (revealed post-match)
  // + its committed SHA-256 hash (shown pre-match) — mirrors
  // lane-rush-duel's provably-fair seed system. The match id becomes
  // the nonce once the row exists, so round 1's pattern is derived
  // AFTER insert (see below). Both players play the same deterministic
  // pattern; the client never supplies or generates it.
  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);

  const [match] = await tx
    .insert(memoryGridMatches)
    .values({
      player1Id: userId,
      stakeAmount: Number(stakeAmount).toFixed(2),
      status: "waiting",
      serverSeed,
      serverSeedHash,
      phase: null,
      roundTimerSeconds: 15,
      roundNumber: 1,
      startedAt: null,
    })
    .returning();

  // Derive round 1's pattern deterministically from the server seed +
  // match id nonce, locked in before any joiner arrives. Server-only:
  // /status reveals `active` to both players during the memorize phase.
  const round1Seed = derivePatternSeed({
    serverSeed,
    matchId: match.id,
    roundNumber: 1,
  });
  const [withBoard] = await tx
    .update(memoryGridMatches)
    .set({ board: generatePattern(1, { seed: round1Seed }) })
    .where(eq(memoryGridMatches.id, match.id))
    .returning();

  // Fire system notification for large PvP create stakes.
  if (Number(stakeAmount) >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `User ${userId} created memory grid PvP lobby (${stakeAmount} stake).`,
      metadata: { userId, stakeAmount, matchId: match.id },
    }).catch(() => {});
  }

  return { match: withBoard || match, joined: false };
}

async function joinExistingMatch(tx, candidateId, userId, stakeAmount) {
  // Re-fetch the candidate row INSIDE the same transaction with
  // FOR UPDATE so a parallel /cancel that committed first can't leave
  // us updating a row that's already cancelled.
  const [match] = await tx
    .select()
    .from(memoryGridMatches)
    .where(eq(memoryGridMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== "waiting" || match.player2Id) {
    return { error: "Lobby no longer available", status: 409 };
  }

  // Deduct joiner's stake (atomic: only if balance is sufficient).
  const [joiner] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${stakeAmount}` })
    .where(
      and(
        eq(users.clerkId, userId),
        sql`${users.balance} >= ${stakeAmount}`,
      ),
    )
    .returning({ balance: users.balance });

  if (!joiner) {
    return { error: "Insufficient balance", status: 400 };
  }

  // Brief 3-second "Ready" window so both players can read the
  // match-found banner before round 1's memorize phase opens. /status
  // auto-advances to the memorize phase once the deadline passes
  // (see advanceFromReady).
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(memoryGridMatches)
    .set({
      player2Id: userId,
      status: "ready",
      phase: null,
      roundDeadline: readyDeadline,
      startedAt: new Date(),
    })
    .where(
      and(
        eq(memoryGridMatches.id, candidateId),
        // Defensive guard: only update if status is still `waiting`
        // and player2Id is still null when we commit.
        eq(memoryGridMatches.status, "waiting"),
        isNull(memoryGridMatches.player2Id),
      ),
    )
    .returning();

  // If our conditional UPDATE didn't match any rows (because another
  // concurrent joiner raced us), refund joiner stake.
  if (!updated) {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${stakeAmount}` })
      .where(eq(users.clerkId, userId));
    return { error: "Lobby no longer available", status: 409 };
  }

  return { match: updated, joined: true };
}

// ── Forfeit on confirmed disconnect ────────────────────────────────────
// Called by the internal /api/memory-grid/disconnect-forfeit route when
// the realtime server confirms a player has been disconnected past the
// grace window (tab closed, long network drop). Mirrors the keno-pvp /
// plinko-pvp forfeit pattern exactly:
//   • WAITING (no opponent yet) → cancel + refund the creator's stake.
//   • READY / ACTIVE (opponent present) → the OPPONENT wins outright
//     with the standard 1.9× payout (winner gets their stake back +
//     90% of the forfeiter's stake, house keeps 10%) — the same money
//     math as a natural resolveMatch.
//   • Terminal (finished/cancelled) → idempotent no-op (no double
//     payout).
// Idempotent and race-safe: the FOR UPDATE row lock + conditional
// status guard make a stale/second timer a no-op. This is the safety
// net that guarantees a disconnected player can never leave a match
// stuck indefinitely — the reconstruct deadline's AFK auto-lock
// resolves the round while players are still present, and this
// resolves the whole match when one of them is genuinely gone.
export async function forfeitMatch({ loserClerkId, matchId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };

    // No opponent yet — cancel + refund the creator (the only
    // participant in WAITING is player1, i.e. the disconnected player).
    if (match.status === MATCH_STATUS.WAITING) {
      if (match.player1Id !== loserClerkId) {
        return { error: "Only the creator can cancel", status: 403 };
      }
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${Number(match.stakeAmount)}` })
        .where(eq(users.clerkId, loserClerkId));
      const [updated] = await tx
        .update(memoryGridMatches)
        .set({ status: MATCH_STATUS.CANCELLED, endedAt: new Date() })
        .where(eq(memoryGridMatches.id, matchId))
        .returning();
      return { match: updated || match, cancelled: true };
    }

    // Already finished / cancelled — nothing to do (idempotent).
    if (!ACTIVE_STATES.has(match.status)) {
      return { match, alreadyTerminal: true };
    }
    if (match.player1Id !== loserClerkId && match.player2Id !== loserClerkId) {
      return { error: "Caller is not a participant", status: 403 };
    }

    const loserIsP1 = match.player1Id === loserClerkId;
    const winnerUserId = loserIsP1 ? match.player2Id : match.player1Id;
    const result = loserIsP1 ? RESULT.PLAYER2 : RESULT.PLAYER1;
    const isAi = isFreeAiMatch(match);
    const payout = isAi
      ? { winnerNet: 0, houseFee: 0, prizePaid: 0 }
      : computePayout({
          stakeAmount: match.stakeAmount,
          result,
        });

    // Credit the winner only for paid PvP. The AI seat is not a user
    // account and free matches never alter token balances.
    if (!isAi) {
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
        .where(eq(users.clerkId, winnerUserId));
    }

    const [updated] = await tx
      .update(memoryGridMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        phase: null,
        roundDeadline: null,
        result,
        winnerId: winnerUserId,
        houseFee: payout.houseFee.toFixed(2),
        prizePaid: payout.prizePaid.toFixed(2),
        endedAt: new Date(),
      })
      .where(
        and(
          eq(memoryGridMatches.id, matchId),
          // Conditional guard — a concurrent natural resolution already
          // finished/cancelled the match, skip (no double payout).
          sql`${memoryGridMatches.status} NOT IN ('finished', 'cancelled')`,
        ),
      )
      .returning();

    const finalRow = updated || match;

    // Best-effort stat side-effect (failures don't roll the match),
    // mirroring resolveMatch / keno-pvp forfeit.
    if (updated && winnerUserId && !isAi) {
      await recordPvPResult(tx, finalRow, winnerUserId, result).catch(() => {});
    }

    return { match: finalRow, forfeited: true };
  });
}

// ── Cancel (creator only, while in waiting) ───────────────────────────

export async function cancelMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(memoryGridMatches)
      .where(eq(memoryGridMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 };
    if (match.status !== "waiting") {
      return {
        error: "Match cannot be cancelled after opponent joins",
        status: 400,
      };
    }
    if (match.player1Id !== userId) {
      return { error: "Only the creator can cancel", status: 403 };
    }

    // Refund creator stake.
    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
      })
      .where(eq(users.clerkId, userId));

    const [updated] = await tx
      .update(memoryGridMatches)
      .set({
        status: "cancelled",
        endedAt: new Date(),
      })
      .where(eq(memoryGridMatches.id, matchId))
      .returning();

    return { match: updated };
  });
}

// ── Match fetch with row lock (for atomic operations) ─────────────────

async function fetchMatchForUpdate(tx, matchId) {
  const [match] = await tx
    .select()
    .from(memoryGridMatches)
    .where(eq(memoryGridMatches.id, matchId))
    .for("update");
  return match;
}

// ── Phase helpers ─────────────────────────────────────────────────────

// The tile count for the current round's grid (size²). The server
// validates reconstructions against the CURRENT round's pattern;
// indices are row-major (tile 0 = top-left).
function tileCountFor(pattern) {
  const size = Number(pattern?.size);
  if (Number.isInteger(size) && size > 0) return size * size;
  return 0;
}

// Open a round's memorize phase: both players study the SAME pattern
// simultaneously for the round's memorize duration. Sets status to
// 'active' (or keeps it), phase='memorize', and the memorize deadline
// = now + the round's memorize duration.
async function openMemorize(tx, match, roundNumber) {
  const cfg = roundConfig(roundNumber);
  const memorizeDeadline = new Date(Date.now() + cfg.memorizeMs);

  const [updated] = await tx
    .update(memoryGridMatches)
    .set({
      status: "active",
      phase: PHASES.MEMORIZE,
      roundDeadline: memorizeDeadline,
    })
    .where(
      and(
        eq(memoryGridMatches.id, match.id),
        // Only advance from a non-terminal state (guards against a
        // stale concurrent cancel).
        sql`${memoryGridMatches.status} NOT IN ('finished', 'cancelled')`,
      ),
    )
    .returning();

  return updated || match;
}

// Advance from the ready banner to round 1's memorize phase.
async function advanceFromReady(tx, match) {
  return await openMemorize(tx, match, 1);
}

// ── Auto-advance on poll ──────────────────────────────────────────────
//
// The client polling is the single source of forward progress
// (mirrors the AFK nudge pattern from plinko-pvp / mines-pvp):
//
//   1. `ready` deadline elapsed → open round 1's memorize phase.
//   2. phase='memorize' deadline elapsed → the pattern hides for BOTH
//      players; reconstruct opens (fresh shared deadline).
//   3. phase='reconstruct' deadline elapsed → AFK auto-lock: every
//      seat that hasn't submitted gets locked with score 0. If that
//      completes both seats, the round resolves into the result
//      phase (round snapshot shown to both).
//   4. phase='result' deadline elapsed → the round-result window is
//      over: the next round's memorize phase opens (or the match
//      resolves to `finished` after round 5).
async function advancePhaseOnPoll(tx, match) {
  if (match.status !== "active") {
    return match;
  }
  const deadline =
    match.roundDeadline && new Date(match.roundDeadline).getTime();
  const expired = deadline !== null && deadline <= Date.now();

  if (!expired) return match;

  if (match.phase === PHASES.MEMORIZE) {
    // Pattern window over → both players reconstruct. The OFFICIAL
    // reconstruct start is the memorize deadline (the authoritative
    // pattern-hide instant), NOT the moment this poll discovers the
    // transition — the window is anchored to the same absolute
    // timestamp for both players regardless of poll timing, so a
    // slow poll can never lengthen or shorten anyone's window.
    const memorizeDeadline = new Date(match.roundDeadline).getTime();
    const [updated] = await tx
      .update(memoryGridMatches)
      .set({
        phase: PHASES.RECONSTRUCT,
        roundDeadline: reconstructDeadlineFromStart(
          memorizeDeadline,
          reconstructWindowMs(match),
        ),
      })
      .where(
        and(
          eq(memoryGridMatches.id, match.id),
          eq(memoryGridMatches.status, "active"),
          eq(memoryGridMatches.phase, PHASES.MEMORIZE),
        ),
      )
      .returning();
    return updated || match;
  }

  if (match.phase === PHASES.RECONSTRUCT) {
    // AFK: lock every seat that hasn't submitted (score 0). Each lock
    // is a conditional UPDATE so two concurrent polls can't double-
    // lock; the round resolves as soon as both seats are in.
    let current = match;
    for (const seat of ["player1", "player2"]) {
      const submitted = seat === "player1"
        ? Boolean(match.p1Submitted)
        : Boolean(match.p2Submitted);
      if (submitted) continue;
      const outcome = await applySubmission(tx, current, seat, [], true, null);
      current = outcome.match;
      // If the round just resolved, the row already moved to the next
      // round / finished — nothing left to lock.
      if (outcome.justResolved || current.status !== "active" ||
          current.phase !== PHASES.RECONSTRUCT) {
        break;
      }
    }
    return current;
  }

  if (match.phase === PHASES.RESULT) {
    // Round-result window over → deal the next round's memorize
    // phase, or resolve the MATCH after the final round. The result
    // deadline is the authoritative window end; a poll that discovers
    // it late never extends the display for one player.
    const [updated] = await tx
      .update(memoryGridMatches)
      .set({ phase: null, roundDeadline: null })
      .where(
        and(
          eq(memoryGridMatches.id, match.id),
          eq(memoryGridMatches.status, "active"),
          eq(memoryGridMatches.phase, PHASES.RESULT),
        ),
      )
      .returning();
    const current = updated || match;

    if (Number(current.roundNumber) >= ROUNDS_PER_MATCH) {
      const currentRound = Number(current.roundNumber || 1);
      const p1Total = Number(current.p1Total || 0);
      const p2Total = Number(current.p2Total || 0);
      // Equal TOTAL cumulative scores after the 5 regular rounds →
      // deal the harder TIEBREAK round (round 6) instead of
      // finishing — whoever scores higher on it takes the match.
      // (Guarded on currentRound < TIEBREAK_ROUND_NUMBER so a
      // tiebreak round that ALSO ties resolves as a draw below
      // instead of re-dealing round 6 forever.)
      if (currentRound < TIEBREAK_ROUND_NUMBER && p1Total === p2Total) {
        const next = await dealNextRound(tx, current, TIEBREAK_ROUND_NUMBER);
        return await openMemorize(tx, next, TIEBREAK_ROUND_NUMBER);
      }
      // Non-tied totals (or a tied TIEBREAK round) → resolve the
      // match on the cumulative scores (the finished screen replaces
      // the round result).
      const resolved = await resolveMatch(tx, current);
      return resolved;
    }

    // Non-final round → deal the next round and open its memorize
    // phase for both players.
    const nextRound = Number(current.roundNumber || 1) + 1;
    const next = await dealNextRound(tx, current, nextRound);
    return await openMemorize(tx, next, nextRound);
  }

  return match;
}

// Deal a fresh round: generate the round's server-authoritative
// pattern deterministically from the match seed + round number,
// reset the per-round state (submissions, round scores, flips) and
// stamp the new round number on the row. Used for both the regular
// round progression AND the round-6 tiebreak (the tiebreak pattern
// derives from the same provably-fair seed derivation, so it is
// equally verifiable post-match). Returns the refreshed row.
async function dealNextRound(tx, match, nextRound) {
  await tx
    .update(memoryGridMatches)
    .set({
      board: generatePattern(nextRound, {
        seed: derivePatternSeed({
          serverSeed: match.serverSeed,
          matchId: match.id,
          roundNumber: nextRound,
        }),
      }),
      flips: [],
      p1RoundScore: 0,
      p2RoundScore: 0,
      p1Submitted: false,
      p2Submitted: false,
      roundNumber: nextRound,
    })
    .where(
      and(
        eq(memoryGridMatches.id, match.id),
        eq(memoryGridMatches.status, "active"),
      ),
    );
  const [refreshed] = await tx
    .select()
    .from(memoryGridMatches)
    .where(eq(memoryGridMatches.id, match.id));
  return refreshed || match;
}

// ── Apply a (validated) reconstruction submission for a seat ──────────
//
// Shared by `submitReconstruction` (user-supplied picks) and
// `advancePhaseOnPoll` (AFK empty picks). Records the submission in
// `flips`, stamps the seat's round score + submitted flag, and — once
// BOTH seats are in — resolves the round (completeRound deals the
// next round or finishes the match). A single seat's submission keeps
// the phase at 'reconstruct' so the other player can keep going.
//
// Returns `{ match, justResolved }` — `justResolved` is true only
// when the whole MATCH finished.
async function applySubmission(
  tx,
  match,
  seat,
  picks,
  autoLocked,
  userId = null,
) {
  // Authoritative full-grid assessment — the server compares the
  // player's ENTIRE reconstruction against the pattern (false
  // positives and misses both count as errors; see
  // assessReconstruction). The client never supplies accuracy or
  // score. completionTimeMs = reconstruct-window elapsed time at
  // submission (0 for an instant lock, the full window for AFK).
  const assessment = assessReconstruction(picks, match.board);
  const completionTimeMs = completionTimeMsFor(match);
  const windowMs = reconstructWindowMs(match);
  const { tier: speedTier, multiplier: speedMultiplier } =
    speedMultiplierFromCompletion(completionTimeMs, windowMs);
  // Final round score is the exact full-grid accuracy percentage,
  // clamped to [0, 100]. An empty reconstruction (AFK) scores 0 via
  // the pickedCount guard; speed is recorded but does not change points.
  const finalScore = computeFinalRoundScore({
    accuracy: assessment.accuracy,
    pickedCount: picks.length,
  });

  const entry = {
    kind: "reconstruct",
    userId,
    seat,
    picks,
    score: finalScore,
    total: assessment.total,
    correct: assessment.correct,
    incorrect: assessment.incorrect,
    accuracy: assessment.accuracy,
    accuracyPct: assessment.accuracyPct,
    completionTimeMs,
    speedTier,
    speedMultiplier,
    autoLocked: Boolean(autoLocked),
    submittedAt: new Date().toISOString(),
  };
  const allSubmissions = Array.isArray(match.flips)
    ? [...match.flips, entry]
    : [entry];

  const setValues = {
    flips: allSubmissions,
    p1RoundScore: seat === "player1" ? finalScore : match.p1RoundScore,
    p2RoundScore: seat === "player2" ? finalScore : match.p2RoundScore,
  };
  if (seat === "player1") {
    setValues.p1Submitted = true;
  } else {
    setValues.p2Submitted = true;
  }

  const [updated] = await tx
    .update(memoryGridMatches)
    .set(setValues)
    .where(
      and(
        eq(memoryGridMatches.id, match.id),
        eq(memoryGridMatches.status, "active"),
        eq(memoryGridMatches.phase, PHASES.RECONSTRUCT),
        // One submission per seat per round (mirrors plinko-pvp's
        // ready-flag guard).
        seat === "player1"
          ? eq(memoryGridMatches.p1Submitted, false)
          : eq(memoryGridMatches.p2Submitted, false),
      ),
    )
    .returning();

  if (!updated) {
    // Lost a race (already submitted / phase moved on) — return the
    // fresh row so the caller can reconcile. `raced` lets the submit
    // path reject a second submission (double-tap / parallel POSTs)
    // instead of silently accepting it.
    const [refreshed] = await tx
      .select()
      .from(memoryGridMatches)
      .where(eq(memoryGridMatches.id, match.id));
    return { match: refreshed || match, justResolved: false, raced: true };
  }

  // Both seats submitted (or AFK-locked) → resolve the round.
  const bothIn = Boolean(updated.p1Submitted && updated.p2Submitted);
  if (bothIn) {
    const completed = await completeRound(tx, updated);
    return { ...completed, raced: false };
  }

  // One seat in — keep waiting for the opponent.
  return { match: updated, justResolved: false, raced: false };
}

// ── submitReconstruction (the main action) ────────────────────────────
//
// Server-side authoritative action. Both players reconstruct
// SIMULTANEOUSLY — there is no turn order. A player can submit as
// soon as they finish; once submitted, their seat is locked (a second
// submission is rejected) and the round waits for the opponent.
// Server-authoritative timing (see reconstructionStarted): a
// submission is REJECTED before the official reconstruct start (the
// memorize pattern-hide deadline) — you can't lock a reconstruction
// while the pattern is still being revealed. If it arrives after the
// deadline but the server still shows 'memorize' (poll gap), the
// server advances memorize → reconstruct anchored on the memorize
// deadline and accepts, so the window and the recorded completion
// time are identical for both players. Late submissions (after the
// reconstruct deadline) are also accepted: the deadline only drives
// the AFK auto-lock, and a late submit gets the slowest speed tier.
export async function submitReconstruction({ userId, matchId, picks }) {
  // Defense-in-depth input validation (the API route also validates).
  if (!Array.isArray(picks)) {
    return { error: "picks must be an array of tile indices", status: 400 };
  }
  const seen = new Set();
  for (const p of picks) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || seen.has(n)) {
      return {
        error: "picks must be distinct non-negative tile indices",
        status: 400,
      };
    }
    seen.add(n);
  }

  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);

    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (!SUBMIT_STATES.has(match.status)) {
      return { error: "Match is not awaiting a reconstruction", status: 400 };
    }

    const seat = seatForUser(match, userId);
    const alreadySubmitted = seat === "player1"
      ? Boolean(match.p1Submitted)
      : Boolean(match.p2Submitted);
    if (alreadySubmitted) {
      return { error: "You already submitted this round", status: 409 };
    }

    // Pick limits: at most the grid's total tile count (a player may
    // select ANY number of tiles — even the whole grid; over-selection
    // is penalised by the full-grid scoring, see assessReconstruction),
    // and every index must be within the current grid.
    const total = tileCountFor(match.board);
    if (picks.length > total) {
      return {
        error: `You can pick at most ${total} tiles this round`,
        status: 400,
      };
    }
    for (const p of picks) {
      if (Number(p) >= total) {
        return { error: `Tile index out of range for this grid`, status: 400 };
      }
    }

    // Official-reconstruct-start gate: a submission is only legal once
    // the server's authoritative memorize deadline has passed (the
    // pattern-hide instant). Submitting while the pattern is still
    // being revealed is REJECTED — a client can't lock in a
    // reconstruction (or a very-fast speed tier) before reconstruction
    // officially starts.
    if (
      !reconstructionStarted({
        phase: match.phase,
        deadlineMs: match.roundDeadline,
        nowMs: Date.now(),
      })
    ) {
      return { error: "Reconstruction hasn't started yet", status: 409 };
    }

    // If the server still shows 'memorize' but the deadline has passed
    // (the client hid the pattern locally at the same absolute
    // deadline and hasn't been polled yet), advance to reconstruct
    // first — anchored on the authoritative memorize deadline so the
    // window is identical for both players. The submitter's completion
    // time is then measured from that same instant.
    if (match.phase === PHASES.MEMORIZE) {
      const memorizeDeadline = new Date(match.roundDeadline).getTime();
      await tx
        .update(memoryGridMatches)
        .set({
          phase: PHASES.RECONSTRUCT,
          roundDeadline: reconstructDeadlineFromStart(
            memorizeDeadline,
            reconstructWindowMs(match),
          ),
        })
        .where(
          and(
            eq(memoryGridMatches.id, match.id),
            eq(memoryGridMatches.phase, PHASES.MEMORIZE),
          ),
        );
      const [refreshed] = await tx
        .select()
        .from(memoryGridMatches)
        .where(eq(memoryGridMatches.id, match.id));
      if (refreshed) {
        Object.assign(match, refreshed);
      }
    }

    if (match.phase !== PHASES.RECONSTRUCT) {
      return { error: "Match is not awaiting a reconstruction", status: 400 };
    }

    const outcome = await applySubmission(tx, match, seat, picks, false, userId);
    // Double-submit guard: if two parallel POSTs raced, the conditional
    // UPDATE in applySubmission matched 0 rows for one of them — that
    // one loses and gets a clear 409 (the stored submission is the
    // first one; the grid can't be changed after submission).
    if (outcome.raced) {
      return { error: "You already submitted this round", status: 409 };
    }
    // Feedback only for the submitter: their authoritative round
    // assessment (final score + full-grid accuracy breakdown +
    // completion time + speed tier — all computed server-side, never
    // accepted from the client) plus the round's answer key so they
    // can review what they got right/wrong. Never sent to the
    // opponent (the opponent's /status polls never include this).
    const assessment = assessReconstruction(picks, match.board);
    const completionTimeMs = completionTimeMsFor(match);
    const windowMs = reconstructWindowMs(match);
    const { tier: speedTier, multiplier: speedMultiplier } =
      speedMultiplierFromCompletion(completionTimeMs, windowMs);
    return {
      match: outcome.match,
      justResolved: outcome.justResolved,
      score: computeFinalRoundScore({
        accuracy: assessment.accuracy,
        completionTimeMs,
        windowMs,
        pickedCount: picks.length,
      }),
      total: assessment.total,
      correct: assessment.correct,
      incorrect: assessment.incorrect,
      accuracy: assessment.accuracy,
      accuracyPct: assessment.accuracyPct,
      completionTimeMs,
      speedTier,
      speedMultiplier,
      active: Array.isArray(match.board?.active) ? match.board.active : [],
      roundNumber: match.roundNumber,
    };
  });
}

// ── Complete the current round ────────────────────────────────────────
//
// Runs once BOTH players have submitted (or been AFK auto-locked)
// their reconstruction for the round:
//
//   1. Decide the round winner from the round scores
//      (`roundWinnerFromScores`) and snapshot the completed round
//      (pattern, submissions, round scores, round winner) into
//      `memory_grid_rounds` for history/replay.
//   2. Award the round: +1 to the winner's rounds-won tally
//      (`p1_score` / `p2_score`); a tied round awards nobody.
//   3. Enter the ROUND-RESULT phase: the match stays `active` with
//      phase='result' for RESULT_WINDOW_MS so BOTH clients can poll
//      the just-completed round snapshot and render the result
//      screen (correct pattern + both reconstructions + scores).
//      Submissions are locked — `p1Submitted`/`p2Submitted` are both
//      true and the submit gate rejects any further POSTs.
//
// The result phase is terminal for the round: `advancePhaseOnPoll`
// deals the next round's memorize phase once the window elapses (or
// resolves the MATCH on rounds-won after round 5).
async function completeRound(tx, match) {
  const p1RoundScore = Number(match.p1RoundScore || 0);
  const p2RoundScore = Number(match.p2RoundScore || 0);
  const roundWinner = roundWinnerFromScores(p1RoundScore, p2RoundScore);

  // 1) Snapshot the completed round for the result screen + history.
  await tx.insert(memoryGridRounds).values({
    matchId: match.id,
    roundNumber: Number(match.roundNumber || 1),
    boardSnapshot: match.board,
    flips: Array.isArray(match.flips) ? match.flips : [],
    p1RoundScore,
    p2RoundScore,
    roundWinner,
  });

  // 2) Award the round to its winner (tied rounds award nobody) and
  // accumulate both players' round scores into the match's CUMULATIVE
  // point totals (the compact in-match scoreboard — e.g. YOU 247 vs
  // OPPONENT 231). Enter the result phase with its own
  // server-authoritative window.
  const award = {};
  if (roundWinner === RESULT.PLAYER1) {
    award.p1Score = Number(match.p1Score || 0) + 1;
  } else if (roundWinner === RESULT.PLAYER2) {
    award.p2Score = Number(match.p2Score || 0) + 1;
  }
  award.p1Total = Number(match.p1Total || 0) + p1RoundScore;
  award.p2Total = Number(match.p2Total || 0) + p2RoundScore;

  const resultDeadline = new Date(Date.now() + RESULT_WINDOW_MS);
  const [updated] = await tx
    .update(memoryGridMatches)
    .set({
      ...award,
      phase: PHASES.RESULT,
      roundDeadline: resultDeadline,
    })
    .where(
      and(
        eq(memoryGridMatches.id, match.id),
        eq(memoryGridMatches.status, match.status),
      ),
    )
    .returning();

  const next = updated || match;
  return { match: next, justResolved: false };
}

// ── Resolve the match ─────────────────────────────────────────────────
//
// End-state machine: the regular rounds AND (if needed) the tiebreak
// round are complete, so compare the players' TOTAL cumulative round
// scores (`p1_total` / `p2_total` — each round scores /100, so a
// 5-round match totals up to 500, plus the tiebreak round's /100 if
// it was played). The higher total wins (winner takes 1.9× their
// stake, house keeps 0.1×). A DRAW is only reachable when the
// TIEBREAK round ALSO ties (equal totals after round 5 deal round 6
// instead of finishing — see advancePhaseOnPoll), so a draw here
// refunds each player 95% of their stake (5% rake per side —
// OVERTIME_DRAW_FEE_PCT, mirroring keno-pvp's overtime tie) — never
// a random or invented winner. The client never supplies scores or
// the winner: `p1_total`/`p2_total` are accumulated server-side in
// completeRound, and this function is the single place that decides
// the result and settles the wager. The comparison itself is the
// shared pure helper matchWinnerFromTotals so tests cover it
// directly.
async function resolveMatch(tx, match) {
  const result = matchWinnerFromTotals(
    Number(match.p1Total || 0),
    Number(match.p2Total || 0),
  );

  // A DRAW is a tiebreak-round draw (equal totals after round 5 go
  // to round 6, so any end-state draw is a round-6 tie): each player
  // is refunded 95% of their stake, house keeps 5% per side.
  const isAi = isFreeAiMatch(match);
  const payout = isAi
    ? {
        winnerNet: 0,
        houseFee: 0,
        prizePaid: 0,
        refundEach: 0,
      }
    : computePayout({
        stakeAmount: match.stakeAmount,
        result,
        drawFeePct: result === RESULT.DRAW ? OVERTIME_DRAW_FEE_PCT : 0,
      });

  const winnerId =
    result === RESULT.PLAYER1
      ? match.player1Id
      : result === RESULT.PLAYER2
        ? match.player2Id
        : null;

  if (!isAi && winnerId) {
    // Winner gets their stake back + 90% of the loser's stake.
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
      .where(eq(users.clerkId, winnerId));
  } else if (!isAi) {
    // DRAW — refund both players. On a tiebreak draw that is 95% of
    // each player's stake (5% rake per side), per computePayout's
    // refundEach.
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.refundEach}` })
      .where(eq(users.clerkId, match.player1Id));
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.refundEach}` })
      .where(eq(users.clerkId, match.player2Id));
  }

  // Stamp the match as finished. The `board` column stays on the
  // row so the post-match reveal screen can render the full layout
  // (the /status route stops hiding it once status='finished').
  const [updated] = await tx
    .update(memoryGridMatches)
    .set({
      status: "finished",
      phase: null,
      roundDeadline: null,
      result,
      winnerId,
      houseFee: payout.houseFee.toFixed(2),
      prizePaid: payout.prizePaid.toFixed(2),
      endedAt: new Date(),
    })
    .where(eq(memoryGridMatches.id, match.id))
    .returning();

  const finalRow = updated || match;

  // Best-effort stat side-effects (failures don't roll the match).
  // Draws are skipped — no winner/loser to bump.
  if (winnerId && !isAi) {
    await recordPvPResult(tx, finalRow, winnerId, result).catch(() => {});
  }

  return finalRow;
}

// Best-effort stat side-effect — mirrors mines-pvp / blackjack-pvp.
// Bumps pvpWins / gamesWon / gamesLost / totalWon / totalWagered on
// the users rows so the global PvP leaderboards stay fresh without
// re-running aggregate queries.
async function recordPvPResult(tx, match, winnerId, result) {
  const loserId =
    result === RESULT.PLAYER1 ? match.player2Id : match.player1Id;
  if (!winnerId || !loserId) return;

  // Legacy per-seat counters — the public profile reads games_won /
  // games_lost. The money/streak/daily counters (totalWon, totalWagered,
  // biggestWin, daily_*, weekly_*, XP/level) are all maintained by
  // applyLeaderboardCounters below; bumping them here too would double-
  // count every settled match.
  await tx
    .update(users)
    .set({ gamesWon: sql`${users.gamesWon} + 1` })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({ gamesLost: sql`${users.gamesLost} + 1` })
    .where(eq(users.clerkId, loserId));

  // Canonical stats + quests pipeline (user_stats wins/losses/win_rate/
  // total_bets, pvp_wins, wagered/won, streaks, battlepass XP, quest
  // progress). Fire-and-forget on its own pool — never blocks settlement.
  const stake = Number(match.stakeAmount) || 0;
  const winnerPayout = Number(match.prizePaid) || 0;
  applyLeaderboardCounters({
    clerkId: winnerId,
    game: "memory-grid",
    betAmount: stake,
    payout: winnerPayout,
    isPvpWin: true,
  }).catch(() => {});
  applyLeaderboardCounters({
    clerkId: loserId,
    game: "memory-grid",
    betAmount: stake,
    payout: 0,
  }).catch(() => {});

  // Permanent Prestige — server-authoritative PvP hook. This runs on the
  // same guarded single-execution path as the stats above (the match flips
  // to `finished` once inside this transaction) and the prestige_results
  // journal keyed by (user, source, source_id) makes a duplicate or
  // concurrent settlement of this match a no-op.
  await applyPrestigeResult({
    tx,
    clerkId: winnerId,
    outcome: "win",
    source: "memory-grid",
    sourceId: String(match.id),
  }).catch(() => {});
  await applyPrestigeResult({
    tx,
    clerkId: loserId,
    outcome: "loss",
    source: "memory-grid",
    sourceId: String(match.id),
  }).catch(() => {});
}

// ── Status fetch with auto-resolve ────────────────────────────────────
//
// Runs the poll-driven auto-advance paths (see advancePhaseOnPoll):
// ready → memorize; memorize deadline → reconstruct; reconstruct
// deadline → AFK auto-lock of un-submitted seats and round
// resolution. Then returns the raw match row — the /status ROUTE is
// responsible for all per-viewer scrubbing.
export async function fetchMatchWithAutoResolve(userId, matchId) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }

    // Auto-advance the brief Ready window into round 1's memorize
    // phase.
    if (
      match.status === "ready" &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const advanced = await advanceFromReady(tx, match);
      return { match: advanced };
    }

    // Auto-advance phase deadlines (memorize → reconstruct → AFK
    // auto-lock → round resolution / next round / finished).
    let advanced = await advancePhaseOnPoll(tx, match);

    // Free AI matches use the same reconstruct phase as PvP, but the
    // bot submits automatically after its calibrated human-like delay.
    if (advanced?.status === MATCH_STATUS.ACTIVE && advanced?.phase === PHASES.RECONSTRUCT) {
      const aiResult = await playAiTurnInTransaction(tx, advanced);
      advanced = aiResult.match || advanced;
    }
    return { match: advanced };
  });
}

// ── Per-round history (result screen + finished breakdown) ────────────
// Completed-round snapshots: the full board pattern + both players'
// reconstruction submissions (picks, score, accuracy, completion
// time) + round scores + winner. Served to BOTH players during the
// round-result phase (so each can render the correct pattern + both
// reconstructions) and for the finished screen's per-round breakdown.
export async function fetchMatchRounds(matchId) {
  return db
    .select({
      roundNumber: memoryGridRounds.roundNumber,
      boardSnapshot: memoryGridRounds.boardSnapshot,
      flips: memoryGridRounds.flips,
      p1RoundScore: memoryGridRounds.p1RoundScore,
      p2RoundScore: memoryGridRounds.p2RoundScore,
      roundWinner: memoryGridRounds.roundWinner,
    })
    .from(memoryGridRounds)
    .where(eq(memoryGridRounds.matchId, matchId))
    .orderBy(memoryGridRounds.roundNumber);
}

// ── Player enrichment (displayName + profile image) ───────────────────
// Mirrors plinko-pvp / keno-pvp: the match row stores Clerk ids, so
// the lobby + match view would otherwise render raw id truncation.
// This looks up the `users` table and attaches a `players` field
// ({ p1: {displayName, iconKey}, p2: … }) so the shared
// lobby rows and the match-view player cards show real names and
// avatars. Best-effort: lookup failures degrade to the Clerk id
// (never crash the route).
function summariseUsers(rows, frameByKey) {
  const out = {};
  for (const r of rows) {
    if (!r || !r.clerkId) continue;
    const frameKey = pickProfileFrameKey(r.equippedCosmetics);
    out[r.clerkId] = {
      id: r.clerkId,
      displayName: r.displayName || r.clerkId,
      // Official Grynd icon key only — never an arbitrary avatar URL.
      iconKey: r.iconKey || "default",
      // Equipped profile frame (server-resolved catalog visual), or null.
      profileFrame: frameKey ? frameByKey?.get(frameKey) || null : null,
    };
  }
  return out;
}

export async function enrichMatchesWithUsers(matchOrMatches) {
  if (!matchOrMatches) return matchOrMatches;
  const list = Array.isArray(matchOrMatches) ? matchOrMatches : [matchOrMatches];
  if (list.length === 0) return matchOrMatches;
  const ids = new Set();
  for (const m of list) {
    if (!m) continue;
    if (m.player1Id) ids.add(m.player1Id);
    if (m.player2Id) ids.add(m.player2Id);
  }
  if (ids.size === 0) {
    return Array.isArray(matchOrMatches)
      ? matchOrMatches
      : { ...matchOrMatches, players: null };
  }
  let rows = [];
  try {
    rows = await db
      .select({
        clerkId: users.clerkId,
        displayName: users.name,
        iconKey: users.selectedIcon,
        equippedCosmetics: users.equippedCosmetics,
      })
      .from(users)
      .where(inArray(users.clerkId, Array.from(ids)));
  } catch (err) {
    // Never crash the route on a lookup failure — degrade to no
    // enrichment (raw Clerk ids render instead).
    console.warn(
      "[memory-grid] enrichMatchesWithUsers: users lookup failed:",
      err && err.message ? err.message : err,
    );
    rows = [];
  }
  const frameByKey = await getProfileFramesByKeys(
    rows.map((r) => pickProfileFrameKey(r.equippedCosmetics)),
  );
  const summary = summariseUsers(rows, frameByKey);
  const enrichOne = (m) => {
    if (!m) return m;
    const p1 = m.player1Id ? summary[m.player1Id] || null : null;
    const p2 = m.player2Id ? summary[m.player2Id] || null : null;
    return {
      ...m,
      players: {
        p1: p1 || (m.player1Id ? { id: m.player1Id, displayName: m.player1Id, missing: true } : null),
        p2: p2 || (m.player2Id ? { id: m.player2Id, displayName: m.player2Id, missing: true } : null),
      },
    };
  };
  return Array.isArray(matchOrMatches)
    ? list.map(enrichOne)
    : enrichOne(matchOrMatches);
}
