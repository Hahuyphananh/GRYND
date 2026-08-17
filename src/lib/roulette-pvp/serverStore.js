// src/lib/roulette-pvp/serverStore.js
//
// Server-side canonical helpers for the Roulette PvP match system.
//
// Why a dedicated serverStore:
//   The match state machine has to be authoritative on the server:
//     * round deadline enforcement (AFK → force empty bets)
//     * spin roll (server rolls, both clients animate to the same result)
//     * round winner calculation (single source of truth)
//     * match advancement + payout crediting
//   Putting this in a tiny module keeps the API routes thin and
//   makes it easy to test the state machine in isolation.
//
// Every state-transitioning call uses a `for("update")` row lock to
// avoid the classic "both players submit at the same time and both
// trigger resolution" race that bites luck-based games. Mirrors
// the precision and coin-flip patterns already in the codebase.

import { eq, and, sql, isNull, gte, lte } from "drizzle-orm";
import { db } from "../../db/client";
import {
  roulettePvpMatches,
  roulettePvpRounds,
  users,
} from "../../db/schema";
import { sendSystemNotificationEmail } from "../emails/system";
import { ROULETTE_NUMBERS } from "../rouletteConfig";
import {
  ACTIVE_STATES,
  BETTABLE_STATES,
  CALL_BONUS,
  ELIMINATION_COST,
  HOUSE_FEE_PCT,
  MATCH_STATUS,
  MAX_ELIMINATIONS_PER_ROUND,
  MAX_SINGLE_BET,
  MAX_TOTAL_BET,
  MIN_LIVE_NUMBERS,
  READY_WINDOW_MS,
  ROUND_BET_DEADLINE_MS,
  ROUND_TIMER_SECONDS,
  STARTING_POINTS,
  calculatePayout,
  generateSpinFromPool,
  isBetKeyLive,
  isValidCallKey,
  resolveCalls,
  resolveRoundSide,
  serverEliminatedNumbers,
  sumBetAmounts,
} from "./constants";

const ROUND_STATUS_BY_NUMBER = {
  1: MATCH_STATUS.ROUND_1,
  2: MATCH_STATUS.ROUND_2,
  3: MATCH_STATUS.ROUND_3,
};

// Helper: derive the per-round deadline duration in ms from a match
// row, falling back to the server-side default if the row's column is
// null/0 (e.g. older rows that pre-date migration 0040). Lets admin
// tooling override per-match pacing via `round_timer_seconds` without
// code changes.
function roundDeadlineMs(match) {
  const t = Number(match?.roundTimerSeconds);
  if (Number.isFinite(t) && t > 0) return t * 1000;
  return ROUND_BET_DEADLINE_MS;
}

// Project-specific namespace constant for the two-key advisory lock
// acquired in `createOrJoin`. Keeps the global pg_advisory_xact_lock
// keyspace partitioned so other features cannot accidentally collide
// with roulette_pvp matchmaking locks. Literal int (ASCII for
// "ROUL": R=0x52, O=0x4F, U=0x55, L=0x4C, packed into the upper 28
// bits) — reviewable and stable across deployments.
const ROULETTE_PVP_LOCK_NAMESPACE = 0x524f554c & 0x7fffffff;

// Map a 1-based `currentRound` to the corresponding match.status enum
// value. Sudden death rounds (>= 4) all map to MATCH_STATUS.SUDDEN_DEATH.
export function statusForRoundNumber(roundNumber) {
  if (roundNumber >= 4) return MATCH_STATUS.SUDDEN_DEATH;
  return ROUND_STATUS_BY_NUMBER[roundNumber] ?? MATCH_STATUS.ROUND_1;
}

// ── Lobby helpers ──────────────────────────────────────────────────────
// Return the open matches available for joining, most recent first.
export async function listOpenMatches({ limit = 30 } = {}) {
  return db
    .select({
      id: roulettePvpMatches.id,
      player1Id: roulettePvpMatches.player1Id,
      stakeAmount: roulettePvpMatches.stakeAmount,
      createdAt: roulettePvpMatches.createdAt,
    })
    .from(roulettePvpMatches)
    .where(
      and(
        eq(roulettePvpMatches.status, MATCH_STATUS.WAITING),
        isNull(roulettePvpMatches.player2Id),
      ),
    )
    .orderBy(sql`${roulettePvpMatches.createdAt} DESC`)
    .limit(limit);
}

// ── Create / Join matchmaking ──────────────────────────────────────────
//
// Single-transaction matchmaking with two layers of protection:
//
//   1. Postgres `pg_advisory_xact_lock` keyed on a stable hash of
//      (stake_amount) serialises every concurrent matchmaker for the
//      same stake across all workers/connections. Without this, two
//      matchmakers calling `createOrJoin` concurrently for the same
//      stake could both observe "no open match" and both INSERT a
//      fresh waiting row, producing a duplicate lobby instead of
//      pairing (the matching SELECT inside the tx alone isn't enough
//      because `FOR UPDATE` only locks rows that already exist — it
//      has nothing to lock when the SELECT returns empty).
//   2. `FOR UPDATE` plus re-fetch inside the same tx, plus a
//      conditional UPDATE filtering on `status='waiting' AND
//      player2_id IS NULL`, catches the "creator cancelled in
//      parallel" race.
export async function createOrJoin({ userId, stakeAmount }) {
  if (!stakeAmount || stakeAmount <= 0) {
    return { error: "Invalid stake amount", status: 400 };
  }

  // Two-key advisory lock: the first int is a project-specific
  // namespace constant so we don't share the global single-int
  // advisory-lock space with anything else in the codebase. The
  // second int is a deterministic 32-bit hash of the stake so
  // distinct stakes don't serialise each other.
  const lockKey = hashStakeToInt(stakeAmount);

  return await db.transaction(async (tx) => {
    // Acquire stake-keyed advisory lock; auto-released on commit/rollback.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ROULETTE_PVP_LOCK_NAMESPACE}, ${lockKey})`,
    );

    // 1) Look for an existing open match with matching stake.
    const [openMatch] = await tx
      .select()
      .from(roulettePvpMatches)
      .where(
        and(
          eq(roulettePvpMatches.status, MATCH_STATUS.WAITING),
          isNull(roulettePvpMatches.player2Id),
          eq(roulettePvpMatches.stakeAmount, stakeAmount.toFixed(2)),
        ),
      )
      .orderBy(sql`${roulettePvpMatches.createdAt} ASC`)
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

// Stable deterministic hash from numeric stake to a signed 32-bit int.
// Used purely as an advisory-lock key; collisions on distinct stakes
// would only cause the matchmaking to briefly serialise (no
// correctness risk).
function hashStakeToInt(stake) {
  const fixed = stake.toFixed(2);
  let h = 2166136261;
  for (let i = 0; i < fixed.length; i++) {
    h ^= fixed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h | 0) & 0x7fffffff;
}

async function createWaitingMatch(tx, userId, stakeAmount) {
  // Deduct stake
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

  // Both players start the match with exactly STARTING_POINTS (100)
  // match-currency credits. Points persist across rounds: every round's
  // (payout − total_bet) is debited/credited from this column directly.
  const starting = STARTING_POINTS.toFixed(2);
  const [match] = await tx
    .insert(roulettePvpMatches)
    .values({
      player1Id: userId,
      stakeAmount: stakeAmount.toFixed(2),
      status: MATCH_STATUS.WAITING,
      currentRound: 1,
      startingPoints: starting,
      playerOnePoints: starting,
      playerTwoPoints: starting,
      roundTimerSeconds: ROUND_TIMER_SECONDS,
      suddenDeath: false,
    })
    .returning();

  // Fire system notification for large PvP create stakes
  if (Number(stakeAmount) >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `User ${userId} created roulette PvP lobby (${stakeAmount} stake).`,
      metadata: { userId, stakeAmount, matchId: match.id },
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
    .from(roulettePvpMatches)
    .where(eq(roulettePvpMatches.id, candidateId))
    .for("update");

  // Bail out cleanly if the candidate was cancelled (or otherwise
  // mutated away from `waiting`) while we were waiting on the lock.
  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Lobby no longer available", status: 409 };
  }

  // Deduct joiner's stake (atomically: only if balance is sufficient).
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
  // match-found banner before round_1's 25-second betting window
  // starts. /status auto-advances to round_1 once the deadline passes
  // (see advanceFromReady).
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(roulettePvpMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.READY,
      currentRound: 1,
      roundDeadline: readyDeadline,
      startedAt: new Date(),
    })
    .where(
      and(
        eq(roulettePvpMatches.id, candidateId),
        // Defensive guard: only update if status is still `waiting`
        // and player2Id is still null when we commit.
        eq(roulettePvpMatches.status, MATCH_STATUS.WAITING),
        isNull(roulettePvpMatches.player2Id),
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

// Auto-advance `ready → round_1`. Called from fetchMatchWithAutoResolve
// when the ready deadline elapses. Does NOT generate a spin or insert
// a round record — that's the user's job once they start betting.
async function advanceFromReady(tx, match) {
  const deadline = new Date(Date.now() + roundDeadlineMs(match));
  // Conditional UPDATE so concurrent /status polls from both players
  // serialise: only the first one's UPDATE lands, the second one's
  // `where(eq(status, 'ready'))` filter fails (already round_1).
  await tx
    .update(roulettePvpMatches)
    .set({
      status: MATCH_STATUS.ROUND_1,
      roundDeadline: deadline,
      player1Bets: null,
      player2Bets: null,
      // Skill layer: round 1 never eliminates (revealed empty set).
      serverEliminated: [],
    })
    .where(
      and(
        eq(roulettePvpMatches.id, match.id),
        eq(roulettePvpMatches.status, MATCH_STATUS.READY),
      ),
    );
  // Re-SELECT after the conditional UPDATE so we never return stale
  // state. If the conditional UPDATE didn't land for THIS tx (another
  // concurrent tx already advanced), the SELECT reflects the new
  // state committed by that other tx.
  const [refreshed] = await tx
    .select()
    .from(roulettePvpMatches)
    .where(eq(roulettePvpMatches.id, match.id));
  return refreshed || match;
}

// ── Cancel (creator only, while in waiting) ────────────────────────────
export async function cancelMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(roulettePvpMatches)
      .where(eq(roulettePvpMatches.id, matchId))
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

    // Refund creator stake
    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
      })
      .where(eq(users.clerkId, userId));

    const [updated] = await tx
      .update(roulettePvpMatches)
      .set({
        status: MATCH_STATUS.CANCELLED,
        endedAt: new Date(),
      })
      .where(eq(roulettePvpMatches.id, matchId))
      .returning();

    return { match: updated };
  });
}

// ── Fetch match with row lock (for atomic operations) ─────────────────
async function fetchMatchForUpdate(tx, matchId) {
  const [match] = await tx
    .select()
    .from(roulettePvpMatches)
    .where(eq(roulettePvpMatches.id, matchId))
    .for("update");
  return match;
}

// ── Game-side validation helpers ──────────────────────────────────────

export function isParticipant(match, userId) {
  return match && (match.player1Id === userId || match.player2Id === userId);
}

// ── Skill-layer helpers (elimination market + live pool) ───────────────
// Numbers the server killed for the current round. Non-array / null rows
// (pre-migration or round 1) are treated as an empty set.
function serverEliminatedFor(match) {
  return Array.isArray(match?.serverEliminated)
    ? match.serverEliminated.map((n) => String(n))
    : [];
}

// Player-bought removals for the current round: { "17": "player1" }.
function eliminationsFor(match) {
  return match?.eliminations && typeof match.eliminations === "object"
    ? match.eliminations
    : {};
}

// The full set of dead number keys (strings) for the current round.
export function deadKeysFor(match) {
  const dead = new Set(serverEliminatedFor(match));
  for (const k of Object.keys(eliminationsFor(match))) dead.add(k);
  return dead;
}

// The numbers the current round's spin can land on (full wheel minus
// server eliminations minus player-bought removals).
export function livePoolNumbers(match) {
  const dead = deadKeysFor(match);
  return ROULETTE_NUMBERS.filter((n) => !dead.has(String(n)));
}

// ── Elimination market (pay points to remove a number) ────────────────
export async function buyElimination({ userId, matchId, number }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (!BETTABLE_STATES.has(match.status)) {
      return { error: "Match is not in an active round", status: 400 };
    }
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      return { error: "Betting window has expired", status: 400 };
    }
    const isPlayer1 = match.player1Id === userId;
    // Board freezes once this player locks in — no removing after commit.
    if (isPlayer1 ? match.player1Bets : match.player2Bets) {
      return {
        error: "Bets already locked for this round",
        status: 409,
      };
    }
    const num = Number(number);
    if (
      !Number.isInteger(num) ||
      num < 0 ||
      num > 36 ||
      !ROULETTE_NUMBERS.includes(num)
    ) {
      return { error: "Invalid number", status: 400 };
    }
    const key = String(num);
    const elims = eliminationsFor(match);
    if (key in elims) {
      return { error: "Number already eliminated", status: 409 };
    }
    if (serverEliminatedFor(match).includes(key)) {
      return {
        error: "Number is already off the wheel this round",
        status: 409,
      };
    }
    const mySide = isPlayer1 ? "player1" : "player2";
    // Anti-griefing: if the OPPONENT already locked a straight-up bet on
    // this exact number, removing it would torch a committed wager with
    // no counterplay. Reject — removing numbers they might bet on is the
    // strategy; removing numbers they HAVE bet on is a scam.
    const oppBets = isPlayer1 ? match.player2Bets : match.player1Bets;
    if (
      oppBets &&
      typeof oppBets === "object" &&
      Number(oppBets[key]) > 0
    ) {
      return {
        error: "Opponent has already locked a bet on that number",
        status: 409,
      };
    }
    const myCount = Object.values(elims).filter((v) => v === mySide).length;
    if (myCount >= MAX_ELIMINATIONS_PER_ROUND) {
      return {
        error: `Maximum ${MAX_ELIMINATIONS_PER_ROUND} eliminations reached this round`,
        status: 400,
      };
    }
    const points = Number(
      isPlayer1 ? match.playerOnePoints : match.playerTwoPoints,
    );
    if (!Number.isFinite(points) || points < ELIMINATION_COST) {
      return {
        error: `You need at least ${ELIMINATION_COST} points to eliminate a number`,
        status: 400,
      };
    }
    const poolSize = ROULETTE_NUMBERS.length - deadKeysFor(match).size;
    if (poolSize - 1 < MIN_LIVE_NUMBERS) {
      return {
        error: `The wheel can't go below ${MIN_LIVE_NUMBERS} live numbers`,
        status: 400,
      };
    }

    const newPoints = (points - ELIMINATION_COST).toFixed(2);
    const [updated] = await tx
      .update(roulettePvpMatches)
      .set({
        eliminations: { ...elims, [key]: mySide },
        ...(isPlayer1
          ? { playerOnePoints: newPoints }
          : { playerTwoPoints: newPoints }),
      })
      .where(
        and(
          eq(roulettePvpMatches.id, matchId),
          // Status guard: reject a stale POST that lands after the round
          // advanced (e.g. AFK auto-resolve) — mirrors submitBets.
          eq(roulettePvpMatches.status, match.status),
        ),
      )
      .returning();
    if (!updated) {
      return {
        error: "Round state changed during eliminate — please refresh",
        status: 409,
      };
    }
    return { match: updated };
  });
}

// Validate the player's staged bets against their CURRENT match
// points balance (not a fixed per-round budget). The persistent
// balance means the cap drifts round-to-round based on prior
// wins/losses — players can never bet more than they currently hold.
// `MAX_SINGLE_BET` / `MAX_TOTAL_BET` (from constants) are also enforced
// here as defence-in-depth against absurd client payloads (NaN /
// Infinity / negative numbers / runaway floats).
export function validateBets(bets, playerPoints, deadKeys) {
  if (!bets || typeof bets !== "object") {
    return { ok: false, error: "Bets must be a JSON object" };
  }
  const total = sumBetAmounts(bets);
  const cap = Number(playerPoints);
  if (!Number.isFinite(cap) || cap < 0) {
    return { ok: false, error: "Invalid match-current points balance" };
  }
  // Skill layer: no betting on dead numbers. A single-number key on an
  // eliminated number is rejected outright; a group key (red/dozen/…)
  // whose every member number is dead is rejected too (it could only
  // ever lose).
  if (deadKeys && deadKeys.size > 0) {
    for (const k of Object.keys(bets)) {
      const isSingleNumber =
        /^\d+$/.test(k) && Number(k) >= 0 && Number(k) <= 36;
      if (isSingleNumber && deadKeys.has(k)) {
        return {
          ok: false,
          error: `Number ${k} has been eliminated from the wheel`,
        };
      }
      if (!isSingleNumber && !isBetKeyLive(k, deadKeys)) {
        return {
          ok: false,
          error: `${k} is fully eliminated this round`,
        };
      }
    }
  }
  if (total > MAX_TOTAL_BET + 0.0001) {
    return {
      ok: false,
      error: `Total bets (${total.toFixed(2)}) exceed maximum allowed (${MAX_TOTAL_BET.toFixed(2)})`,
    };
  }
  for (const [k, v] of Object.entries(bets)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > MAX_SINGLE_BET + 0.0001) {
      return {
        ok: false,
        error: `Bet ${k} of ${n.toFixed(2)} exceeds single-bet maximum (${MAX_SINGLE_BET.toFixed(2)})`,
      };
    }
  }
  if (total > cap + 0.0001) {
    return {
      ok: false,
      error: `Total bets (${total.toFixed(
        2,
      )}) exceed current match points (${cap.toFixed(2)})`,
    };
  }
  return { ok: true };
}

// ── Place bets for current round ──────────────────────────────────────
//
// Stores the calling player's bets in the match's jsonb column. If both
// players have now submitted, immediately resolves the round. Otherwise
// returns the updated state and lets the client poll /bet or /status.
//
// Validate-bets cap is the player's CURRENT match balance (not a
// fixed per-round budget). Points persist, so this drifts round-to-
// round based on prior wins/losses.
export async function submitBets({ userId, matchId, bets, call }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);

    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (!BETTABLE_STATES.has(match.status)) {
      return { error: "Match is not in an active round", status: 400 };
    }

    // PROMPT 12 — Anti-cheat deadline guard. `BETTABLE_STATES` only
    // checks the round number / status, not whether the betting
    // window has elapsed. Without this check a malicious client
    // could land a submission in the tiny race window between the
    // deadline passing and `fetchMatchWithAutoResolve` force-
    // submitting empty bets (which itself triggers re-resolution).
    // Reject any submission that arrives after the server-stamped
    // `roundDeadline`.
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      return { error: "Betting window has expired", status: 400 };
    }

    // Caller's CURRENT persistent match points. The cap is the
    // bigger of `match.playerOnePoints` / `match.playerTwoPoints`
    // depending on role. Players can't bet more than they hold.
    const isPlayer1 = match.player1Id === userId;

    // PROMPT 12 — Anti-cheat duplicate-submission guard. The
    // unconditional `update()` would otherwise silently overwrite a
    // previous submission in the same round, which a malicious
    // client could exploit by re-submitting at the last millisecond
    // to scrub payouts after seeing the opponent's bets. Lock-in
    // is one-shot per round per player — the UI's `myBetsAreLocked`
    // hint is mirrored here server-side.
    if (isPlayer1 ? match.player1Bets : match.player2Bets) {
      return {
        error: "Bets already locked for this round",
        status: 409,
      };
    }

    // Skill layer: validate the optional "call their bet" guess before
    // storing anything. The call must be a real bet key with at least
    // one live number (guessing an eliminated number is nonsense).
    let callKey = null;
    if (call !== undefined && call !== null && call !== "") {
      const c = String(call);
      if (!isValidCallKey(c, deadKeysFor(match))) {
        return {
          error: "Call must be a valid bet target that's still on the wheel",
          status: 400,
        };
      }
      callKey = c;
    }

    const currentPoints = Number(
      isPlayer1 ? match.playerOnePoints : match.playerTwoPoints,
    );
    const validation = validateBets(bets, currentPoints, deadKeysFor(match));
    if (!validation.ok) {
      return { error: validation.error, status: 400 };
    }

    // BUG-FIX ("bets locked in, not deducting from player points") ─
    // Previously only `player{N}Bets` was written on lock-in; the
    // `playerOnePoints` / `playerTwoPoints` columns were untouched
    // until `resolveRound` ran. The column was the single source of
    // truth for "what's actually in my match wallet right now", so
    // any process that read `playerOnePoints` directly (admin tools,
    // replays, future spectator mode) saw a stale balance until the
    // round resolved — and when a player AFK'd through the
    // `fetchMatchWithAutoResolve` auto-resolve path, `resolveRound`
    // never re-debited the bet that DID submit (it was never
    // deducted in the first place), so the locker's wallet silently
    // kept the wager. The fix: deduct the bet total HERE so
    // `playerOnePoints`/`playerTwoPoints` is the post-lock balance
    // the moment betting closes. `resolveRound` is updated
    // accordingly to only ADD payouts (no double-deduction).
    const totalLocked = sumBetAmounts(bets);
    const newPoints = (currentPoints - totalLocked).toFixed(2);
    const prevCalls = match.calls && typeof match.calls === "object" ? match.calls : {};
    const updates = isPlayer1
      ? {
          player1Bets: bets,
          playerOnePoints: newPoints,
          ...(callKey
            ? { calls: { ...prevCalls, player1: callKey } }
            : {}),
        }
      : {
          player2Bets: bets,
          playerTwoPoints: newPoints,
          ...(callKey
            ? { calls: { ...prevCalls, player2: callKey } }
            : {}),
        };
    // Guard the UPDATE on the row's current status AND the lock-in
    // state we just verified in-memory: WITHOUT this, a stale POST
    // landing AFTER an AFK auto-resolve (or a parallel resolve
    // triggered by the opponent's commit) would clobber the
    // just-cleared `player1Bets` / `player2Bets` and DOUBLE-debit
    // the points column (the row's status is already past round_1
    // but the previous WHERE used only `id`). The conditional
    // UPDATE returns 0 rows instead, and we surface a clean 409
    // so the UI sees the race honestly.
    const [updated] = await tx
      .update(roulettePvpMatches)
      .set(updates)
      .where(
        and(
          eq(roulettePvpMatches.id, matchId),
          // Status must still be a bettable round; reject stale POSTs
          // that landed after the row advanced (e.g. AFK auto-resolve).
          eq(roulettePvpMatches.status, match.status),
          // Re-assert lock-in state at the SQL layer as belt-and-braces
          // alongside the earlier in-memory duplicate-submission guard.
          isPlayer1
            ? isNull(roulettePvpMatches.player1Bets)
            : isNull(roulettePvpMatches.player2Bets),
        ),
      )
      .returning();

    if (!updated) {
      // Row mutated under us between the FOR UPDATE SELECT and this
      // UPDATE. Re-fetch so we can disambiguate "match vanished" vs
      // "lock-in already happened / round advanced" and return a
      // single, accurate error. Throwing a TypeError on a null pointer
      // here would crash the route and surface a generic 500 — much
      // worse UX than the deliberate 409 below.
      const [fresh] = await tx
        .select()
        .from(roulettePvpMatches)
        .where(eq(roulettePvpMatches.id, matchId));
      if (!fresh) {
        return { error: "Match not found", status: 404 };
      }
      const seatNowLocked = isPlayer1
        ? Boolean(fresh.player1Bets)
        : Boolean(fresh.player2Bets);
      if (seatNowLocked) {
        return {
          error: "Bets already locked for this round",
          status: 409,
        };
      }
      if (!BETTABLE_STATES.has(fresh.status)) {
        return {
          error: "Match is no longer in an active round",
          status: 400,
        };
      }
      // Couldn't bucket the failure — surface it but don't lose the
      // deduction: refund the points by reversing the in-memory math.
      return {
        error: "Betting window state changed during submit — please refresh",
        status: 409,
      };
    }

    // Determine if both players are now ready (have non-null bets).
    const bothReady = updated.player1Bets && updated.player2Bets;

    let resolvedMatch = updated;
    if (bothReady) {
      resolvedMatch = await resolveRound(tx, updated);
    }

    return { match: resolvedMatch, justResolved: bothReady };
  });
}

// ── Resolve the current round ─────────────────────────────────────────
//
// Mutates state: appends a row to `roulette_pvp_rounds`, advances
// `currentRound`/status, possibly transitions to `sudden_death` or
// finishes the match.
//
// Per round, the steps are:
//   1. Generate a spin (server-authoritative)
//   2. Compute each side's total bet, payout, net (payout − bet)
//   3. Determine round winner by higher net; identical net → DRAW
//   4. Update match scores, advance round or finish
export async function resolveRound(tx, match) {
  const slot = match.currentRound;
  const isSuddenDeath =
    match.status === MATCH_STATUS.SUDDEN_DEATH || slot >= 4;
  // Skill layer: the spin is drawn from the LIVE pool — the full wheel
  // minus this round's server eliminations and player-bought removals.
  // Removed numbers can never come up, so eliminations genuinely shift
  // the odds on everything that remains.
  const { spinResultIndex, spinResult } = generateSpinFromPool(
    livePoolNumbers(match),
  );
  const p1 = resolveRoundSide(match.player1Bets || {}, spinResult);
  const p2 = resolveRoundSide(match.player2Bets || {}, spinResult);

  let roundWinner = null;
  if (p1.net > p2.net) roundWinner = "player1";
  else if (p2.net > p1.net) roundWinner = "player2";
  // else: identical net → DRAW → roundWinner stays null

  // Skill layer: resolve each player's "call their bet" guess against
  // the opponent's actual biggest-wager keys. Both can be correct in
  // the same round (net transfers cancel).
  const callResult = resolveCalls(
    match.calls || {},
    match.player1Bets || {},
    match.player2Bets || {},
  );

  // Round-win score is only meaningful in regular rounds 1–3, not in
  // sudden death (the first non-draw sudden-death round ends the
  // match, ignoring accumulated scores). Skip the increment when in
  // sudden death so bookkeeping reflects reality.
  let newScoreP1 = match.scorePlayer1;
  let newScoreP2 = match.scorePlayer2;
  if (!isSuddenDeath) {
    if (roundWinner === "player1") newScoreP1 += 1;
    else if (roundWinner === "player2") newScoreP2 += 1;
  }

  // Insert round-history row (incl. skill-layer snapshot: what was dead
  // this round, who removed what, and the call results).
  await tx.insert(roulettePvpRounds).values({
    matchId: match.id,
    roundNumber: slot,
    isSuddenDeath,
    spinResultIndex,
    spinResult,
    player1Bets: match.player1Bets || {},
    player2Bets: match.player2Bets || {},
    player1TotalBet: p1.totalBet.toFixed(2),
    player2TotalBet: p2.totalBet.toFixed(2),
    player1Payout: p1.payout.toFixed(2),
    player2Payout: p2.payout.toFixed(2),
    player1Net: p1.net.toFixed(2),
    player2Net: p2.net.toFixed(2),
    roundWinner,
    serverEliminated: match.serverEliminated || [],
    eliminations: match.eliminations || {},
    calls: match.calls || {},
    callResults: callResult,
  });

  // Persist match-currency balances. The balance carries between
  // rounds (do NOT reset to starting_points). The wager was
  // already debited at lock-in inside `submitBets` (so the
  // committed `playerOnePoints` / `playerTwoPoints` columns already
  // reflect the deduction by the time we get here) — we only credit
  // the payout on top. Per-round net effect = `+ payout`. Pre-fix
  // the deduction happened here too, which double-counted against
  // the lock-in deduction and silently returned the wager to the
  // player when they AFK'd through the auto-resolve path.
  // The match-level `sudden_death` flag mirrors `is_sudden_death`
  // for fast queries without walking rounds.
  let newP1Points = Number(match.playerOnePoints) + p1.payout;
  let newP2Points = Number(match.playerTwoPoints) + p2.payout;

  // Skill layer: apply call transfers (floored at the payer's balance —
  // a bankrupt payer only hands over what they actually hold).
  if (callResult.player1.correct) {
    const paid = Math.min(CALL_BONUS, Math.max(0, newP2Points));
    newP1Points += paid;
    newP2Points -= paid;
  }
  if (callResult.player2.correct) {
    const paid = Math.min(CALL_BONUS, Math.max(0, newP1Points));
    newP2Points += paid;
    newP1Points -= paid;
  }

  // Decide next match status
  const nextDeadlineMs = roundDeadlineMs(match);
  let nextStatus;
  let nextRound = slot + 1;
  let nextDeadline = null;
  let winnerId = null;
  let prizePaid = "0.00";
  let houseFee = "0.00";
  let result = null;
  // Skill layer: numbers the server kills for the NEXT round (revealed
  // before betting opens). Defaults to the full wheel; mid-game
  // advancement sets the round-2/3 eliminations below.
  let nextServerEliminated = null;

  // PROMPT 7 — Automatic elimination rule. This branch OVERRIDES
  // normal round progression: if either player's persistent
  // match-point balance has dropped to ≤ 0 (spec says "exactly
  // zero"; defensive `<= 0` also catches sub-zero floats from
  // rounding), finish the match immediately, declare the opponent
  // the winner, skip any remaining rounds, and distribute rewards
  // via the existing `creditWinner` house-fee path. `validateBets`
  // already caps wagers at the caller's current balance so this
  // can only fire from an all-in loss the player actually staged.
  const p1Eliminated = newP1Points <= 0;
  const p2Eliminated = newP2Points <= 0;
  if (p1Eliminated || p2Eliminated) {
    // Freeze the round counter at the elimination slot so the
    // match view reflects which round wiped the player out.
    nextRound = slot;
    nextDeadline = null;
    if (p1Eliminated && p2Eliminated) {
      // Degenerate case: both sides wiped out simultaneously
      // (e.g. spin on green at low stacked balances — red AND
      // black bets both lose). House takes no fee: refund both
      // stakes in full and finish with no winner declared.
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
      nextStatus = MATCH_STATUS.FINISHED;
      result = "draw";
    } else {
      // Single-player elimination: the OPPONENT of the wiped side
      // wins the match, regardless of who won this individual
      // round. `creditWinner` debits the standard 2% house fee
      // and credits the winner the net of pot − fee.
      const winningSide = p1Eliminated ? "player2" : "player1";
      const { winner, fee, payout } = await creditWinner(
        tx,
        match,
        winningSide,
      );
      winnerId = winner.winnerId;
      prizePaid = payout.toFixed(2);
      houseFee = fee.toFixed(2);
      nextStatus = MATCH_STATUS.FINISHED;
      result = winningSide;
    }
  } else  if (isSuddenDeath) {
    // PROMPT 9 — Sudden-death continuation rule. Each SD round
    // compares the persistent match-point balances AFTER the spin;
    // the player with strictly more points wins the match
    // immediately. Tied points trigger another SD round with the
    // same 20-second betting window (`roundDeadlineMs(match)`) — no
    // point reset, no score increment (kept for UI bookkeeping),
    // no minimum round cap. Mirrors the slot-3 comparison strategy
    // from Prompt 8 so SD is consistent with the regular end-of-
    // match winner determination.
    if (newP1Points > newP2Points) {
      const { winner, fee, payout } = await creditWinner(
        tx,
        match,
        "player1",
      );
      winnerId = winner.winnerId;
      prizePaid = payout.toFixed(2);
      houseFee = fee.toFixed(2);
      nextStatus = MATCH_STATUS.FINISHED;
      result = "player1";
    } else if (newP2Points > newP1Points) {
      const { winner, fee, payout } = await creditWinner(
        tx,
        match,
        "player2",
      );
      winnerId = winner.winnerId;
      prizePaid = payout.toFixed(2);
      houseFee = fee.toFixed(2);
      nextStatus = MATCH_STATUS.FINISHED;
      result = "player2";
    } else {
      // Tied points → play another sudden death round. The slot
      // counter advances (R4 → R5 → R6…) but status stays
      // SUDDEN_DEATH and the betting flow is unchanged. Sudden death
      // returns to the full wheel (no server eliminations).
      nextStatus = MATCH_STATUS.SUDDEN_DEATH;
      nextDeadline = new Date(Date.now() + nextDeadlineMs);
      nextServerEliminated = [];
    }
  } else if (slot >= 3) {
    // PROMPT 8 — End-of-Round-3 winner is determined by comparing
    // the persistent match-point balances (`newP1Points` /
    // `newP2Points`), NOT the round-win score counter. Whichever
    // side has a strictly higher balance wins the match; tied
    // balances still escalate to sudden death (the next non-draw
    // round ends the match). Round-win scores remain persisted for
    // the UI history panel but are now informational only — the
    // payout path is identical.
    if (newP1Points > newP2Points) {
      const { winner, fee, payout } = await creditWinner(
        tx,
        match,
        "player1",
      );
      winnerId = winner.winnerId;
      prizePaid = payout.toFixed(2);
      houseFee = fee.toFixed(2);
      nextStatus = MATCH_STATUS.FINISHED;
      result = "player1";
    } else if (newP2Points > newP1Points) {
      const { winner, fee, payout } = await creditWinner(
        tx,
        match,
        "player2",
      );
      winnerId = winner.winnerId;
      prizePaid = payout.toFixed(2);
      houseFee = fee.toFixed(2);
      nextStatus = MATCH_STATUS.FINISHED;
      result = "player2";
    } else {
      // Tied points after 3 rounds → sudden death.
      nextStatus = MATCH_STATUS.SUDDEN_DEATH;
      nextDeadline = new Date(Date.now() + nextDeadlineMs);
      nextServerEliminated = [];
    }
  } else {
    // Mid-game (round 1 or 2). Advance to the next regular round with
    // the next round's server eliminations already in place so both
    // players see the revealed dead set before betting opens.
    nextStatus = statusForRoundNumber(nextRound);
    nextDeadline = new Date(Date.now() + nextDeadlineMs);
    nextServerEliminated = serverEliminatedNumbers(
      nextRound,
      nextStatus === MATCH_STATUS.SUDDEN_DEATH,
    );
  }

  const setValues = {
    status: nextStatus,
    currentRound: nextRound,
    scorePlayer1: newScoreP1,
    scorePlayer2: newScoreP2,
    player1Bets: null,
    player2Bets: null,
    // Skill layer: reset the per-round elimination market + calls, and
    // reveal the next round's server eliminations (null for rounds that
    // don't eliminate / terminal states).
    eliminations: null,
    calls: null,
    serverEliminated: nextServerEliminated,
    roundDeadline: nextDeadline,
    lastSpinResultIndex: spinResultIndex,
    lastSpinResult: spinResult,
    // Persistent match-currency balances (NOT reset to starting_points
    // between rounds; this is the deliberate extension requested in
    // Prompt 2).
    playerOnePoints: newP1Points.toFixed(2),
    playerTwoPoints: newP2Points.toFixed(2),
    // Mirror sudden-death flag on the match row for fast status queries.
    suddenDeath: nextStatus === MATCH_STATUS.SUDDEN_DEATH,
  };
  if (winnerId !== null) setValues.winnerId = winnerId;
  if (result !== null) setValues.result = result;
  if (nextStatus === MATCH_STATUS.FINISHED) {
    setValues.prizePaid = prizePaid;
    setValues.houseFee = houseFee;
    setValues.endedAt = new Date();
  }

  const [updated] = await tx
    .update(roulettePvpMatches)
    .set(setValues)
    .where(eq(roulettePvpMatches.id, match.id))
    .returning();

  return updated;
}

// Credit winner's balance (server-side atomic transaction). Returns
// the updated winner user row + the fee + payout numbers so the caller
// can persist them on the match row.
async function creditWinner(tx, match, roundWinner) {
  const totalPot = Number(match.stakeAmount) * 2;
  const fee = Number((totalPot * HOUSE_FEE_PCT).toFixed(2));
  const payout = Number((totalPot - fee).toFixed(2));
  const winnerId =
    roundWinner === "player1" ? match.player1Id : match.player2Id;

  await tx
    .update(users)
    .set({ balance: sql`${users.balance} + ${payout}` })
    .where(eq(users.clerkId, winnerId));

  return { winner: { winnerId }, fee, payout };
}

// ── Status fetch with auto-resolve ─────────────────────────────────────
//
// If the round deadline has expired and both/either player has not
// submitted, force-submit empty bets to ensure forward progress. This
// is the server's "AFK nudge".
export async function fetchMatchWithAutoResolve(userId, matchId) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }

    if (
      ACTIVE_STATES.has(match.status) &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const deadlineElapsed =
        new Date(match.roundDeadline).getTime() <= Date.now();

      // Handle the brief Ready window expiry: both players joined,
      // 3-second auto-advance deadline has passed, advance to round_1.
      if (match.status === MATCH_STATUS.READY && deadlineElapsed) {
        const advanced = await advanceFromReady(tx, match);
        return { match: advanced };
      }

      const eitherMissing =
        !match.player1Bets || !match.player2Bets;
      if (deadlineElapsed && eitherMissing && match.status !== MATCH_STATUS.READY) {
        // Wrap the resolveRound result in `{ match: ... }` so it
        // matches the canonical API-route contract — callers do
        // `result.match` and the API's `normaliseMatch(result.match)`.
        // Pre-fix this returned the raw match object directly; the
        // route then did `result.match === undefined`, which in turn
        // yielded `match: null` on the wire and a confusing "Match
        // not found" UI for the opponent whose poll triggered the AFK
        // auto-resolve on a round that did finish.
        const resolved = await resolveRound(tx, match);
        return { match: resolved };
      }
    }

    return { match };
  });
}

// ── Fetch round history for the match (paginated by round number ASC) ─
export async function fetchMatchRounds(matchId) {
  return db
    .select()
    .from(roulettePvpRounds)
    .where(eq(roulettePvpRounds.matchId, matchId))
    .orderBy(sql`${roulettePvpRounds.roundNumber} ASC`);
}

// ── Lightweighter read for /status (no row lock) ───────────────────────
export async function fetchMatch(matchId) {
  const [match] = await db
    .select()
    .from(roulettePvpMatches)
    .where(eq(roulettePvpMatches.id, matchId));
  return match || null;
}
