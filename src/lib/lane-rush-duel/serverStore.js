// src/lib/lane-rush-duel/serverStore.js
//
// Server-side canonical helpers for the "Lane Rush Duel" match
// system. Mirrors `src/lib/mines-pvp/serverStore.js` so the lobby +
// match flow shares the same architecture:
//   * matchmaking lock (stake-keyed) prevents lobby-race duplicates
//   * host-picked difficulty is locked at lobby creation; joiner
//     gets the same difficulty
//   * server randomizes the turn order at match creation
//   * each player's provably-fair tower (bad tile per lane) is
//     generated server-side from a shared server seed + their own
//     client seed
//   * 3-second ready banner auto-advance
//   * turn enforcement (only the player whose turn it is can act)
//   * 20-second pick-window auto-pick (AFK → random tile, which may
//     be the bad tile — that's the punishment for going AFK)
//   * end-state resolution: bust / completed / both-held
//   * 90/10 payout split (winner gets 1.9× stake, house keeps 0.1×)
//   * towers + server seed hidden from clients until match finishes
//
// State machine:
//   waiting → ready → p1_turn → p2_turn → finished
//   (waiting/ready/active → cancelled)
//
// Turn progression: after a safe pick, the turn passes to the
// opponent UNLESS the opponent is already done (held or completed) —
// in that case the active player keeps climbing alone until they
// hold, complete, or bust.

import { eq, and, sql, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { laneRushDuelMatches, users } from "../../db/schema";
import { sendSystemNotificationEmail } from "../emails/system";
import { randomHex } from "../laneRunner";
import {
  ACTIVE_STATES,
  BOT_USER_ID,
  DIFFICULTIES,
  LANE_RUSH_DUEL_LOCK_NAMESPACE,
  MATCH_STATUS,
  MAX_LANES,
  MAX_STAKE,
  MIN_STAKE,
  PICKABLE_STATES,
  READY_WINDOW_MS,
  RESULT,
  RISK_PATH_KEYS,
  RISK_PATHS,
  ROUND_PICK_DEADLINE_MS,
  bothDone,
  buildPlayerTower,
  computePayout,
  decideBotAction,
  decideOutcome,
  isBotMatch,
  isPlayerDone,
  isValidPath,
  laneMultiplier,
  opponentOf,
  pointsForSafePick,
  scoreFromActions,
  seatForUserId,
} from "./constants";
import { getServerSeedHash } from "../laneRunner";

// ── Helpers ───────────────────────────────────────────────────────────

function roundDeadlineMs(match) {
  const t = Number(match?.roundTimerSeconds);
  if (Number.isFinite(t) && t > 0) return t * 1000;
  return ROUND_PICK_DEADLINE_MS;
}

// Stable deterministic hash from numeric stake to a signed 32-bit int
// (FNV-1a, mirrors mines-pvp).
function hashStakeToInt(stake) {
  const fixed = Number(stake).toFixed(2);
  let h = 2166136261;
  for (let i = 0; i < fixed.length; i += 1) {
    h ^= fixed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h | 0) & 0x7fffffff;
}

export function seatForUser(match, userId) {
  return seatForUserId(match, userId) ?? null;
}

export function isParticipant(match, userId) {
  return seatForUser(match, userId) !== null;
}

// Validate stake + difficulty at lobby creation time.
export function validateMatchParams({ stakeAmount, difficulty }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
    return {
      ok: false,
      error: `Stake must be a number in [${MIN_STAKE}, ${MAX_STAKE}]`,
    };
  }
  const diff = String(difficulty || "").toLowerCase();
  if (!DIFFICULTIES[diff]) {
    return { ok: false, error: "Invalid difficulty" };
  }
  return { ok: true };
}

// ── Lobby helpers ─────────────────────────────────────────────────────

// Open (waiting) matches for the casino lobby listing.
export async function listOpenMatches({ limit = 30 } = {}) {
  return db
    .select({
      id: laneRushDuelMatches.id,
      player1Id: laneRushDuelMatches.player1Id,
      stakeAmount: laneRushDuelMatches.stakeAmount,
      difficulty: laneRushDuelMatches.difficulty,
      createdAt: laneRushDuelMatches.createdAt,
    })
    .from(laneRushDuelMatches)
    .where(
      and(
        eq(laneRushDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(laneRushDuelMatches.player2Id),
      ),
    )
    .orderBy(sql`${laneRushDuelMatches.createdAt} DESC`)
    .limit(limit);
}

// ── Create / Join matchmaking ─────────────────────────────────────────
// Single-transaction stake-keyed matchmaking (mirrors mines-pvp):
//   1. pg_advisory_xact_lock keyed on (namespace, hash(stake))
//      serialises concurrent matchmakers for the same stake.
//   2. FOR UPDATE + re-fetch + conditional UPDATE filter on
//      `status='waiting' AND player2_id IS NULL` catches the
//      "creator cancelled in parallel" race.
//
// `difficulty` is REQUIRED at create time and IGNORED at join time —
// the joiner consumes whatever difficulty the host picked.
export async function createOrJoin({ userId, stakeAmount, difficulty, vsBot }) {
  // Test vs Bot practice match — no escrow, no matchmaking. The bot
  // is joined immediately inside the same transaction, so the player
  // goes straight to the ready banner. Stake validation is SKIPPED
  // here (stake is 0 by definition) — only the difficulty is checked,
  // otherwise a zero stake trips `validateMatchParams` and the free
  // practice button errors out with "Stake must be a number in [...]".
  if (vsBot) {
    const diff = String(difficulty || "").toLowerCase();
    if (!DIFFICULTIES[diff]) {
      return { error: "Invalid difficulty", status: 400 };
    }
    return await db.transaction(async (tx) => {
      return await createBotMatch(tx, userId, difficulty);
    });
  }

  const validation = validateMatchParams({ stakeAmount, difficulty });
  if (!validation.ok) {
    return { error: validation.error, status: 400 };
  }

  const lockKey = hashStakeToInt(stakeAmount);

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${LANE_RUSH_DUEL_LOCK_NAMESPACE}, ${lockKey})`,
    );

    const [openMatch] = await tx
      .select()
      .from(laneRushDuelMatches)
      .where(
        and(
          eq(laneRushDuelMatches.status, MATCH_STATUS.WAITING),
          isNull(laneRushDuelMatches.player2Id),
          eq(laneRushDuelMatches.stakeAmount, Number(stakeAmount).toFixed(2)),
        ),
      )
      .orderBy(sql`${laneRushDuelMatches.createdAt} ASC`)
      .limit(1)
      .for("update");

    if (openMatch) {
      // difficulty from joiner is ignored (host already picked).
      if (openMatch.player1Id === userId) {
        return { match: openMatch, joined: false };
      }
      return await joinExistingMatch(tx, openMatch.id, userId, stakeAmount);
    }

    return await createWaitingMatch(tx, userId, stakeAmount, difficulty);
  });
}

async function createWaitingMatch(tx, userId, stakeAmount, difficulty) {
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

  // Shared server seed for BOTH towers (revealed post-match) + the
  // host's own client seed. The match id becomes the nonce once the
  // row exists — the tower is derived after insert so we can use the
  // serial id. The hash is shown pre-match; the seed revealed after.
  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);
  const clientSeed = randomHex(16);

  const [match] = await tx
    .insert(laneRushDuelMatches)
    .values({
      player1Id: userId,
      stakeAmount: Number(stakeAmount).toFixed(2),
      difficulty: String(difficulty).toLowerCase(),
      tilesPerLane: DIFFICULTIES[String(difficulty).toLowerCase()].width,
      status: MATCH_STATUS.WAITING,
      serverSeed,
      serverSeedHash,
      p1ClientSeed: clientSeed,
      roundTimerSeconds: 20,
      startedAt: null,
    })
    .returning();

  // Derive the host's tower with the match id as nonce — provably
  // fair and locked before any joiner arrives. Shape: per lane, the
  // bad tile for each risk path (see constants.buildPlayerTower).
  const p1Tower = buildPlayerTower({
    serverSeed,
    clientSeed,
    nonce: match.id,
    difficulty: match.difficulty,
  });

  const [withTower] = await tx
    .update(laneRushDuelMatches)
    .set({ p1Tower })
    .where(eq(laneRushDuelMatches.id, match.id))
    .returning();

  if (Number(stakeAmount) >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `User ${userId} created Lane Rush Duel lobby (${stakeAmount} stake, ${match.difficulty}).`,
      metadata: { userId, stakeAmount, difficulty: match.difficulty, matchId: match.id },
    }).catch(() => {});
  }

  return { match: withTower || match, joined: false };
}

async function joinExistingMatch(tx, candidateId, userId, stakeAmount) {
  const [match] = await tx
    .select()
    .from(laneRushDuelMatches)
    .where(eq(laneRushDuelMatches.id, candidateId))
    .for("update");

  if (!match || match.status !== MATCH_STATUS.WAITING || match.player2Id) {
    return { error: "Lobby no longer available", status: 409 };
  }

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

  // The joiner's own client seed + tower (derived with the shared
  // server seed + match id as nonce).
  const clientSeed = randomHex(16);
  const p2Tower = buildPlayerTower({
    serverSeed: match.serverSeed,
    clientSeed,
    nonce: match.id,
    difficulty: match.difficulty,
  });

  const firstPlayerId = Math.random() < 0.5 ? match.player1Id : userId;
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      player2Id: userId,
      p2ClientSeed: clientSeed,
      p2Tower,
      status: MATCH_STATUS.READY,
      firstPlayerId,
      currentTurnUserId: null,
      roundDeadline: readyDeadline,
      startedAt: new Date(),
    })
    .where(
      and(
        eq(laneRushDuelMatches.id, candidateId),
        eq(laneRushDuelMatches.status, MATCH_STATUS.WAITING),
        isNull(laneRushDuelMatches.player2Id),
      ),
    )
    .returning();

  if (!updated) {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${stakeAmount}` })
      .where(eq(users.clerkId, userId));
    return { error: "Lobby no longer available", status: 409 };
  }

  return { match: updated, joined: true };
}

// ── Test vs Bot practice match ────────────────────────────────────────
// Creates a zero-stake match with the reserved bot id in seat 2. No
// balance is escrowed, the ready banner starts immediately, and the
// first player is rolled (bot or human) exactly like a real match.
// The bot's tower uses its own client seed, so the provably-fair
// reveal still works.
async function createBotMatch(tx, userId, difficulty) {
  const diff = String(difficulty).toLowerCase();
  const config = DIFFICULTIES[diff];

  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);
  const clientSeed = randomHex(16);
  const botClientSeed = randomHex(16);

  const [match] = await tx
    .insert(laneRushDuelMatches)
    .values({
      player1Id: userId,
      player2Id: BOT_USER_ID,
      stakeAmount: "0.00",
      difficulty: diff,
      tilesPerLane: config.width,
      status: MATCH_STATUS.READY,
      serverSeed,
      serverSeedHash,
      p1ClientSeed: clientSeed,
      p2ClientSeed: botClientSeed,
      firstPlayerId: Math.random() < 0.5 ? userId : BOT_USER_ID,
      currentTurnUserId: null,
      roundDeadline: new Date(Date.now() + READY_WINDOW_MS),
      roundTimerSeconds: 20,
      startedAt: new Date(),
    })
    .returning();

  const p1Tower = buildPlayerTower({
    serverSeed,
    clientSeed,
    nonce: match.id,
    difficulty: diff,
  });
  const p2Tower = buildPlayerTower({
    serverSeed,
    clientSeed: botClientSeed,
    nonce: match.id,
    difficulty: diff,
  });

  const [withTowers] = await tx
    .update(laneRushDuelMatches)
    .set({ p1Tower, p2Tower })
    .where(eq(laneRushDuelMatches.id, match.id))
    .returning();

  return { match: withTowers || match, joined: true };
}

// ── Bot turn executor ────────────────────────────────────────────────
// Triggered by the client (mirrors dice-duel's /ai-turn pattern) when
// it's the bot's turn. Runs `decideBotAction` and applies the move
// through the exact same advance/resolve paths as a human, so the
// bot busts / completes / draws exactly like a real player would.
export async function botAct({ matchId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);

    if (!match) return { error: "Match not found", status: 404 };
    if (!PICKABLE_STATES.has(match.status)) {
      return { error: "Match is not awaiting an action", status: 400 };
    }
    if (match.currentTurnUserId !== BOT_USER_ID) {
      return { error: "Not the bot's turn", status: 409 };
    }
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      // Deadline already elapsed — let the AFK auto-pick path in
      // fetchMatchWithAutoResolve handle it (random tile, may bust).
      return { error: "Action window has expired", status: 409 };
    }

    const decision = decideBotAction(match);
    if (!decision) {
      return { error: "Bot cannot act", status: 409 };
    }

    const lane = Number(match.p2Lane) || 0;
    const entry = {
      userId: BOT_USER_ID,
      seat: "player2",
      action: "pick",
      tile: null,
      safe: null,
      lane,
      points: 0,
      autoPicked: false,
      at: new Date().toISOString(),
    };

    if (decision.action === "hold") {
      entry.action = "hold";
      const next = { ...match, p2Held: true };
      if (bothDone(next)) {
        return await resolveByScores(tx, next, entry);
      }
      return await advanceTurn(tx, next, "player2", entry);
    }

    // pick — with the bot's chosen risk path.
    const pathKey = decision.path && isValidPath(decision.path)
      ? decision.path
      : "balanced";
    const idx = Number(decision.tileIndex);
    const tower = Array.isArray(match.p2Tower) ? match.p2Tower : [];
    const laneLayout = tower[lane] || {};
    const badTile = Number(laneLayout[pathKey]);
    const didFail = idx === badTile;

    entry.path = pathKey;
    entry.tile = idx;
    entry.safe = !didFail;

    if (didFail) {
      // Bot busted — the human wins.
      return await resolveMatch(tx, match, {
        loserId: BOT_USER_ID,
        reason: "bust",
        action: entry,
      });
    }

    const newLane = lane + 1;
    entry.lane = newLane;
    entry.points = pointsForSafePick(lane, pathKey, match.difficulty);
    const next = { ...match, p2Lane: newLane };

    return await advanceOrResolve(tx, next, "player2", newLane, false, entry);
  });
}

// ── Cancel (creator only, while in waiting) ───────────────────────────

export async function cancelMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(laneRushDuelMatches)
      .where(eq(laneRushDuelMatches.id, matchId))
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

    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${Number(match.stakeAmount)}` })
      .where(eq(users.clerkId, userId));

    const [updated] = await tx
      .update(laneRushDuelMatches)
      .set({ status: MATCH_STATUS.CANCELLED, endedAt: new Date() })
      .where(eq(laneRushDuelMatches.id, matchId))
      .returning();

    return { match: updated };
  });
}

// ── Match fetch with row lock (for atomic operations) ─────────────────

async function fetchMatchForUpdate(tx, matchId) {
  const [match] = await tx
    .select()
    .from(laneRushDuelMatches)
    .where(eq(laneRushDuelMatches.id, matchId))
    .for("update");
  return match || null;
}

// ── Act: pick a tile or hold ──────────────────────────────────────────
// The core turn action. `action` is "pick" (with path + tileIndex),
// "flag" (call a tile as the bad one — with path + tileIndex) or
// "hold". Validates participant / pickable state / turn / deadline,
// then applies the action and either advances the turn or resolves
// the match inside the same transaction.
export async function act({ userId, matchId, action, path, tileIndex }) {
  const actAction = String(action || "");
  if (actAction !== "pick" && actAction !== "hold" && actAction !== "flag") {
    return { error: "Invalid action", status: 400 };
  }

  // pick + flag both need a validated risk path + tile index.
  let idx = null;
  let pathKey = null;
  if (actAction === "pick" || actAction === "flag") {
    pathKey = String(path || "");
    if (!isValidPath(pathKey)) {
      return { error: "Invalid risk path", status: 400 };
    }
    idx = Number(tileIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return { error: "Invalid tile index", status: 400 };
    }
  }

  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);

    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (!PICKABLE_STATES.has(match.status)) {
      return { error: "Match is not awaiting an action", status: 400 };
    }
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      return { error: "Action window has expired", status: 400 };
    }
    if (match.currentTurnUserId !== userId) {
      return { error: "It is not your turn", status: 403 };
    }

    const seat = seatForUser(match, userId);
    const lane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;

    // A player who is done (held or completed) can never act again.
    if (isPlayerDone(lane, seat === "player1" ? match.p1Held : match.p2Held)) {
      return { error: "You have already banked", status: 400 };
    }

    if (actAction === "hold") {
      return await applyHold(tx, match, userId, seat);
    }

    const tower =
      seat === "player1"
        ? Array.isArray(match.p1Tower)
          ? match.p1Tower
          : []
        : Array.isArray(match.p2Tower)
          ? match.p2Tower
          : [];
    const laneLayout = tower[lane] || {};
    const tilesInPath = RISK_PATHS[pathKey].tiles;
    if (idx >= tilesInPath) {
      return { error: "Invalid tile index", status: 400 };
    }
    const badTile = Number(laneLayout[pathKey]);

    // ── flag: call the bad tile ──
    if (actAction === "flag") {
      const flagCorrect = idx === badTile;
      const entry = {
        userId,
        seat,
        action: "flag",
        path: pathKey,
        tile: idx,
        flagCorrect,
        lane,
        autoPicked: false,
        at: new Date().toISOString(),
      };
      // Correct flag → you deduced it, you win. Wrong → you lose.
      const loserId = flagCorrect
        ? opponentOf(match, userId)
        : userId;
      return await resolveMatch(tx, match, {
        loserId,
        reason: "flag",
        action: entry,
      });
    }

    // ── pick ──
    const didFail = idx === badTile;
    if (didFail) {
      // Bust — terminal, the other player wins.
      return await resolveMatch(tx, match, {
        loserId: userId,
        reason: "bust",
        action: {
          userId,
          seat,
          action: "pick",
          path: pathKey,
          tile: idx,
          safe: false,
          lane,
          points: 0,
          autoPicked: false,
          at: new Date().toISOString(),
        },
      });
    }

    // Safe pick — advance the lane and score points.
    const newLane = lane + 1;
    const points = pointsForSafePick(lane, pathKey, match.difficulty);
    const entry = {
      userId,
      seat,
      action: "pick",
      path: pathKey,
      tile: idx,
      safe: true,
      lane: newLane,
      points,
      autoPicked: false,
      at: new Date().toISOString(),
    };

    return await advanceOrResolve(tx, match, seat, newLane, false, entry);
  });
}

async function applyHold(tx, match, userId, seat) {
  const lane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;
  const entry = {
    userId,
    seat,
    action: "hold",
    lane,
    autoPicked: false,
    at: new Date().toISOString(),
  };

  const next = {
    ...match,
    [seat === "player1" ? "p1Held" : "p2Held"]: true,
  };

  if (bothDone(next)) {
    return await resolveByScores(tx, next, entry);
  }

  return await advanceTurn(tx, next, seat, entry);
}

// ── Advance the turn or resolve after a safe pick / hold ─────────────
// Shared by manual picks, holds, AFK force-picks, and the bot.
async function advanceOrResolve(tx, match, seat, newLane, held, entry) {
  const next = {
    ...match,
    [seat === "player1" ? "p1Lane" : "p2Lane"]: newLane,
    [seat === "player1" ? "p1Held" : "p2Held"]: held,
  };

  // Completing the tower is an instant win — no one can climb higher.
  if (newLane >= MAX_LANES) {
    const completerId =
      seat === "player1" ? match.player1Id : match.player2Id;
    return await resolveMatch(tx, next, {
      loserId: opponentOf(match, completerId),
      reason: "completed",
      action: entry,
    });
  }

  if (bothDone(next)) {
    return await resolveByScores(tx, next, entry);
  }

  return await advanceTurn(tx, next, seat, entry);
}

// ── Advance the turn ──────────────────────────────────────────────────
// `next` is the full post-action match state (already carries the
// actor's updated lane/hold flags). After a safe pick: the opponent
// picks next UNLESS they are already done (held/completed) — then the
// active player keeps climbing alone. After a hold: the opponent
// always gets the chance to climb past (a hold never ends the match
// by itself unless the opponent is already done, which resolveByLanes
// handles before this is reached).
async function advanceTurn(tx, next, lastSeat, entry) {
  const lastUserId =
    lastSeat === "player1" ? next.player1Id : next.player2Id;
  const otherUserId = opponentOf(next, lastUserId);
  const otherSeat = otherUserId === next.player1Id ? "player1" : "player2";
  const otherDone = isPlayerDone(
    Number(otherSeat === "player1" ? next.p1Lane : next.p2Lane) || 0,
    Boolean(otherSeat === "player1" ? next.p1Held : next.p2Held),
  );

  // If the other player is done, the actor keeps climbing alone.
  const nextUserId = otherDone ? lastUserId : otherUserId;
  const nextSeat =
    nextUserId === next.player1Id ? "player1" : "player2";

  const actions = Array.isArray(next.actions) ? next.actions : [];
  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      p1Lane: next.p1Lane,
      p2Lane: next.p2Lane,
      p1Held: next.p1Held,
      p2Held: next.p2Held,
      status:
        nextSeat === "player1" ? MATCH_STATUS.P1_TURN : MATCH_STATUS.P2_TURN,
      currentTurnUserId: nextUserId,
      roundDeadline: new Date(Date.now() + roundDeadlineMs(next)),
      actions: [...actions, entry],
    })
    .where(
      and(
        eq(laneRushDuelMatches.id, next.id),
        eq(laneRushDuelMatches.status, next.status),
      ),
    )
    .returning();

  return updated || next;
}

// ── Resolve when both players are done (held / completed) ─────────────
// Compare banked SCORES (total points from safe picks): higher score
// wins; equal scores → DRAW (both refunded, no rake). Because points
// already encode lane height × path risk × difficulty, a player who
// climbed the same height on riskier paths wins the tie — risk-taking
// is rewarded.
async function resolveByScores(tx, match, entry) {
  const actions = Array.isArray(match.actions)
    ? [...match.actions, entry].filter(Boolean)
    : entry
      ? [entry]
      : [];
  const p1Score = scoreFromActions(actions, "player1");
  const p2Score = scoreFromActions(actions, "player2");

  let result;
  if (p1Score > p2Score) result = RESULT.PLAYER1;
  else if (p2Score > p1Score) result = RESULT.PLAYER2;
  else result = RESULT.DRAW;

  return await settle(tx, match, { result, action: entry, score: { p1Score, p2Score } });
}

// ── Resolve on a bust or tower completion ─────────────────────────────
async function resolveMatch(tx, match, { loserId, reason, action }) {
  const result = decideOutcome({
    loserId,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
  });
  return await settle(tx, match, { result, action, reason });
}

// ── Settlement (shared by all resolution paths) ───────────────────────
async function settle(tx, match, { result, action, reason }) {
  const payout = computePayout({
    stakeAmount: match.stakeAmount,
    result,
  });

  const winnerId =
    result === RESULT.PLAYER1
      ? match.player1Id
      : result === RESULT.PLAYER2
        ? match.player2Id
        : null;

  const actions = Array.isArray(match.actions)
    ? [...match.actions, action].filter(Boolean)
    : action
      ? [action]
      : [];

  if (result === RESULT.DRAW) {
    // Full refund both — no house fee.
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${Number(match.stakeAmount)}` })
      .where(eq(users.clerkId, match.player1Id));
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${Number(match.stakeAmount)}` })
      .where(eq(users.clerkId, match.player2Id));
  } else {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
      .where(eq(users.clerkId, winnerId));
  }

  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      status: MATCH_STATUS.FINISHED,
      currentTurnUserId: null,
      roundDeadline: null,
      result,
      winnerId,
      houseFee: payout.houseFee.toFixed(2),
      prizePaid: payout.prizePaid.toFixed(2),
      actions,
      p1Points: scoreFromActions(actions, "player1"),
      p2Points: scoreFromActions(actions, "player2"),
      endedAt: new Date(),
    })
    .where(eq(laneRushDuelMatches.id, match.id))
    .returning();

  const finalRow = updated || match;

  // Practice (bot) matches are zero-stake and never feed the
  // leaderboards — no stats, no wins to farm.
  if (result !== RESULT.DRAW && !isBotMatch(finalRow)) {
    await recordPvPResult(tx, finalRow, winnerId, result).catch(() => {});
  }

  return finalRow;
}

// Best-effort stat side-effect — mirrors mines-pvp. Bumps
// pvpWins / gamesWon / gamesLost / totalWon / totalWagered on the
// users rows so the global PvP leaderboards stay fresh.
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
// Two auto-advance paths (mirrors mines-pvp):
//   1. `ready` deadline elapsed → advance to the first pick state.
//   2. `p1_turn` / `p2_turn` deadline elapsed → force-pick a random
//      tile for the current player (AFK nudge), then advance the
//      turn OR resolve the match.
export async function fetchMatchWithAutoResolve(userId, matchId) {
  const result = await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }

    if (
      match.status === MATCH_STATUS.READY &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const advanced = await advanceFromReady(tx, match);
      return { match: advanced };
    }

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

async function advanceFromReady(tx, match) {
  const firstUserId = match.firstPlayerId || match.player1Id;
  const seat = firstUserId === match.player1Id ? "player1" : "player2";
  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      status: seat === "player1" ? MATCH_STATUS.P1_TURN : MATCH_STATUS.P2_TURN,
      currentTurnUserId: firstUserId,
      roundDeadline: new Date(Date.now() + roundDeadlineMs(match)),
    })
    .where(
      and(
        eq(laneRushDuelMatches.id, match.id),
        eq(laneRushDuelMatches.status, MATCH_STATUS.READY),
      ),
    )
    .returning();
  return updated || match;
}

// AFK auto-pick: random path + random tile for the current player.
// The tile CAN be the bad one — that's the punishment for going AFK.
async function forcePick(tx, match) {
  const userId = match.currentTurnUserId;
  if (!userId) return match;

  const seat = seatForUser(match, userId);
  if (!seat) return match;

  const lane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;
  const pathKey = RISK_PATH_KEYS[Math.floor(Math.random() * RISK_PATH_KEYS.length)];
  const tilesPerLane = RISK_PATHS[pathKey].tiles;
  const tower =
    seat === "player1"
      ? Array.isArray(match.p1Tower)
        ? match.p1Tower
        : []
      : Array.isArray(match.p2Tower)
        ? match.p2Tower
        : [];
  const laneLayout = tower[lane] || {};
  const badTile = Number(laneLayout[pathKey]);
  const idx = Math.floor(Math.random() * tilesPerLane);
  const didFail = idx === badTile;

  const entry = {
    userId,
    seat,
    action: "pick",
    path: pathKey,
    tile: idx,
    safe: !didFail,
    lane: didFail ? lane : lane + 1,
    points: didFail ? 0 : pointsForSafePick(lane, pathKey, match.difficulty),
    autoPicked: true,
    at: new Date().toISOString(),
  };

  if (didFail) {
    const next = {
      ...match,
      [seat === "player1" ? "p1AutoPicked" : "p2AutoPicked"]: true,
    };
    return await resolveMatch(tx, next, {
      loserId: userId,
      reason: "bust",
      action: entry,
    });
  }

  const newLane = lane + 1;
  const next = {
    ...match,
    [seat === "player1" ? "p1Lane" : "p2Lane"]: newLane,
    [seat === "player1" ? "p1AutoPicked" : "p2AutoPicked"]: true,
  };

  return await advanceOrResolve(tx, next, seat, newLane, false, entry);
}

// Scrub server-only state from a match row before sending it to a
// client. Hides both towers (bad tile positions) and the server seed
// until the match reaches `finished`. Also hides the OPPONENT's
// auto-pick flag mid-match so neither side can infer the other's AFK
// state.
export function scrubMatchForViewer(match) {
  if (!match) return match;
  const finished = match.status === MATCH_STATUS.FINISHED;
  return {
    ...match,
    p1Tower: finished ? match.p1Tower : null,
    p2Tower: finished ? match.p2Tower : null,
    serverSeed: finished ? match.serverSeed : null,
    serverSeedHash: match.serverSeedHash,
    // Mid-match: only the viewer's own auto-pick flag is meaningful.
    p1AutoPicked: finished ? Boolean(match.p1AutoPicked) : false,
    p2AutoPicked: finished ? Boolean(match.p2AutoPicked) : false,
  };
}

// ── Lightweight read for /status (no row lock) ────────────────────────
export async function fetchMatch(matchId) {
  const [match] = await db
    .select()
    .from(laneRushDuelMatches)
    .where(eq(laneRushDuelMatches.id, matchId));
  return match || null;
}
