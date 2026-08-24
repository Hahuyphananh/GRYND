// src/lib/keno-pvp/serverStore.js
//
// Server-side canonical helpers for the Keno PvP ("Keno Catch Duel")
// match system.
//
// Why a dedicated serverStore (mirrors `src/lib/slots-pvp/serverStore.js`
// + `src/lib/mines-pvp/serverStore.js`): the match state machine has to
// be authoritative on the server:
//   * matchmaking lock (stake-keyed) prevents lobby-race duplicates
//   * both stakes escrowed at create/join so settlement is balance-neutral
//   * the shared draw + glow schedule are server-generated and derived
//     from the server-set round deadline (identical for both)
//   * catches are graded against the server clock (anti-cheat — a
//     client can never self-report a catch; the tap must land inside
//     the tile's 0.8s glow window + a small hidden network grace)
//   * 3-second ready banner auto-advance
//   * round deadlines auto-resolve (scores computed, winner stamped,
//     next round opened) — the game progresses even if both players
//     go AFK
//   * end-state resolution per the first-to-10-points rulebook
//   * 3-minute match clock: at the next round boundary after it
//     expires (nobody at POINTS_TO_WIN), the match enters a 30-second
//     OVERTIME countdown; when it ends the player with the most tiles
//     (highest cumulative score) wins — an overtime tie refunds each
//     player 95% of their stake (5% rake per side)
//   * 90/10 payout split (winner 1.9× stake, house keeps 0.1×)
//
// State machine:
//   waiting → ready → round_1 … round_16 → overtime → finished
//   (waiting/ready/round_N/overtime → cancelled)

import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { kenoPvpMatches, kenoPvpRounds, users } from "../../db/schema";
import { sendSystemNotificationEmail } from "../emails/system";
import {
  ACTIVE_STATES,
  BALL_COUNT,
  KENO_AI_PLAYER_ID,
  KENO_PVP_LOCK_NAMESPACE,
  MATCH_STATUS,
  MATCH_TIME_LIMIT_MS,
  MAX_ROUNDS,
  MAX_STAKE,
  MIN_STAKE,
  OVERTIME_DRAW_FEE_PCT,
  OVERTIME_MS,
  POINTS_TO_WIN,
  READY_WINDOW_MS,
  RESULT,
  ROUND_MS,
  ROUND_STATES,
  ROUND_TIMER_SECONDS,
  computePayout,
  isFreeAiMatch,
  round2,
} from "./constants";
import {
  ballSchedule,
  computeRoundStats,
  decideMatchResult,
  decideRoundWinner,
  generateDraw,
  gradeCatch,
  chooseAiCatchPlan,
} from "./engine";

// ── Helpers ───────────────────────────────────────────────────────────

function roundDeadlineMs(match) {
  const t = Number(match?.roundTimerSeconds);
  if (Number.isFinite(t) && t > 0) return t * 1000;
  return ROUND_MS;
}

// Seat label ("player1" | "player2") for a user in a given match row.
export function seatForUser(match, userId) {
  if (!match || !userId) return null;
  if (match.player1Id === userId) return "player1";
  if (match.player2Id === userId) return "player2";
  return null;
}

export function isParticipant(match, userId) {
  return seatForUser(match, userId) !== null;
}

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

export async function listOpenMatches({ limit = 30 } = {}) {
  return db
    .select({
      id: kenoPvpMatches.id,
      player1Id: kenoPvpMatches.player1Id,
      stakeAmount: kenoPvpMatches.stakeAmount,
      createdAt: kenoPvpMatches.createdAt,
    })
    .from(kenoPvpMatches)
    .where(
      and(
        eq(kenoPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(kenoPvpMatches.player2Id),
      ),
    )
    .orderBy(sql`${kenoPvpMatches.createdAt} DESC`)
    .limit(limit);
}

// ── User enrichment ───────────────────────────────────────────────────

function summariseUsers(rows) {
  const out = {};
  for (const r of rows) {
    if (!r || !r.clerkId) continue;
    out[r.clerkId] = {
      id: r.clerkId,
      displayName: r.displayName || r.clerkId,
      profileImageUrl: r.profileImageUrl || null,
    };
  }
  return out;
}

export async function enrichMatchesWithUsers(matchOrMatches) {
  if (!matchOrMatches) return matchOrMatches;
  const list = Array.isArray(matchOrMatches)
    ? matchOrMatches
    : [matchOrMatches];
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
        profileImageUrl: users.profilePicture,
      })
      .from(users)
      .where(inArray(users.clerkId, Array.from(ids)));
  } catch (err) {
    console.warn(
      "[keno-pvp] enrichMatchesWithUsers: users lookup failed:",
      err && err.message ? err.message : err,
    );
    rows = [];
  }
  const summary = summariseUsers(rows);
  const enrichOne = (m) => {
    if (!m) return m;
    const p1 = m.player1Id ? summary[m.player1Id] || null : null;
    const p2 = m.player2Id ? summary[m.player2Id] || null : null;
    return {
      ...m,
      players: {
        p1:
          p1 ||
          (m.player1Id
            ? { id: m.player1Id, displayName: m.player1Id, missing: true }
            : null),
        p2:
          p2 ||
          (m.player2Id
            ? { id: m.player2Id, displayName: m.player2Id, missing: true }
            : null),
      },
    };
  };
  return Array.isArray(matchOrMatches)
    ? list.map(enrichOne)
    : enrichOne(matchOrMatches);
}

// ── Matchmaking lock helper ───────────────────────────────────────────

function hashStakeToInt(stake) {
  const fixed = Number(stake).toFixed(2);
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < fixed.length; i += 1) {
    h ^= fixed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h | 0) & 0x7fffffff;
}

// ── Create a free human-vs-AI match ───────────────────────────────────
//
// The bot occupies player2. No stake is escrowed; it catches balls from
// the same server-generated stream and is graded by the same clock/window
// rules as a human catch.
export async function createAiMatch({ userId }) {
  if (!userId) return { error: "Unauthorized", status: 401 };

  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .insert(kenoPvpMatches)
      .values({
        player1Id: userId,
        player2Id: KENO_AI_PLAYER_ID,
        stakeAmount: "0.00",
        status: MATCH_STATUS.READY,
        isAi: true,
        currentRound: 1,
        roundsWonPlayer1: 0,
        roundsWonPlayer2: 0,
        p1Score: 0,
        p2Score: 0,
        currentDraw: null,
        p1Catches: null,
        p2Catches: null,
        roundTimerSeconds: ROUND_TIMER_SECONDS,
        roundDeadline: readyDeadline,
        houseFee: "0.00",
        prizePaid: "0.00",
        startedAt: new Date(),
      })
      .returning();
    return { match, joined: true };
  });
}

// Append every AI catch through the same server-clock schedule and
// quality validation used by catchBall. A plan entry that is too early
// or too late is simply a bot miss; it is never written as a fake catch.
async function playAiTurnInTransaction(tx, match) {
  if (!match || !isFreeAiMatch(match) || match.player2Id !== KENO_AI_PLAYER_ID) {
    return { match, actions: 0, alreadyPlayed: true };
  }
  if (!ROUND_STATES.has(match.status) || !match.roundDeadline) {
    return { match, actions: 0, alreadyPlayed: true };
  }

  const schedule = ballSchedule(
    new Date(match.roundDeadline).getTime(),
    Array.isArray(match.currentDraw) ? match.currentDraw : [],
  );
  const plan = chooseAiCatchPlan({
    draw: match.currentDraw,
    roundNumber: match.currentRound,
    seed: `${match.id}:${match.currentRound}`,
  });
  let current = match;
  let actions = 0;
  const now = Date.now();
  const caught = new Set(
    (Array.isArray(current.p2Catches) ? current.p2Catches : [])
      .map((entry) => Number(entry?.number))
      .filter((number) => Number.isInteger(number)),
  );

  for (const planned of plan) {
    if (caught.has(planned.number)) continue;
    const ball = schedule.find((entry) => entry.number === planned.number);
    if (!ball || now < ball.releaseMs + planned.reactionMs || now > ball.acceptedUntilMs) {
      continue;
    }

    const quality = gradeCatch(now, ball);
    if (!quality) continue;
    const catchEntry = {
      number: planned.number,
      quality,
      caughtAt: new Date(now).toISOString(),
    };
    const nextCatches = [
      ...(Array.isArray(current.p2Catches) ? current.p2Catches : []),
      catchEntry,
    ];
    const [updated] = await tx
      .update(kenoPvpMatches)
      .set({ p2Catches: nextCatches })
      .where(
        and(
          eq(kenoPvpMatches.id, current.id),
          eq(kenoPvpMatches.status, current.status),
        ),
      )
      .returning();
    if (!updated) break;
    current = updated;
    caught.add(planned.number);
    actions += 1;
  }

  return { match: current, actions, alreadyPlayed: false };
}

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
// Single-transaction stake-keyed matchmaking (mirrors slots-pvp /
// mines-pvp): pg_advisory_xact_lock on (KENO_PVP_LOCK_NAMESPACE,
// hash(stake)) serialises concurrent matchmakers for the same stake;
// FOR UPDATE + conditional UPDATE catch the "creator cancelled in
// parallel" race.

export async function createOrJoin({ userId, stakeAmount }) {
  const validation = validateMatchParams({ stakeAmount });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }
  if (!userId) {
    return { error: "userId is required", status: 400 };
  }

  const lockKey = hashStakeToInt(stakeAmount);

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${KENO_PVP_LOCK_NAMESPACE}, ${lockKey})`,
    );

    const [openMatch] = await tx
      .select()
      .from(kenoPvpMatches)
      .where(
        and(
          eq(kenoPvpMatches.status, MATCH_STATUS.WAITING),
          isNull(kenoPvpMatches.player2Id),
          eq(kenoPvpMatches.stakeAmount, Number(stakeAmount).toFixed(2)),
        ),
      )
      .orderBy(sql`${kenoPvpMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (openMatch) {
      if (openMatch.player1Id === userId) {
        // Caller's own existing lobby — just return it.
        return { match: openMatch, joined: false };
      }
      return await joinExistingMatch(tx, openMatch.id, userId, stakeAmount);
    }

    return await createWaitingMatch(tx, userId, stakeAmount);
  });
}

async function createWaitingMatch(tx, userId, stakeAmount) {
  const stake = Number(stakeAmount).toFixed(2);

  const [creator] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${stake}` })
    .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${stake}`))
    .returning({ balance: users.balance });

  if (!creator) {
    return { error: "Insufficient balance", status: 400 };
  }

  const [match] = await tx
    .insert(kenoPvpMatches)
    .values({
      player1Id: userId,
      stakeAmount: stake,
      status: MATCH_STATUS.WAITING,
      currentRound: 1,
      roundsWonPlayer1: 0,
      roundsWonPlayer2: 0,
      p1Score: 0,
      p2Score: 0,
      currentDraw: null,
      p1Catches: null,
      p2Catches: null,
      roundTimerSeconds: ROUND_TIMER_SECONDS,
      houseFee: "0.00",
      prizePaid: "0.00",
      startedAt: null,
    })
    .returning();

  if (Number(stakeAmount) >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `User ${userId} created keno PvP lobby (${stakeAmount} stake).`,
      metadata: { userId, stakeAmount, matchId: match.id },
    }).catch(() => {});
  }

  return { match, joined: false };
}

async function joinExistingMatch(tx, candidateId, userId, stakeAmount) {
  const stake = Number(stakeAmount).toFixed(2);

  const [match] = await tx
    .select()
    .from(kenoPvpMatches)
    .where(eq(kenoPvpMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Lobby no longer available", status: 409 };
  }

  const [joiner] = await tx
    .update(users)
    .set({ balance: sql`${users.balance} - ${stake}` })
    .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${stake}`))
    .returning({ balance: users.balance });

  if (!joiner) {
    return { error: "Insufficient balance", status: 400 };
  }

  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(kenoPvpMatches)
    .set({
      player2Id: userId,
      status: MATCH_STATUS.READY,
      roundDeadline: readyDeadline,
      startedAt: new Date(),
    })
    .where(
      and(
        eq(kenoPvpMatches.id, candidateId),
        eq(kenoPvpMatches.status, MATCH_STATUS.WAITING),
        isNull(kenoPvpMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    // Lost a race to a concurrent joiner — refund and bail.
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${stake}` })
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
      .from(kenoPvpMatches)
      .where(eq(kenoPvpMatches.id, matchId))
      .for("update");

    if (!match) return { error: "Match not found", status: 404 };
    if (match.status !== MATCH_STATUS.WAITING) {
      return {
        error: "Match cannot be cancelled after the opponent joins",
        status: 400,
      };
    }
    if (match.player1Id !== userId) {
      return { error: "Only the creator can cancel", status: 403 };
    }

    await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
      })
      .where(eq(users.clerkId, match.player1Id));

    const [updated] = await tx
      .update(kenoPvpMatches)
      .set({ status: MATCH_STATUS.CANCELLED, endedAt: new Date() })
      .where(eq(kenoPvpMatches.id, matchId))
      .returning();

    return { match: updated || match };
  });
}

// ── Row lock + auto-advance plumbing ──────────────────────────────────

async function fetchMatchForUpdate(tx, matchId) {
  const [match] = await tx
    .select()
    .from(kenoPvpMatches)
    .where(eq(kenoPvpMatches.id, matchId))
    .for("update");
  return match;
}

// Open the first round (from the READY banner) or the next round (from
// a resolved round). Generates the shared draw, sets the round deadline
// (= open + ROUND_MS) and clears per-round catches.
async function startRound(tx, match, roundNumber) {
  const now = Date.now();
  const draw = generateDraw();
  const deadline = new Date(now + ROUND_MS);

  const [updated] = await tx
    .update(kenoPvpMatches)
    .set({
      status: statusForRoundNumber(roundNumber),
      currentRound: roundNumber,
      currentDraw: draw,
      p1Catches: [],
      p2Catches: [],
      roundDeadline: deadline,
    })
    .where(eq(kenoPvpMatches.id, match.id))
    .returning();

  return updated || match;
}

function statusForRoundNumber(n) {
  const clamped = Math.max(1, Math.min(MAX_ROUNDS, Number(n) || 1));
  return `round_${clamped}`;
}

// ── Resolve a finished round ──────────────────────────────────────────
//
// Scores both players' catches, stamps the round winner onto a
// keno_pvp_rounds history row, accumulates match scores, and either
// opens the next round, enters the 30s overtime countdown (3-minute
// match clock expired with nobody at POINTS_TO_WIN), or settles the
// match (a player reached POINTS_TO_WIN, or round MAX_ROUNDS just
// completed as a backstop).
async function resolveRound(tx, match) {
  const p1Catches = Array.isArray(match.p1Catches) ? match.p1Catches : [];
  const p2Catches = Array.isArray(match.p2Catches) ? match.p2Catches : [];
  const roundWinner = decideRoundWinner(p1Catches, p2Catches);
  const p1Stats = computeRoundStats(p1Catches);
  const p2Stats = computeRoundStats(p2Catches);

  const roundsWonPlayer1 = (Number(match.roundsWonPlayer1) || 0) +
    (roundWinner === RESULT.PLAYER1 ? 1 : 0);
  const roundsWonPlayer2 = (Number(match.roundsWonPlayer2) || 0) +
    (roundWinner === RESULT.PLAYER2 ? 1 : 0);
  const p1Score = (Number(match.p1Score) || 0) + p1Stats.score;
  const p2Score = (Number(match.p2Score) || 0) + p2Stats.score;

  // History row first so the replay always reflects the final round.
  await tx.insert(kenoPvpRounds).values({
    matchId: match.id,
    roundNumber: Number(match.currentRound) || 1,
    sharedDraw: Array.isArray(match.currentDraw) ? match.currentDraw : [],
    player1Catches: p1Catches,
    player2Catches: p2Catches,
    player1Score: p1Stats.score,
    player2Score: p2Stats.score,
    roundWinner,
  });

  const [updated] = await tx
    .update(kenoPvpMatches)
    .set({
      roundsWonPlayer1,
      roundsWonPlayer2,
      p1Score,
      p2Score,
      currentDraw: null,
      p1Catches: [],
      p2Catches: [],
      roundDeadline: null,
    })
    .where(eq(kenoPvpMatches.id, match.id))
    .returning();

  const next = updated || match;

  const matchOver =
    p1Score >= POINTS_TO_WIN ||
    p2Score >= POINTS_TO_WIN ||
    (Number(next.currentRound) || 1) >= MAX_ROUNDS;

  if (matchOver) {
    return await settleMatch(tx, next);
  }

  // Match clock: once the 3-minute budget (measured from `startedAt`,
  // when the opponent joined) is spent with nobody at POINTS_TO_WIN,
  // don't open another round — enter the 30-second overtime countdown
  // instead. `startedAt` is always set by the time a round is live
  // (set on join); the guard keeps matches without one on the round
  // cap path.
  const startedMs = next.startedAt ? new Date(next.startedAt).getTime() : 0;
  if (startedMs > 0 && Date.now() >= startedMs + MATCH_TIME_LIMIT_MS) {
    return await enterOvertime(tx, next);
  }

  return await startRound(tx, next, (Number(next.currentRound) || 1) + 1);
}

// Enter the 30-second overtime countdown. No new draw is generated —
// catching is closed (overtime is not a ROUND_STATE) and the countdown
// deadline is stamped onto `round_deadline` so both clients render the
// same timer from the match row. `fetchMatchWithAutoResolve` settles
// by most tiles when it expires.
async function enterOvertime(tx, match) {
  const deadline = new Date(Date.now() + OVERTIME_MS);
  const [updated] = await tx
    .update(kenoPvpMatches)
    .set({
      status: MATCH_STATUS.OVERTIME,
      roundDeadline: deadline,
      currentDraw: null,
      p1Catches: [],
      p2Catches: [],
    })
    .where(eq(kenoPvpMatches.id, match.id))
    .returning();
  return updated || match;
}

// ── Settle the match ──────────────────────────────────────────────────
//
// Decide the match result (first-to-10-points rulebook; for an
// overtime settle that means "most tiles wins" — cumulative score is
// monotonic in tiles caught), apply the 90/10 payout (or a refund on
// a DRAW), stamp the row finished and bump the leaderboard
// side-effects. `{ overtime: true }` makes an overtime DRAW refund
// each player 95% of their stake (5% rake per side → 10% total);
// normal draws stay a full refund.
async function settleMatch(tx, match, options = {}) {
  const overtime = Boolean(options && options.overtime);
  const result = decideMatchResult(match);
  const isAi = isFreeAiMatch(match);
  const payout = isAi
    ? { winnerNet: 0, houseFee: 0, prizePaid: 0, refundEach: 0 }
    : computePayout({
        stakeAmount: match.stakeAmount,
        result,
        drawFeePct: overtime && result === RESULT.DRAW ? OVERTIME_DRAW_FEE_PCT : 0,
      });

  let winnerId = null;
  if (result === RESULT.PLAYER1) winnerId = match.player1Id;
  else if (result === RESULT.PLAYER2) winnerId = match.player2Id;

  if (!isAi && result === RESULT.DRAW) {
    // Refund both players — full stake for a normal draw, 95% (5%
    // rake per side) for an overtime tie, per computePayout.
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.refundEach}` })
      .where(eq(users.clerkId, match.player1Id));
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.refundEach}` })
      .where(eq(users.clerkId, match.player2Id));
  } else if (!isAi) {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
      .where(eq(users.clerkId, winnerId));
  }

  const settlement = {
    winnerId,
    result,
    houseFee: payout.houseFee.toFixed(2),
    prizePaid: payout.prizePaid.toFixed(2),
  };

  const [updated] = await tx
    .update(kenoPvpMatches)
    .set({
      status: MATCH_STATUS.FINISHED,
      roundDeadline: null,
      currentDraw: null,
      p1Catches: [],
      p2Catches: [],
      ...settlement,
      endedAt: new Date(),
    })
    .where(eq(kenoPvpMatches.id, match.id))
    .returning();

  const finalRow = updated || match;

  if (!isAi) {
    await recordPvPResult(tx, finalRow, winnerId, result).catch(() => {});
  }

  return finalRow;
}

// Best-effort stat side-effect — mirrors mines-pvp / slots-pvp.
// Bumps pvpWins / gamesWon / gamesLost / totalWon / totalWagered /
// biggestWin on the users rows so the global PvP leaderboards stay
// fresh without re-running aggregate queries.
async function recordPvPResult(tx, match, winnerId, result) {
  if (!winnerId) return;
  const loserId =
    result === RESULT.PLAYER1 ? match.player2Id : match.player1Id;
  if (!loserId) return;

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

// ── catchBall (the main action) ───────────────────────────────────────
//
// Server-authoritative catch action. The client sends the ball NUMBER
// it tapped; the server derives the ball's release window from the
// round deadline, grades the tap against the server clock, and appends
// the catch to the player's per-round catches. A ball can be caught at
// most once per player, and only while its window is open.
export async function catchBall({ userId, matchId, ball }) {
  const ballNumber = Number(ball);
  if (!Number.isInteger(ballNumber) || ballNumber < 1 || ballNumber > 40) {
    return { error: "Invalid ball", status: 400 };
  }

  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);

    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (!ROUND_STATES.has(match.status)) {
      return { error: "Match is not in a catch round", status: 400 };
    }
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      return { error: "Round has ended", status: 409 };
    }

    const draw = Array.isArray(match.currentDraw) ? match.currentDraw : [];
    if (!draw.includes(ballNumber)) {
      return { error: "Ball is not in this round's draw", status: 400 };
    }

    const seat = seatForUser(match, userId);
    const catchesKey = seat === "player1" ? "p1Catches" : "p2Catches";
    const ownCatches = Array.isArray(match[catchesKey])
      ? match[catchesKey]
      : [];
    if (ownCatches.some((c) => c && Number(c.number) === ballNumber)) {
      return { error: "Ball already caught", status: 409 };
    }

    const now = Date.now();
    const deadline = new Date(match.roundDeadline).getTime();
    const schedule = ballSchedule(deadline, draw);
    const ballWindow = schedule.find((b) => b.number === ballNumber);
    if (!ballWindow) {
      return { error: "Ball is not in this round's draw", status: 400 };
    }
    if (now < ballWindow.releaseMs) {
      return { error: "Ball has not been released yet", status: 400 };
    }
    if (now > ballWindow.acceptedUntilMs) {
      return { error: "Ball expired", status: 400 };
    }

    const quality = gradeCatch(now, ballWindow);
    if (!quality) {
      return { error: "Ball not catchable at this instant", status: 400 };
    }

    const catchEntry = {
      number: ballNumber,
      quality,
      caughtAt: new Date(now).toISOString(),
    };
    const nextCatches = [...ownCatches, catchEntry];

    const [updated] = await tx
      .update(kenoPvpMatches)
      .set(
        seat === "player1"
          ? { p1Catches: nextCatches }
          : { p2Catches: nextCatches },
      )
      .where(
        and(
          eq(kenoPvpMatches.id, matchId),
          eq(kenoPvpMatches.status, match.status),
        ),
      )
      .returning();

    if (!updated) {
      return { error: "Round state changed, try again", status: 409 };
    }

    return {
      match: updated,
      catch: catchEntry,
      stats: computeRoundStats(nextCatches),
    };
  });
}

// ── Status fetch with auto-resolve ────────────────────────────────────
//
// Two auto-advance paths, driven by the client polling (the single
// source of forward progress):
//   1. `ready` deadline elapsed → open round 1.
//   2. `round_N` deadline elapsed → resolve the round (score both
//      sides, stamp the winner, open the next round or settle).
export async function fetchMatchWithAutoResolve(userId, matchId) {
  const result = await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }

    let current = match;

    // 1) Ready banner → round 1.
    if (
      current.status === MATCH_STATUS.READY &&
      current.roundDeadline &&
      new Date(current.roundDeadline).getTime() <= Date.now()
    ) {
      current = await startRound(tx, current, 1);
    }

    // 2) Free AI catch recovery: process any planned balls whose
    // server-clock reaction window is currently reachable. The helper
    // writes only through the same catch shape as a human submission.
    if (
      isFreeAiMatch(current) &&
      ROUND_STATES.has(current.status) &&
      current.roundDeadline &&
      new Date(current.roundDeadline).getTime() > Date.now()
    ) {
      const aiResult = await playAiTurnInTransaction(tx, current);
      current = aiResult.match || current;
    }

    // 3) Round deadline elapsed → resolve (and possibly settle).
    if (
      ROUND_STATES.has(current.status) &&
      current.roundDeadline &&
      new Date(current.roundDeadline).getTime() <= Date.now()
    ) {
      current = await resolveRound(tx, current);
    }

    // 4) Overtime countdown elapsed → settle by most tiles (an
    //    overtime tie is a DRAW refunding 95% per player).
    if (
      current.status === MATCH_STATUS.OVERTIME &&
      current.roundDeadline &&
      new Date(current.roundDeadline).getTime() <= Date.now()
    ) {
      current = await settleMatch(tx, current, { overtime: true });
    }

    return { match: current };
  });

  if (result?.match) {
    return { ...result, match: scrubMatchForViewer(result.match, userId) };
  }
  return result;
}

// Scrub server-only state from a match row before sending it to a
// client. The OPPONENT's per-round catches are private until the round
// resolves — the viewer only ever sees their OWN ticket + the shared
// draw (which is identical for both players, so it leaks nothing). A
// non-participant spectator sees neither side's catches.
export function scrubMatchForViewer(match, viewerUserId) {
  if (!match) return match;
  const isFinished = match.status === MATCH_STATUS.FINISHED;
  if (isFinished) {
    return { ...match };
  }
  const viewerIsP1 = Boolean(viewerUserId) && match.player1Id === viewerUserId;
  const viewerIsP2 = Boolean(viewerUserId) && match.player2Id === viewerUserId;
  return {
    ...match,
    p1Catches: viewerIsP1 && Array.isArray(match.p1Catches) ? match.p1Catches : null,
    p2Catches: viewerIsP2 && Array.isArray(match.p2Catches) ? match.p2Catches : null,
  };
}

// ── Round history ─────────────────────────────────────────────────────

export async function fetchMatchRounds(matchId) {
  return db
    .select()
    .from(kenoPvpRounds)
    .where(eq(kenoPvpRounds.matchId, matchId))
    .orderBy(sql`${kenoPvpRounds.roundNumber} ASC`);
}

// ── Cancel / forfeit on disconnect ────────────────────────────────────

export async function forfeitMatch({ loserClerkId, matchId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };

    // No opponent yet — cancel + refund the creator.
    if (match.status === MATCH_STATUS.WAITING) {
      if (match.player1Id !== loserClerkId) {
        return { error: "Only the creator can cancel", status: 403 };
      }
      await tx
        .update(users)
        .set({
          balance: sql`${users.balance} + ${Number(match.stakeAmount)}`,
        })
        .where(eq(users.clerkId, loserClerkId));
      const [updated] = await tx
        .update(kenoPvpMatches)
        .set({ status: MATCH_STATUS.CANCELLED, endedAt: new Date() })
        .where(eq(kenoPvpMatches.id, matchId))
        .returning();
      return { match: updated || match, cancelled: true };
    }

    // Already terminal — idempotent no-op.
    if (!ACTIVE_STATES.has(match.status)) {
      return { match, alreadyTerminal: true };
    }
    if (match.player1Id !== loserClerkId && match.player2Id !== loserClerkId) {
      return { error: "Caller is not a participant", status: 403 };
    }

    const loserIsP1 = match.player1Id === loserClerkId;
    const winnerUserId = loserIsP1 ? match.player2Id : match.player1Id;

    // The OPPONENT wins the match outright. Their cumulative score is
    // forced to POINTS_TO_WIN so decideMatchResult picks them; then the
    // standard 90/10 payout applies.
    const tallies = {
      roundsWonPlayer1: loserIsP1 ? 0 : 1,
      roundsWonPlayer2: loserIsP1 ? 1 : 0,
      p1Score: loserIsP1 ? 0 : POINTS_TO_WIN,
      p2Score: loserIsP1 ? POINTS_TO_WIN : 0,
    };
    const result = decideMatchResult(tallies);
    const isAi = isFreeAiMatch(match);
    const payout = isAi
      ? { winnerNet: 0, houseFee: 0, prizePaid: 0 }
      : computePayout({
          stakeAmount: match.stakeAmount,
          result,
        });

    if (!isAi) {
      await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
        .where(eq(users.clerkId, winnerUserId));
    }

    const settlement = {
      winnerId: winnerUserId,
      result,
      houseFee: payout.houseFee.toFixed(2),
      prizePaid: payout.prizePaid.toFixed(2),
    };

    const [updated] = await tx
      .update(kenoPvpMatches)
      .set({
        status: MATCH_STATUS.FINISHED,
        ...tallies,
        roundDeadline: null,
        currentDraw: null,
        p1Catches: [],
        p2Catches: [],
        ...settlement,
        endedAt: new Date(),
      })
      .where(eq(kenoPvpMatches.id, matchId))
      .returning();

    const finalRow = updated || match;

    // Record AFTER the row update so the stat side-effect sees the
    // freshly stamped prizePaid (mirrors settleMatch).
    if (!isAi) {
      await recordPvPResult(tx, finalRow, winnerUserId, result).catch(() => {});
    }

    return { match: finalRow, forfeited: true };
  });
}

// ── Raw read (no auto-resolve) ────────────────────────────────────────

export async function fetchMatch(matchId) {
  const [match] = await db
    .select()
    .from(kenoPvpMatches)
    .where(eq(kenoPvpMatches.id, matchId));
  return match || null;
}

// Re-exports so routes/tests use one rounding helper + one source of
// truth for the first-to-10-points shape.
export { round2 };
export { BALL_COUNT, MAX_ROUNDS, POINTS_TO_WIN };
