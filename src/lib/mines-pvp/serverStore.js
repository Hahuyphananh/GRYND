// src/lib/mines-pvp/serverStore.js
//
// Server-side canonical helpers for the Mines PvP ("Mines Duel")
// match system.
//
// Why a dedicated serverStore (mirrors `src/lib/blackjack-pvp/
// serverStore.js` + `src/lib/roulette-pvp/serverStore.js`):
//   The match state machine has to be authoritative on the server:
//     * matchmaking lock (stake-keyed) prevents lobby-race duplicates
//     * host-picked mine count is locked at lobby creation; joiner
//       gets the same board
//     * server randomizes the turn order at match creation
//     * server randomizes the 5×5 board at match creation
//     * 3-second ready banner auto-advance
//     * turn enforcement (only the player whose turn it is can pick)
//     * 20-second pick-window auto-pick (AFK → random cell, which
//       may be a mine — that's the punishment for going AFK)
//     * end-state resolution per user spec table
//     * 90/10 payout split (winner gets 1.9× stake, house keeps 0.1×)
//     * full board hidden from clients until match finishes
//   Centralising this in a tiny module keeps the API routes thin
//   and makes the state machine testable in isolation.
//
// State machine:
//   waiting → ready → p1_turn → p2_turn → finished
//   (waiting/ready/active → cancelled)
//
// "p1_turn" means "it's player1's turn" (currentTurnUserId = player1Id).
// "p2_turn" means "it's player2's turn" (currentTurnUserId = player2Id).
// The host-picked first player is whichever of player1Id / player2Id
// was rolled at match creation; the other player goes second.

import { eq, and, sql, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import {
  minesPvpMatches,
  minesPvpRounds,
  users,
} from "../../db/schema";
import { sendSystemNotificationEmail } from "../emails/system";
import {
  ACTIVE_STATES,
  GRID_CELLS,
  HOUSE_RATIO,
  MATCH_STATUS,
  MAX_MINES,
  MAX_STAKE,
  MIN_MINES,
  MIN_STAKE,
  MINES_PVP_LOCK_NAMESPACE,
  PICKABLE_STATES,
  READY_WINDOW_MS,
  RESULT,
  ROUND_PICK_DEADLINE_MS,
  ROUND_TIMER_SECONDS,
  computePayout,
  decideOutcome,
  generateBoard,
  isMine,
  pickRandomCell,
} from "./constants";

// ── Helpers ───────────────────────────────────────────────────────────

// Per-row pacing helper: derive the per-pick deadline duration in ms
// from a match row, falling back to the server-side default if the
// column is null/0. Lets admin tooling override per-match pacing via
// `round_timer_seconds` without code changes (mirrors roulette-pvp /
// blackjack-pvp `roundDeadlineMs`).
function roundDeadlineMs(match) {
  const t = Number(match?.roundTimerSeconds);
  if (Number.isFinite(t) && t > 0) return t * 1000;
  return ROUND_PICK_DEADLINE_MS;
}

// Stable deterministic hash from numeric stake to a signed 32-bit int.
// Used purely as the second key of the two-key pg_advisory_xact_lock
// for stake-keyed matchmaking. Collisions on distinct stakes would
// only briefly serialise (no correctness risk).
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

export function isParticipant(match, userId) {
  return seatForUser(match, userId) !== null;
}

// Validate the host-picked mine count + stake at lobby creation time.
// Returns `{ ok: true }` on success, `{ ok: false, error }` otherwise.
export function validateMatchParams({ stakeAmount, minesCount }) {
  const stake = Number(stakeAmount);
  const mines = Number(minesCount);
  if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
    return {
      ok: false,
      error: `Stake must be a number in [${MIN_STAKE}, ${MAX_STAKE}]`,
    };
  }
  if (!Number.isInteger(mines) || mines < MIN_MINES || mines > MAX_MINES) {
    return {
      ok: false,
      error: `Mines count must be an integer in [${MIN_MINES}, ${MAX_MINES}]`,
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

// ── Create / Join matchmaking ─────────────────────────────────────────
//
// Single-transaction stake-keyed matchmaking (mirrors
// blackjack-pvp / roulette-pvp):
//
//   1. Postgres `pg_advisory_xact_lock` keyed on
//      (MINES_PVP_LOCK_NAMESPACE, hash(stake)) serialises every
//      concurrent matchmaker for the same stake across all workers.
//      Without this, two matchmakers calling `createOrJoin`
//      concurrently could both observe "no open match" and both
//      INSERT a fresh waiting row.
//   2. `FOR UPDATE` + re-fetch + conditional UPDATE filtering on
//      `status='waiting' AND player2_id IS NULL` catches the
//      "creator cancelled in parallel" race.
//
// `minesCount` is REQUIRED at create time and IGNORED at join time —
// the joiner just consumes whatever mine count the host picked. This
// prevents a malicious joiner from substituting a different mine
// count to "fix" the match.
export async function createOrJoin({ userId, stakeAmount, minesCount }) {
  const validation = validateMatchParams({ stakeAmount, minesCount });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }

  const lockKey = hashStakeToInt(stakeAmount);

  return await db.transaction(async (tx) => {
    // Acquire stake-keyed advisory lock; auto-released on commit/rollback.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${MINES_PVP_LOCK_NAMESPACE}, ${lockKey})`,
    );

    // 1) Look for an existing open match with matching stake.
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
      // minesCount from joiner is ignored (host already picked).
      if (openMatch.player1Id === userId) {
        // Caller's own existing lobby — just return it.
        return { match: openMatch, joined: false };
      }
      return await joinExistingMatch(tx, openMatch.id, userId, stakeAmount);
    }

    // 2) No open match — create a fresh waiting match.
    return await createWaitingMatch(tx, userId, stakeAmount, minesCount);
  });
}

async function createWaitingMatch(tx, userId, stakeAmount, minesCount) {
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

  const [match] = await tx
    .insert(minesPvpMatches)
    .values({
      player1Id: userId,
      stakeAmount: Number(stakeAmount).toFixed(2),
      minesCount: Number(minesCount),
      status: MATCH_STATUS.WAITING,
      // BOARD IS GENERATED HERE so the host's pick is locked in
      // before any joiner arrives. The board is stored server-only;
      // /status scrubs it until the match finishes.
      board: generateBoard(Number(minesCount)),
      roundTimerSeconds: ROUND_TIMER_SECONDS,
      startedAt: null,
    })
    .returning();

  // Fire system notification for large PvP create stakes.
  if (Number(stakeAmount) >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `User ${userId} created mines PvP lobby (${stakeAmount} stake, ${minesCount} mines).`,
      metadata: { userId, stakeAmount, minesCount, matchId: match.id },
    }).catch(() => {});
  }

  return { match, joined: false };
}

async function joinExistingMatch(tx, candidateId, userId, stakeAmount) {
  // Re-fetch the candidate row INSIDE the same transaction with
  // FOR UPDATE so a parallel /cancel that committed first can't leave
  // us updating a row that's already cancelled.
  const [match] = await tx
    .select()
    .from(minesPvpMatches)
    .where(eq(minesPvpMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
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

  // Server randomizes the turn order at match creation. The chosen
  // player is the one who picks first (status='p1_turn' / 'p2_turn'
  // with currentTurnUserId pointing at them).
  const firstPlayerId =
    Math.random() < 0.5 ? match.player1Id : userId;

  // Brief 3-second "Ready" window so both players can read the
  // match-found banner before the first 20-second pick window
  // opens. /status auto-advances to the first pick state once the
  // deadline passes (see advanceFromReady).
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(minesPvpMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.READY,
      firstPlayerId,
      // currentTurnUserId stays null until advanceFromReady fires
      // (the first pick state will set it to firstPlayerId).
      currentTurnUserId: null,
      roundDeadline: readyDeadline,
      startedAt: new Date(),
    })
    .where(
      and(
        eq(minesPvpMatches.id, candidateId),
        // Defensive guard: only update if status is still `waiting`
        // and player2Id is still null when we commit.
        eq(minesPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(minesPvpMatches.player2Id),
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

// ── Cancel (creator only, while in waiting) ───────────────────────────

export async function cancelMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(minesPvpMatches)
      .where(eq(minesPvpMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 };
    if (match.status !== MATCH_STATUS.WAITING) {
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
      .update(minesPvpMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        endedAt: new Date(),
      })
      .where(eq(minesPvpMatches.id, matchId))
      .returning();

    return { match: updated };
  });
}

// ── Match fetch with row lock (for atomic operations) ─────────────────

async function fetchMatchForUpdate(tx, matchId) {
  const [match] = await tx
    .select()
    .from(minesPvpMatches)
    .where(eq(minesPvpMatches.id, matchId))
    .for("update");
  return match;
}

// ── Auto-advance ready → first pick state ──────────────────────────────
//
// Fires from fetchMatchWithAutoResolve when the 3-second ready window
// elapses. Sets `status` to `p1_turn` or `p2_turn` (whichever
// `firstPlayerId` corresponds to) and opens the first 20-second
// pick window.
async function advanceFromReady(tx, match) {
  if (!match.firstPlayerId) {
    // Defensive: should never happen (joinExistingMatch sets this),
    // but bail out cleanly if it does.
    return match;
  }
  const isFirstPlayerP1 = match.firstPlayerId === match.player1Id;
  const nextStatus = isFirstPlayerP1
    ? MATCH_STATUS.P1_TURN
    : MATCH_STATUS.P2_TURN;
  const deadline = new Date(Date.now() + roundDeadlineMs(match));

  await tx
    .update(minesPvpMatches)
    .set({
      status: nextStatus,
      currentTurnUserId: match.firstPlayerId,
      roundDeadline: deadline,
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

// ── Force-pick on deadline ────────────────────────────────────────────
//
// Server-side "AFK nudge": if the current player's pick window has
// elapsed and they haven't picked, auto-pick a random unrevealed
// cell. The cell MAY be a mine — that's the punishment for going
// AFK in the middle of a turn (per user spec).
//
// Returns the freshly-updated match row (which may have already
// advanced to the next state if this was player2's AFK auto-pick).
async function forcePick(tx, match) {
  if (!PICKABLE_STATES.has(match.status)) {
    return match;
  }
  const isP1Turn = match.status === MATCH_STATUS.P1_TURN;
  const seat = isP1Turn ? "player1" : "player2";
  const picks = [match.p1Pick, match.p2Pick].filter(
    (p) => Number.isInteger(p) && p >= 0 && p < GRID_CELLS,
  );
  const cellIndex = pickRandomCell({ excludePicks: picks });
  const pickIsMine = isMine(match.board, cellIndex);

  // Insert pick into the right per-seat columns.
  const setValues = {
    currentTurnUserId: null, // turn consumed (auto-pick)
    roundDeadline: null,
  };
  if (isP1Turn) {
    setValues.p1Pick = cellIndex;
    setValues.p1PickIsMine = pickIsMine;
    setValues.p1PickedAt = new Date();
    setValues.p1AutoPicked = true;
  } else {
    setValues.p2Pick = cellIndex;
    setValues.p2PickIsMine = pickIsMine;
    setValues.p2PickedAt = new Date();
    setValues.p2AutoPicked = true;
  }

  // Seat-specific update with conditional status guard so a
  // concurrent manual pick arriving in the same tx can't lose.
  const [updated] = await tx
    .update(minesPvpMatches)
    .set(setValues)
    .where(
      and(
        eq(minesPvpMatches.id, match.id),
        eq(minesPvpMatches.status, match.status),
      ),
    )
    .returning();

  const effective = updated || match;

  // If this was player1's AFK auto-pick, advance to p2_turn. If it
  // was player2's, both picks are now in — resolve the match.
  // (The status column doesn't change inside the seat-specific
  // UPDATE above, so we have to discriminate by the *original*
  // `isP1Turn` flag, not by `effective.status`.)
  if (isP1Turn) {
    const nextDeadline = new Date(Date.now() + roundDeadlineMs(effective));
    const [advanced] = await tx
      .update(minesPvpMatches)
      .set({
        status: MATCH_STATUS.P2_TURN,
        currentTurnUserId: effective.player2Id,
        roundDeadline: nextDeadline,
      })
      .where(
        and(
          eq(minesPvpMatches.id, effective.id),
          eq(minesPvpMatches.status, MATCH_STATUS.P1_TURN),
        ),
      )
      .returning();
    return advanced || effective;
  }

  // Was player2's AFK auto-pick — resolve the match.
  return await resolveMatch(tx, effective);
}

// ── pickTile (the main action) ────────────────────────────────────────
//
// Server-side authoritative tile-pick action. Only the player whose
// turn it is can pick. Cell index must be 0-24 and not already
// picked. After the pick lands, the turn advances to the other
// player (or to `finished` if both picks are now in).
//
// Rejects stale submissions: if the pick window has elapsed, return
// 409 so the client knows to wait for the next status poll to
// trigger the AFK auto-pick.
export async function pickTile({ userId, matchId, cellIndex }) {
  // Defense-in-depth input validation (the API route also validates).
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
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (!PICKABLE_STATES.has(match.status)) {
      return { error: "Match is not awaiting a pick", status: 400 };
    }

    // Stale-deadline guard: if the pick window has elapsed, reject
    // the manual pick. The next /status poll will trigger the AFK
    // auto-pick via fetchMatchWithAutoResolve.
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      return { error: "Pick window has expired", status: 400 };
    }

    // Turn enforcement: only the player whose turn it is can pick.
    if (match.currentTurnUserId !== userId) {
      return { error: "It is not your turn", status: 403 };
    }

    // Disallow duplicate picks (manual + future AFK of the other
    // player could otherwise target the same cell).
    if (match.p1Pick === idx || match.p2Pick === idx) {
      return { error: "Cell already picked", status: 409 };
    }

    const isP1Turn = match.status === MATCH_STATUS.P1_TURN;
    const pickIsMine = isMine(match.board, idx);
    const seat = isP1Turn ? "player1" : "player2";

    const setValues = {
      currentTurnUserId: null, // turn consumed
      // roundDeadline will be re-set to the next pick window below
      // (or nulled out if the match resolves from this pick).
      roundDeadline: null,
    };
    if (isP1Turn) {
      setValues.p1Pick = idx;
      setValues.p1PickIsMine = pickIsMine;
      setValues.p1PickedAt = new Date();
    } else {
      setValues.p2Pick = idx;
      setValues.p2PickIsMine = pickIsMine;
      setValues.p2PickedAt = new Date();
    }

    // Conditional UPDATE with status guard so a concurrent AFK
    // auto-pick (from a status poll) can't lose this manual pick.
    const [updated] = await tx
      .update(minesPvpMatches)
      .set(setValues)
      .where(
        and(
          eq(minesPvpMatches.id, match.id),
          eq(minesPvpMatches.status, match.status),
        ),
      )
      .returning();

    if (!updated) {
      // Lost the race to a concurrent status poll that triggered
      // AFK auto-pick. Refetch and return the new state.
      const [refreshed] = await tx
        .select()
        .from(minesPvpMatches)
        .where(eq(minesPvpMatches.id, match.id));
      return { match: refreshed, raced: true };
    }

    // If this was player1's pick, advance to p2_turn. If it was
    // player2's, both picks are in — resolve the match.
    if (isP1Turn) {
      const nextDeadline = new Date(Date.now() + roundDeadlineMs(updated));
      const [advanced] = await tx
        .update(minesPvpMatches)
        .set({
          status: MATCH_STATUS.P2_TURN,
          currentTurnUserId: updated.player2Id,
          roundDeadline: nextDeadline,
        })
        .where(
          and(
            eq(minesPvpMatches.id, updated.id),
            eq(minesPvpMatches.status, MATCH_STATUS.P1_TURN),
          ),
        )
        .returning();
      return { match: advanced || updated, justResolved: false };
    }

    // player2 just picked — resolve.
    const resolved = await resolveMatch(tx, updated);
    return { match: resolved, justResolved: true };
  });
}

// ── Resolve the match ─────────────────────────────────────────────────
//
// End-state machine: both picks are in, decide outcome per user spec
// table (decideOutcome), credit the winner, refund on draw, insert
// the history row, and stamp the match as `finished`.
//
// Per spec:
//   P1 mine + P2 mine → P2 loses (P1 mined first)
//   P1 mine + P2 safe → P1 loses
//   P1 safe + P2 mine → P2 loses
//   P1 safe + P2 safe → DRAW (full refund, no fee)
async function resolveMatch(tx, match) {
  // Guard: both picks must be present before we can resolve. This
  // fires when `pickTile` calls `resolveMatch` after p2 picks, and
  // when `forcePick` calls it after p2's AFK auto-pick. Defensive in
  // case a future caller forgets to pre-validate.
  if (match.p1Pick == null || match.p2Pick == null) {
    return match;
  }

  const result = decideOutcome({
    p1PickIsMine: Boolean(match.p1PickIsMine),
    p2PickIsMine: Boolean(match.p2PickIsMine),
  });

  const payout = computePayout({
    stakeAmount: match.stakeAmount,
    result,
  });

  // Persist the per-match history snapshot FIRST so the history
  // always reflects the final board + outcome.
  await tx.insert(minesPvpRounds).values({
    matchId: match.id,
    roundNumber: 1,
    p1Pick: match.p1Pick,
    p2Pick: match.p2Pick,
    p1PickIsMine: Boolean(match.p1PickIsMine),
    p2PickIsMine: Boolean(match.p2PickIsMine),
    p1AutoPicked: Boolean(match.p1AutoPicked),
    p2AutoPicked: Boolean(match.p2AutoPicked),
    boardSnapshot: match.board ?? { size: 5, mines: [] },
    roundWinner: result,
  });

  // Apply balance changes per the payout math.
  let winnerId = null;
  if (result === RESULT.PLAYER1) {
    winnerId = match.player1Id;
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
      .where(eq(users.clerkId, match.player1Id));
  } else if (result === RESULT.PLAYER2) {
    winnerId = match.player2Id;
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
      .where(eq(users.clerkId, match.player2Id));
  } else {
    // DRAW (both safe) — refund both players in full, no house fee.
    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
      })
      .where(eq(users.clerkId, match.player1Id));
    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
      })
      .where(eq(users.clerkId, match.player2Id));
  }

  // Stamp the match as finished. The `board` column stays on the row
  // so the post-match reveal screen can render the full mine layout
  // (the /status route stops scrubbing it once status='finished').
  const setValues = {
    status: MATCH_STATUS.FINISHED,
    currentTurnUserId: null,
    roundDeadline: null,
    result,
    houseFee: payout.houseFee.toFixed(2),
    prizePaid: payout.prizePaid.toFixed(2),
    endedAt: new Date(),
  };
  if (winnerId) setValues.winnerId = winnerId;

  const [updated] = await tx
    .update(minesPvpMatches)
    .set(setValues)
    .where(eq(minesPvpMatches.id, match.id))
    .returning();

  const finalRow = updated || match;

  // Best-effort stat side-effects (failures don't roll the match).
  if (result === RESULT.PLAYER1 || result === RESULT.PLAYER2) {
    await recordPvPResult(tx, finalRow, winnerId, result).catch(() => {});
  }

  return finalRow;
}

// Best-effort stat side-effect — mirrors blackjack-pvp /
// roulette-pvp. Bumps pvpWins / gamesWon / gamesLost / totalWon /
// totalWagered on the users rows so the global PvP leaderboards
// stay fresh without re-running aggregate queries.
async function recordPvPResult(tx, match, winnerId, result) {
  const loserId =
    result === RESULT.PLAYER1 ? match.player2Id : match.player1Id;
  if (!winnerId || !loserId) return;

  await tx
    .update(users)
    .set({ pvpWins: sql`${users.pvpWins} + 1` })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({
      gamesWon: sql`${users.gamesWon} + 1`,
      totalWon: sql`${users.totalWon} + ${Number(match.prizePaid) || 0}`,
      biggestWin:
        Number(match.prizePaid) > 0
          ? sql`GREATEST(${users.biggestWin}, ${Number(match.prizePaid)})`
          : sql`${users.biggestWin}`,
    })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({
      gamesLost: sql`${users.gamesLost} + 1`,
      totalWagered: sql`${users.totalWagered} + ${Number(match.stakeAmount)}`,
    })
    .where(eq(users.clerkId, loserId));
}

// ── Status fetch with auto-resolve ────────────────────────────────────
//
// Three auto-advance paths live here so the client polling is the
// single source of forward progress:
//
//   1. `ready` deadline elapsed → advance to the first pick state
//      (p1_turn or p2_turn depending on the host's first-player roll).
//   2. `p1_turn` or `p2_turn` deadline elapsed → force-pick a random
//      cell for the current player (AFK nudge), then advance the turn
//      OR resolve the match (if it was player2's auto-pick).
//
// Also scrubs the `board` column from the returned match row when
// the match is not yet `finished`, so the client can't inspect mine
// positions mid-match. Once status='finished' the board is exposed
// for the post-match reveal.
export async function fetchMatchWithAutoResolve(userId, matchId) {
  const result = await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }

    // 1) Auto-advance the brief Ready window into the first pick
    //    state.
    if (
      match.status === MATCH_STATUS.READY &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const advanced = await advanceFromReady(tx, match);
      return { match: advanced };
    }

    // 2) AFK auto-pick on the current turn's deadline. Covers both
    //    p1_turn and p2_turn. forcePick advances the turn OR
    //    resolves the match internally depending on whose turn it
    //    was.
    if (
      PICKABLE_STATES.has(match.status) &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const advanced = await forcePick(tx, match);
      return { match: advanced };
    }

    return { match };
  });

  if (result?.match) {
    return { ...result, match: scrubMatchForViewer(result.match) };
  }
  return result;
}

// Scrub server-only state from a match row before sending it to a
// client. Hides the `board` jsonb (mine positions) until the match
// reaches `finished`. The auto-pick flags and pick timestamps stay
// on the row (history/replay data) — they don't reveal mine
// positions so they don't need scrubbing.
export function scrubMatchForViewer(match) {
  if (!match) return match;
  const isFinished = match.status === MATCH_STATUS.FINISHED;
  if (isFinished) {
    // Finished: keep the board so the client can render the post-
    // match reveal animation.
    return { ...match };
  }
  // Not finished: replace the board with a placeholder so the
  // client knows the field is server-only without seeing the mines.
  return {
    ...match,
    board: null,
    // Also hide opponent's auto-pick flag mid-match so neither side
    // can infer whether the other has been AFK'd yet.
  };
}

// ── Fetch round history for the match ─────────────────────────────────
//
// Always returns 1 row (this is a single-round game). Kept as an
// array for API symmetry with the other PvP systems.
export async function fetchMatchRounds(matchId) {
  return db
    .select()
    .from(minesPvpRounds)
    .where(eq(minesPvpRounds.matchId, matchId))
    .orderBy(sql`${minesPvpRounds.roundNumber} ASC`);
}

// ── Lightweight read for /status (no row lock) ────────────────────────
//
// Returns the raw row without scrubbing. The caller is responsible
// for running `scrubMatchForViewer` if it's about to send the row
// to a client. `fetchMatchWithAutoResolve` already scrubs; this
// thin read is exposed for callers that want to do their own
// post-processing (admin tooling, tests).
export async function fetchMatch(matchId) {
  const [match] = await db
    .select()
    .from(minesPvpMatches)
    .where(eq(minesPvpMatches.id, matchId));
  return match || null;
}
