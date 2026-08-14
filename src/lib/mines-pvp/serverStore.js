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
  activePickerForMatch,
  computePayout,
  decideOutcome,
  generateSolvableBoard,
  isMine,
  nearestMineDistance,
  pickRandomCell,
  relocateMine,
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
      // /status scrubs it until the match finishes. Uses the
      // no-guess generator: the 3×3 center block stays mine-free and
      // the board is verified to be fully solvable by deduction from
      // the center opening (falling back to the least-guessy board if
      // none qualifies), so matches are decided by deduction and
      // zugzwang rather than coin flips.
      board: generateSolvableBoard(Number(minesCount)),
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
// elapsed and they haven't picked, auto-pick a random un-picked
// cell. The cell MAY be a mine — that's the punishment for going
// AFK in the middle of a turn (per user spec). The auto-pick is
// appended to `picks` (with `autoPicked: true`) and follows the
// normal resolution rules: mine hit → picker loses outright;
// otherwise → advance to the next picker in the "odds" turn order.
// Returns the freshly-updated match row.
async function forcePick(tx, match) {
  if (!PICKABLE_STATES.has(match.status)) {
    return match;
  }
  // The active picker is whatever the closed-form odds formula
  // returns given the current picks-array length — NOT whatever
  // `match.status === p1_turn` says, which only mirrors seat at
  // pick-time.
  const pickerId = activePickerForMatch(match);
  const cellIndex = pickRandomCell({
    // Exclude every cell already in the per-pick history, not just
    // the legacy first-of-each-seat scalar (a player may have
    // already made multiple picks before going AFK).
    excludePicks: pickHistoryCells(match),
  });

  // First-pick mercy applies to the AFK auto-pick on turn 1 as well:
  // the opening is definitionally a guess, so it must never be a trap.
  // Relocates the mine and persists the new board in this tx.
  let board = match.board;
  let mercyUsed = false;
  if (match.picks.length === 0 && isMine(board, cellIndex)) {
    board = relocateMine(board, cellIndex);
    mercyUsed = true;
    await tx
      .update(minesPvpMatches)
      .set({ board })
      .where(eq(minesPvpMatches.id, match.id));
  }

  const pickIsMine = isMine(board, cellIndex);
  const seat = pickerId === match.player1Id ? "player1" : "player2";
  const pickedAt = new Date();
  const newPick = {
    userId: pickerId,
    seat,
    cell: cellIndex,
    isMine: pickIsMine,
    // Proximity hint for SAFE picks (null on a mine): how many tiles
    // away the nearest mine is, computed server-side from the board.
    // The /status route strips it from the OPPONENT's view — each
    // player only ever sees their own numbers.
    hint: pickIsMine ? null : nearestMineDistance(board, cellIndex),
    mercy: mercyUsed,
    autoPicked: true,
    pickedAt: pickedAt.toISOString(),
  };

  // Apply the pick + (if mine) resolve OR (if safe) advance turn.
  return await applyPick(tx, { ...match, board }, newPick);
}

// ── Pure utility: flatten every pick cell across all players ──────────
// Used by forcePick's `excludePicks` so the AFK auto-pick never
// re-uses a cell the other player already cleared. Safe to call on
// legacy rows whose `picks` is NULL — returns an empty array.
function pickHistoryCells(match) {
  const picks = Array.isArray(match?.picks) ? match.picks : [];
  return picks
    .map((p) => Number(p?.cell))
    .filter((c) => Number.isInteger(c) && c >= 0 && c < GRID_CELLS);
}

// ── Apply a (validated) pick to the match ─────────────────────────────-
//
// Shared by `pickTile` (user-supplied) and `forcePick` (AFK
// auto-pick). Encapsulates: append to `picks`, mirror the
// most-recent pick onto the legacy p{N}_pick columns for
// backwards-compat history views, and either resolve the match
// (mine hit) or advance to the next picker (odds formula).

// Shared by `applyPick` (pickTile / forcePick) and `flagTile`: compute
// the legacy scalar mirrors (most-recent-of-each-seat) for a new
// chronological `picks` array. `picks` stores `pickedAt` as an ISO
// string for JSONB portability, but the Drizzle `p{N}_picked_at`
// columns are declared `timestamp()` (mode 'date' default) and crash
// with `TypeError: value.getTime is not a function` when bound from a
// raw string — so `pickSeatMostRecentDate` re-hydrates to a Date
// before .set(). Flag entries flow through the same mirrors (their
// `isMine` = whether the flagged cell really held a mine).
function mirrorPickSetValues(allPicks) {
  return {
    p1Pick: pickSeatMostRecent(allPicks, "player1", "cell"),
    p2Pick: pickSeatMostRecent(allPicks, "player2", "cell"),
    p1PickIsMine: pickSeatMostRecent(allPicks, "player1", "isMine"),
    p2PickIsMine: pickSeatMostRecent(allPicks, "player2", "isMine"),
    p1PickedAt: pickSeatMostRecentDate(allPicks, "player1"),
    p2PickedAt: pickSeatMostRecentDate(allPicks, "player2"),
    p1AutoPicked:
      pickSeatMostRecent(allPicks, "player1", "autoPicked") ?? false,
    p2AutoPicked:
      pickSeatMostRecent(allPicks, "player2", "autoPicked") ?? false,
  };
}

async function applyPick(tx, match, pick) {
  const allPicks = Array.isArray(match.picks) ? [...match.picks] : [];
  allPicks.push(pick);

  const setValues = {
    picks: allPicks,
    // Mirror the most-recent-of-each seat onto the legacy scalar
    // columns. Only the LAST pick from a given seat sticks; this
    // preserves the schema contract for any legacy viewer that
    // still reads `p1_pick` / `p2_pick` etc. directly.
    ...mirrorPickSetValues(allPicks),
  };

  if (pick.isMine) {
    // Mine hit → resolve immediately. The picker of the mine loses
    // outright per the new odds-turn spec (no draws possible).
    // Conditional update + resolve are inside the same tx so a
    // concurrent status poll can't see a half-applied pick.
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
      // Lost the race to a concurrent safe-pick advance; fall
      // through and call resolveMatch on the FRESH row, but
      // EXPLICITLY merge `pick` onto `refreshed.picks` first so the
      // rounds-row + per-seat scalars don't drop the mine that
      // ended the match (defensive per code-review S1).
      const [refreshed] = await tx
        .select()
        .from(minesPvpMatches)
        .where(eq(minesPvpMatches.id, match.id));
      const merged = refreshed || match;
      const mergedPicks = Array.isArray(merged.picks)
        ? [...merged.picks, pick]
        : [pick];
      return await resolveMatch(
        tx,
        { ...merged, picks: mergedPicks },
        pick.userId,
      );
    }
    return await resolveMatch(tx, updated, pick.userId);
  }

  // Safe pick → advance to the next picker via the closed-form
  // odds formula. Set the next deadline + flip `currentTurnUserId`
  // + keep `status` aligned with the new picker seat for legacy
  // status listeners that still interpret p1_turn / p2_turn.
  const fakeMatchAfter = { ...match, picks: allPicks };
  const nextPickerId = activePickerForMatch(fakeMatchAfter);
  const nextDeadline = new Date(Date.now() + roundDeadlineMs(match));
  const nextStatus =
    nextPickerId === match.player1Id
      ? MATCH_STATUS.P1_TURN
      : MATCH_STATUS.P2_TURN;

  const [updated] = await tx
    .update(minesPvpMatches)
    .set({
      ...setValues,
      currentTurnUserId: nextPickerId,
      roundDeadline: nextDeadline,
      status: nextStatus,
    })
    .where(
      and(
        eq(minesPvpMatches.id, match.id),
        eq(minesPvpMatches.status, match.status),
      ),
    )
    .returning();

  if (!updated) {
    const [refreshed] = await tx
      .select()
      .from(minesPvpMatches)
      .where(eq(minesPvpMatches.id, match.id));
    return { match: refreshed || match, justResolved: false, raced: true };
  }
  return { match: updated, justResolved: false };
}

// Pure helper: return the value of `field` from the MOST RECENT
// entry of `picks` whose `seat` matches `seatLabel`. Returns null
// if no such entry exists (so callers can stamp null onto legacy
// timestamp columns when that seat hasn't picked yet).
function pickSeatMostRecent(picks, seatLabel, field) {
  for (let i = picks.length - 1; i >= 0; i -= 1) {
    if (picks[i] && picks[i].seat === seatLabel) {
      return picks[i][field] ?? null;
    }
  }
  return null;
}

// Date sibling of `pickSeatMostRecent`. Reads the most-recent
// `pickedAt` ISO string for `seatLabel` and re-hydrates it into a
// JS `Date` so the result is safe to bind to Drizzle's
// `timestamp()` columns (`mode: 'date'` is the default and Drizzle
// calls `.getTime()`/`.toISOString()` on the value — passing a
// raw string throws a TypeError and 500s the route). Returns null
// when the seat hasn't picked yet, mirroring the original helper.
function pickSeatMostRecentDate(picks, seatLabel) {
  const raw = pickSeatMostRecent(picks, seatLabel, "pickedAt");
  return raw ? new Date(raw) : null;
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

    // Turn enforcement: the closed-form odds formula decides WHOSE
    // turn it is right now (FP / SP / SP / FP / ...). The DB row's
    // `currentTurnUserId` should agree with the formula; if it
    // doesn't (e.g. a legacy row mid-migration), reject. The caller
    // must equal whatever the formula says.
    const expectedPicker = activePickerForMatch(match);
    if (
      !expectedPicker ||
      match.currentTurnUserId !== expectedPicker ||
      userId !== expectedPicker
    ) {
      return { error: "It is not your turn", status: 403 };
    }

    // Disallow duplicate picks across the full per-pick history,
    // not just the legacy first-of-each-seat scalar. Both players
    // can now make many picks; only ever one pick per cell.
    const historyCells = pickHistoryCells(match);
    if (historyCells.includes(idx)) {
      return { error: "Cell already picked", status: 409 };
    }

    // First-pick mercy: the game's very first pick is always safe.
    // Before any cell is revealed there is zero information, so the
    // opening is definitionally a guess — this makes it a safe guess
    // (the same convention real guess-free minesweeper uses). If the
    // first pick lands on a mine, relocate that mine off the cell and
    // persist the new board in the same transaction (the board is
    // server-hidden mid-match, so nothing leaks to either client).
    let board = match.board;
    let mercyUsed = false;
    if (match.picks.length === 0 && isMine(board, idx)) {
      board = relocateMine(board, idx);
      mercyUsed = true;
      await tx
        .update(minesPvpMatches)
        .set({ board })
        .where(eq(minesPvpMatches.id, match.id));
    }

    const pickIsMine = isMine(board, idx);
    const seat =
      userId === match.player1Id ? "player1" : "player2";
    const newPick = {
      userId,
      seat,
      cell: idx,
      isMine: pickIsMine,
      // Proximity hint for SAFE picks (null on a mine): distance to the
      // nearest mine. Stripped from the opponent's view by /status.
      hint: pickIsMine ? null : nearestMineDistance(board, idx),
      mercy: mercyUsed,
      autoPicked: false,
      pickedAt: new Date().toISOString(),
    };

    return await applyPick(tx, { ...match, board }, newPick);
  });
}

// ── flagTile (the "call a mine" skill move) ───────────────────────────
//
// On your turn you may FLAG a tile instead of picking it: declare
// "this tile is a mine". Terminal either way:
//   • CORRECT (the tile really is a mine) → the OPPONENT loses (you
//     deduced it, you take the pot).
//   • WRONG (the tile is safe) → YOU lose (your read was bad).
//
// Skill notes (per user spec):
//   * No first-pick mercy for flags — mercy protects the opening
//     PICK because it is definitionally a guess; a flag is a
//     deliberate claim, so a wrong first-turn flag loses outright.
//   * Self-balancing by mine count: a random flag wins with
//     probability mines/25, so flagging blind is terrible at low
//     mine counts and only becomes worth it when you have actually
//     DEDUCED a cell must be a mine (or accepted the high-mine
//     gamble). The private distance hints are the deduction surface.
//   * A flag ends the match immediately, so it never leaks mid-match
//     state — the flag entry only ever exists in the finished
//     reveal (same scrub path as picks).
//
// Validation mirrors pickTile: participant, pickable state, turn
// enforcement (closed-form odds formula), deadline freshness, and
// cell-not-already-picked. The flag is recorded in the chronological
// `picks` array with `flag: true` (the legacy scalar mirrors follow
// the shared mirrorPickSetValues path), then the match resolves
// terminally via resolveMatch.
export async function flagTile({ userId, matchId, cellIndex }) {
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

    // Stale-deadline guard: same contract as pickTile — a flag after
    // the window is rejected; the next /status poll triggers the AFK
    // auto-pick instead.
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      return { error: "Pick window has expired", status: 400 };
    }

    // Turn enforcement via the closed-form odds formula (same as
    // pickTile): the caller must be whoever the formula says is up.
    const expectedPicker = activePickerForMatch(match);
    if (
      !expectedPicker ||
      match.currentTurnUserId !== expectedPicker ||
      userId !== expectedPicker
    ) {
      return { error: "It is not your turn", status: 403 };
    }

    // Cannot flag a cell either side has already revealed.
    const historyCells = pickHistoryCells(match);
    if (historyCells.includes(idx)) {
      return { error: "Cell already picked", status: 409 };
    }

    const flagIsMine = isMine(match.board, idx);
    const seat = userId === match.player1Id ? "player1" : "player2";
    const flagEntry = {
      userId,
      seat,
      cell: idx,
      isMine: flagIsMine,
      // No hint on a flag: the number would be meaningless on a cell
      // the flagger believes is a mine (and a wrong flag is a loss
      // anyway — the game is over).
      hint: null,
      // Discriminator: this entry is a flag, not a pick. The client
      // renders flag-specific copy for the result screen.
      flag: true,
      mercy: false,
      autoPicked: false,
      pickedAt: new Date().toISOString(),
    };

    // The loser depends on the flag's correctness:
    //   correct (isMine)  → the flagger WINS, opponent loses
    //   wrong (safe)      → the flagger LOSES
    const loserId = flagIsMine
      ? userId === match.player1Id
        ? match.player2Id
        : match.player1Id
      : userId;

    // Append the flag + mirror legacy scalars, then resolve terminally
    // inside the same tx (same race pattern as applyPick's mine path).
    const allPicks = Array.isArray(match.picks)
      ? [...match.picks, flagEntry]
      : [flagEntry];
    const setValues = {
      picks: allPicks,
      ...mirrorPickSetValues(allPicks),
    };

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
      // Lost the race to a concurrent safe-pick advance; resolve on the
      // FRESH row with the flag entry merged onto its picks so the
      // rounds row + result never drop the deciding flag.
      const [refreshed] = await tx
        .select()
        .from(minesPvpMatches)
        .where(eq(minesPvpMatches.id, match.id));
      const merged = refreshed || match;
      const mergedPicks = Array.isArray(merged.picks)
        ? [...merged.picks, flagEntry]
        : [flagEntry];
      return await resolveMatch(
        tx,
        { ...merged, picks: mergedPicks },
        loserId,
      );
    }

    return await resolveMatch(tx, updated, loserId);
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
async function resolveMatch(tx, match, loserId) {
  if (!loserId) {
    // Defensive: shouldn't be called without a loserId. The legacy
    // two-pick DRAW flow used `match.p1Pick == null || match.p2Pick
    // == null` as a no-resolve guard; the new odds flow requires
    // an explicit loserId to know who's the loser.
    return match;
  }

  const result = decideOutcome({
    loserId,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
  });

  const payout = computePayout({
    stakeAmount: match.stakeAmount,
    result,
  });

  // Pick the FIRST pick from each seat for the legacy single-pick
  // columns on `mines_pvp_rounds`. The full chronological history
  // is mirrored onto the new `picks` jsonb column below — that is
  // the source of truth for replays.
  const picks = Array.isArray(match.picks) ? match.picks : [];
  const firstP1Pick = picks.find((p) => p?.seat === "player1") ?? null;
  const firstP2Pick = picks.find((p) => p?.seat === "player2") ?? null;

  // Persist the per-match history snapshot FIRST so the history
  // always reflects the final board + outcome + full pick
  // chronology.
  await tx.insert(minesPvpRounds).values({
    matchId: match.id,
    roundNumber: 1,
    p1Pick: firstP1Pick ? firstP1Pick.cell : null,
    p2Pick: firstP2Pick ? firstP2Pick.cell : null,
    p1PickIsMine: firstP1Pick ? Boolean(firstP1Pick.isMine) : null,
    p2PickIsMine: firstP2Pick ? Boolean(firstP2Pick.isMine) : null,
    p1AutoPicked: firstP1Pick ? Boolean(firstP1Pick.autoPicked) : false,
    p2AutoPicked: firstP2Pick ? Boolean(firstP2Pick.autoPicked) : false,
    boardSnapshot: match.board ?? { size: 5, mines: [] },
    picks,
    roundWinner: result,
  });

  // Apply balance changes. Only two outcomes in the new flow
  // (PLAYER1 or PLAYER2); never a DRAW.
  const winnerId =
    result === RESULT.PLAYER1 ? match.player1Id : match.player2Id;
  await tx
    .update(users)
    .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
    .where(eq(users.clerkId, winnerId));

  // Stamp the match as finished. The `board` column stays on the
  // row so the post-match reveal screen can render the full mine
  // layout (the /status route stops scrubbing it once
  // status='finished').
  const [updated] = await tx
    .update(minesPvpMatches)
    .set({
      status: MATCH_STATUS.FINISHED,
      currentTurnUserId: null,
      roundDeadline: null,
      result,
      winnerId,
      houseFee: payout.houseFee.toFixed(2),
      prizePaid: payout.prizePaid.toFixed(2),
      endedAt: new Date(),
    })
    .where(eq(minesPvpMatches.id, match.id))
    .returning();

  const finalRow = updated || match;

  // Best-effort stat side-effects (failures don't roll the match).
  await recordPvPResult(tx, finalRow, winnerId, result).catch(() => {});

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
