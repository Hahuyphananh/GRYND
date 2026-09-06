// src/lib/lane-rush-duel/serverStore.js
//
// Server-side canonical helpers for the "Lane Rush Duel" match
// system. Mirrors `src/lib/mines-pvp/serverStore.js` so the lobby +
// match flow shares the same architecture:
//   * matchmaking lock (stake-keyed) prevents lobby-race duplicates
//   * host-picked difficulty is locked at lobby creation; joiner
//     gets the same difficulty
//   * server randomizes the turn order at match creation
//   * ONE SHARED provably-fair tower: both players climb the same
//     bad-tile layout (per lane, per risk path), derived from the
//     shared server seed + the host's client seed + the match id.
//   * 3-second ready banner auto-advance
//   * turn enforcement (only the player whose turn it is can act)
//   * DEFERRED REVEAL (the anti-copy mechanic): a pick is parked as
//     a PENDING action and only resolved once the opponent has also
//     acted on the same row (or the deadline force-picks them). The
//     two picks reveal together, so neither player can mirror the
//     other's current-row pick — you can only deduce from the rows
//     already revealed to both. When the opponent's climb is over
//     (busted/completed), the climber is alone and picks resolve
//     immediately.
//   * FLAG BUDGET — each player gets MAX_FLAGS flag calls. A CORRECT
//     flag claims the row (advance + points, the game continues) and
//     reveals the bad tile to both players; a WRONG flag busts you.
//   * SOFT BANK — HOLD locks your accumulated points as your SAFE
//     score and you KEEP climbing; every pick after your Nth bank
//     pays × 0.5^N. Only banked points survive a bust. Banking moves
//     you past the row you banked on (it never completes the tower),
//     so both players stay on the same row and the deferred pairing
//     keeps working.
//   * 1,000-BANKED RACE — the match is a race to BANK
//     WIN_BANKED_SCORE (1,000) points: the first player whose
//     banked total reaches 1,000 wins instantly. Banking never
//     freezes the match — both players keep climbing (at reduced
//     rates) until someone banks 1,000, completes, or both climbs
//     are over.
//   * PEEK — spend one of MAX_PEEKS calls on your turn to instantly
//     and privately learn whether a chosen tile on your current lane
//     is safe or bad. It does not consume your turn and reveals
//     nothing to the opponent mid-match (they only see that you
//     peeked). Verifiable post-match against the revealed tower.
//   * 20-second pick-window auto-pick (AFK → random tile, which may
//     be the bad tile — that's the punishment for going AFK)
//   * end-state resolution: bust / completed / both-banked settlement
//   * 90/10 payout split (winner gets 1.9× stake, house keeps 0.1×)
//   * towers + server seed hidden from clients until match finishes
//
// State machine:
//   waiting → ready → p1_turn → p2_turn → finished
//   (waiting/ready/active → cancelled)
//
// Turn progression: players alternate rows on the shared tower. A
// pick or hold parks as pending; when the opponent answers the same
// row (or the timer forces them), both resolve together and the
// first actor of the pair starts the next row. If the opponent's
// climb is over (busted or completed), the active player keeps
// climbing alone and every pick resolves immediately. Banking never
// ends a climb — both players keep alternating at reduced rates
// until someone banks WIN_BANKED_SCORE (the 1,000-banked race), one
// player completes the tower, or both climbs are over. A PEEK is
// instant: it records privately and leaves the turn with the actor.

import { eq, and, sql, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { applyPrestigeResult } from "../prestige";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { laneRushDuelMatches, users } from "../../db/schema";
import { sendSystemNotificationEmail } from "../emails/system";
import { mirrorQueueCreated, mirrorQueueTransition } from "../canonicalQueueLifecycle";
import { randomHex } from "../laneRunner";
import {
  ACTIVE_STATES,
  BOT_ACTION_INTERVAL_MS,
  BOT_USER_ID,
  DIFFICULTIES,
  LANE_RUSH_DUEL_LOCK_NAMESPACE,
  MATCH_STATUS,
  MAX_FLAGS,
  MAX_LANES,
  MAX_PEEKS,
  TERMINAL_STATES,
  MAX_STAKE,
  MIN_STAKE,
  PICKABLE_STATES,
  READY_WINDOW_MS,
  RESULT,
  RISK_PATH_KEYS,
  RISK_PATHS,
  ROUND_PICK_DEADLINE_MS,
  WIN_BANKED_SCORE,
  bankedWinnerOf,
  buildPlayerTower,
  climbEnded,
  computePayout,
  decideBotAction,
  decideOutcome,
  finalScoreOf,
  flagsUsedBySeat,
  isBotMatch,
  isValidPath,
  laneMultiplier,
  opponentOf,
  peeksUsedBySeat,
  pickPointsForSeat,
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

  // Shared server seed (revealed post-match) + the host's client
  // seed. The match id becomes the nonce once the row exists — the
  // SHARED tower is derived after insert so we can use the serial id.
  // The hash is shown pre-match; the seed revealed after.
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

  const queuedMatch = withTower || match;
  mirrorQueueCreated({ gameKey: "lane-rush-duel", matchId: queuedMatch.id, playerCount: 1, queuedAt: queuedMatch.createdAt ? new Date(queuedMatch.createdAt) : undefined, mode: `pvp:${queuedMatch.difficulty}` });
  return { match: queuedMatch, joined: false };
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

  // SHARED TOWER: both players climb the SAME provably-fair layout
  // (bad tile per lane per path). The host's tower — derived from the
  // shared server seed + the host's client seed + the match id as
  // nonce — is copied into seat 2. No second seed, no second layout:
  // every safe pick by either player narrows the same deduction.
  const firstPlayerId = Math.random() < 0.5 ? match.player1Id : userId;
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      player2Id: userId,
      // Both seats share the host's client seed + tower (one layout).
      p2ClientSeed: match.p1ClientSeed,
      p2Tower: match.p1Tower,
      status: MATCH_STATUS.ACTIVE,
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

  mirrorQueueCreated({ gameKey: "lane-rush-duel", matchId: updated.id, playerCount: 2, queuedAt: updated.createdAt ? new Date(updated.createdAt) : undefined, mode: `pvp:${updated.difficulty}` });
  return { match: updated, joined: true };
}

// ── Test vs Bot practice match ────────────────────────────────────────
// Creates a zero-stake match with the reserved bot id in seat 2. No
// balance is escrowed, the ready banner starts immediately, and the
// first player is rolled (bot or human) exactly like a real match.
// Both seats share one client seed + one tower, exactly like a real
// PvP match — the provably-fair reveal still verifies.
async function createBotMatch(tx, userId, difficulty) {
  const diff = String(difficulty).toLowerCase();
  const config = DIFFICULTIES[diff];

  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);
  // One shared client seed → one shared tower for both seats.
  const clientSeed = randomHex(16);

  const [match] = await tx
    .insert(laneRushDuelMatches)
    .values({
      player1Id: userId,
      player2Id: BOT_USER_ID,
      stakeAmount: "0.00",
      difficulty: diff,
      tilesPerLane: config.width,
      status: MATCH_STATUS.ACTIVE,
      serverSeed,
      serverSeedHash,
      p1ClientSeed: clientSeed,
      p2ClientSeed: clientSeed,
      firstPlayerId: Math.random() < 0.5 ? userId : BOT_USER_ID,
      currentTurnUserId: null,
      roundDeadline: null,
      roundTimerSeconds: 20,
      startedAt: new Date(),
    })
    .returning();

  const tower = buildPlayerTower({
    serverSeed,
    clientSeed,
    nonce: match.id,
    difficulty: diff,
  });

  const [withTowers] = await tx
    .update(laneRushDuelMatches)
    .set({ p1Tower: tower, p2Tower: tower })
    .where(eq(laneRushDuelMatches.id, match.id))
    .returning();

  const botMatch = withTowers || match;
  mirrorQueueCreated({ gameKey: "lane-rush-duel", matchId: botMatch.id, playerCount: 2, queuedAt: botMatch.createdAt ? new Date(botMatch.createdAt) : undefined, mode: `ai:${botMatch.difficulty}` });
  return { match: botMatch, joined: true };
}

// ── Bot executor ─────────────────────────────────────────────────────
// The bot is just another simultaneous player. The client periodically
// wakes this endpoint, while the transaction below remains authoritative
// for cooldowns, tower checks, busts, banks, and the 1,000-point finish.
export async function botAct({ matchId, requesterId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);

    if (!match) return { error: "Match not found", status: 404 };
    if (!isBotMatch(match) || match.player2Id !== BOT_USER_ID) {
      return { error: "Not a bot match", status: 403 };
    }
    if (!requesterId || requesterId !== match.player1Id) {
      return { error: "Forbidden", status: 403 };
    }
    if (!PICKABLE_STATES.has(match.status)) {
      return { error: "Match is not active", status: 400 };
    }

    const actions = Array.isArray(match.actions) ? match.actions : [];
    const lastBotAction = [...actions]
      .reverse()
      .find((action) => action?.userId === BOT_USER_ID);
    if (
      lastBotAction?.at &&
      Date.now() - new Date(lastBotAction.at).getTime() < BOT_ACTION_INTERVAL_MS
    ) {
      return match;
    }

    const decision = decideBotAction(match);
    if (!decision) return { error: "Bot cannot act", status: 409 };

    const lane = Number(match.p2Lane) || 0;
    const entry = {
      userId: BOT_USER_ID,
      seat: "player2",
      action: decision.action,
      tile: null,
      safe: null,
      lane,
      round: lane,
      points: 0,
      autoPicked: false,
      pending: false,
      at: new Date().toISOString(),
    };

    if (decision.action === "hold") {
      entry.bankedTotal = scoreFromActions(match.actions, "player2");
    } else {
      const pathKey = decision.path && isValidPath(decision.path)
        ? decision.path
        : "balanced";
      const idx = Number(decision.tileIndex);
      const tower = Array.isArray(match.p2Tower) ? match.p2Tower : [];
      const laneLayout = tower[lane] || {};
      const badTile = Number(laneLayout[pathKey]);
      entry.path = pathKey;
      entry.tile = idx;
      entry.safe = idx !== badTile;
      entry.points = entry.safe
        ? pickPointsForSeat(match, "player2", lane, pathKey, match.difficulty)
        : 0;
    }

    return await applyEntryImmediately(tx, match, entry, "player2");
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

    mirrorQueueTransition({ gameKey: "lane-rush-duel", matchId, status: "cancelled", cancelReason: "user_cancelled", playerCount: 1 });
    return { match: updated };
  });
}

// ── Resign from an active match ──────────────────────────────────────
//
// POST-only surrender: the resigner forfeits their stake and the
// opponent is declared the winner (full settlement via the shared
// `resolveMatch` path — winner credited, house fee taken, stats
// recorded). Allowed from any non-terminal state where the opponent
// has already joined; a `waiting` match is cancelled with a full
// refund instead (see `cancelMatch`).
export async function resignMatch({ userId, matchId }) {
  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (TERMINAL_STATES.has(match.status)) {
      return { error: "Match already finished", status: 400 };
    }
    if (match.status === MATCH_STATUS.WAITING) {
      return { error: "Use cancel to leave a waiting match", status: 400 };
    }

    // Resignation is a loss for the resigner: `resolveMatch` treats
    // the passed `loserId` as the loser and credits the opponent.
    const updated = await resolveMatch(tx, match, {
      loserId: userId,
      reason: "resigned",
      action: "resign",
    });
    return { match: updated, resigned: true };
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

// ── Act: pick a tile, flag, or hold ───────────────────────────────────
// The core turn action. `action` is "pick" (with path + tileIndex),
// "flag" (call a tile as the bad one — with path + tileIndex) or
// "hold" (bank: locks your accumulated total toward the 1,000-banked
// win). Validates participant / pickable state / turn / deadline,
// then applies the action under the DEFERRED REVEAL model:
//   * If the opponent already locked in an action for this row, the
//     pair resolves together (resolveRound) — neither player sees the
//     other's current-row pick before acting.
//   * If the opponent is done (busted/completed — banking never ends
//     a climb), the climber is alone — resolve immediately
//     (applyEntryImmediately).
//   * Otherwise the action is parked as `pending` and the turn passes
//     to the opponent (parkPendingAction).
export async function act({ userId, matchId, action, path, tileIndex }) {
  const actAction = String(action || "");
  if (
    actAction !== "pick" &&
    actAction !== "hold" &&
    actAction !== "flag" &&
    actAction !== "peek"
  ) {
    return { error: "Invalid action", status: 400 };
  }

  // pick / flag / peek all need a validated risk path + tile index.
  let idx = null;
  let pathKey = null;
  if (actAction === "pick" || actAction === "flag" || actAction === "peek") {
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
      return { error: "Match is not active", status: 400 };
    }

    const seat = seatForUser(match, userId);
    const lane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;

    // Flag budget: each player gets MAX_FLAGS calls per match. The
    // limit is checked BEFORE the flag is recorded so a parked flag
    // also consumes the budget (and a wrong flag ends the match
    // anyway).
    if (actAction === "flag" && flagsUsedBySeat(match, seat) >= MAX_FLAGS) {
      return { error: "No flags left this match", status: 400 };
    }

    // Peek budget: MAX_PEEKS private peeks per match. Checked before
    // recording so a peek always consumes the budget.
    if (actAction === "peek" && peeksUsedBySeat(match, seat) >= MAX_PEEKS) {
      return { error: "No peeks left this match", status: 400 };
    }

    // Build the action record. `round` is the 0-based row being
    // climbed — the authoritative key for the boards and for pairing
    // the two players' moves on the same row.
    const entry = {
      userId,
      seat,
      action: actAction,
      lane,
      round: lane,
      pending: false,
      autoPicked: false,
      at: new Date().toISOString(),
    };

    if (actAction === "pick" || actAction === "flag" || actAction === "peek") {
      const tower =
        seat === "player1"
          ? Array.isArray(match.p1Tower)
            ? match.p1Tower
            : []
          : Array.isArray(match.p2Tower)
            ? match.p2Tower
            : [];
      const laneLayout = tower[lane] || {};
      if (idx >= RISK_PATHS[pathKey].tiles) {
        return { error: "Invalid tile index", status: 400 };
      }
      const badTile = Number(laneLayout[pathKey]);
      entry.path = pathKey;
      entry.tile = idx;
      if (actAction === "peek") {
        // PRIVATE peek: instantly learn whether this tile is safe or
        // bad. No points, no lane change, does NOT consume the turn.
        // The result is a fact of the shared tower, so it's
        // verifiable post-match; mid-match it's scrubbed from the
        // opponent's view.
        entry.pending = false;
        entry.peekResult = idx === badTile ? "bad" : "safe";
      } else if (actAction === "flag") {
        // A CORRECT flag claims the row — advance + points and the
        // game CONTINUES (no instant win); a WRONG flag busts you.
        // Encoded as `safe` so the shared pick/flag resolution and
        // scoreFromActions treat it identically to a safe pick.
        const correct = idx === badTile;
        entry.flagCorrect = correct;
        entry.safe = correct;
        entry.points = correct
          ? pickPointsForSeat(match, seat, lane, pathKey, match.difficulty)
          : 0;
      } else {
        entry.safe = idx !== badTile;
        entry.points = entry.safe
          ? pickPointsForSeat(match, seat, lane, pathKey, match.difficulty)
          : 0;
      }
    }

    if (actAction === "hold") {
      // Bank: lock the seat's accumulated points as their safe score.
      // The match does NOT end — they keep climbing at a reduced
      // rate; only this locked total survives a later bust.
      entry.bankedTotal = scoreFromActions(match.actions, seat);
    }

    // A peek is INSTANT: record it and return — the turn stays with
    // the actor, who can still pick/flag/bank on this row.
    if (actAction === "peek") {
      const actions = Array.isArray(match.actions)
        ? [...match.actions, entry]
        : [entry];
      const [updated] = await tx
        .update(laneRushDuelMatches)
        .set({ actions })
        .where(
          and(
            eq(laneRushDuelMatches.id, match.id),
            eq(laneRushDuelMatches.status, match.status),
          ),
        )
        .returning();
      return updated || { ...match, actions };
    }

    // Simultaneous play resolves this action immediately. The opponent
    // has an independent lane and can submit their own action at any time.
    return await applyEntryImmediately(tx, match, entry, seat);
  });
}

// The most recent parked (unresolved) action, or null. Exactly one
// player can have a pending action while it's the other player's turn.
function lastPendingAction(match) {
  const actions = Array.isArray(match.actions) ? match.actions : [];
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    if (actions[i] && actions[i].pending === true) return actions[i];
  }
  return null;
}

// Park the first action of a row: persist it as pending and hand the
// turn to the opponent. Their answer (or the AFK force-pick) resolves
// the pair together.
async function parkPendingAction(tx, match, entry, seat) {
  const otherUserId = opponentOf(match, entry.userId);
  const otherSeat = otherUserId === match.player1Id ? "player1" : "player2";
  const actions = Array.isArray(match.actions)
    ? [...match.actions, entry]
    : [entry];

  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      status:
        otherSeat === "player1" ? MATCH_STATUS.P1_TURN : MATCH_STATUS.P2_TURN,
      currentTurnUserId: otherUserId,
      roundDeadline: new Date(Date.now() + roundDeadlineMs(match)),
      actions,
      // Carry the AFK flags through (a parked action may be a
      // force-pick for the player who timed out).
      p1AutoPicked: Boolean(match.p1AutoPicked),
      p2AutoPicked: Boolean(match.p2AutoPicked),
    })
    .where(
      and(
        eq(laneRushDuelMatches.id, match.id),
        eq(laneRushDuelMatches.status, match.status),
      ),
    )
    .returning();

  return updated || match;
}

// Apply a lone action immediately — used when the opponent is already
// done (banked/completed) and the climber keeps climbing alone, so
// there is nothing to defer.
async function applyEntryImmediately(tx, match, entry, seat) {
  const laneField = seat === "player1" ? "p1Lane" : "p2Lane";
  const heldField = seat === "player1" ? "p1Held" : "p2Held";
  const currentLane = Number(match[laneField]) || 0;
  let nextLane = currentLane;
  let nextHeld = Boolean(match[heldField]);
  if (entry.action === "hold") {
    nextHeld = true;
    // Banking locks the current run and keeps the player moving.
    nextLane = (currentLane + 1) % MAX_LANES;
  } else if (entry.safe === false) {
    // Bust only resets the unbanked run. The player remains at the
    // current lane and can immediately try again independently.
    nextLane = currentLane;
  } else {
    nextLane = (currentLane + 1) % MAX_LANES;
  }

  const actions = [
    ...(Array.isArray(match.actions) ? match.actions : []),
    entry,
  ];
  const next = { ...match, [laneField]: nextLane, [heldField]: nextHeld, actions };

  // A completed lane cycle is not a match result; only a banked score
  // reaching the target ends the race.
  if (entry.action === "hold" && Number(entry.bankedTotal) >= WIN_BANKED_SCORE) {
    return await resolveMatch(tx, next, {
      loserId: seat === "player1" ? match.player2Id : match.player1Id,
      reason: "banked_target",
      action: entry,
    });
  }

  return await persistSimultaneousState(tx, next);
}

// Resolve a full row: both players acted (or were force-picked) on the
// same row. `entry` is the NEW action that completes the pair; its
// partner is the parked action already sitting in `match.actions`.
// Apply both in chronological order, then either settle the match
// (bust / completion / both done) or hand the next row to the first
// actor of the pair.
async function persistSimultaneousState(tx, next) {
  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      p1Lane: next.p1Lane,
      p2Lane: next.p2Lane,
      p1Held: next.p1Held,
      p2Held: next.p2Held,
      status: MATCH_STATUS.ACTIVE,
      currentTurnUserId: null,
      roundDeadline: null,
      actions: next.actions,
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

async function resolveRound(tx, match, entry) {
  const actions = Array.isArray(match.actions)
    ? [...match.actions, entry]
    : [entry];
  const applied = actions.map((a) =>
    a && a.pending === true ? { ...a, pending: false } : a,
  );

  let p1Lane = Number(match.p1Lane) || 0;
  let p2Lane = Number(match.p2Lane) || 0;
  let p1Held = Boolean(match.p1Held);
  let p2Held = Boolean(match.p2Held);

  for (const a of applied) {
    if (a.action === "hold") {
      // Banking moves you PAST the row you banked on (capped at the
      // top — a hold never completes the tower). This keeps both
      // players on the same row so the deferred pairing stays intact
      // instead of drifting apart.
      const nextLane = Math.min(Number(a.round) + 1, MAX_LANES - 1);
      if (a.seat === "player1") {
        p1Held = true;
        p1Lane = Math.max(p1Lane, nextLane);
      } else {
        p2Held = true;
        p2Lane = Math.max(p2Lane, nextLane);
      }
      continue;
    }
    // pick + flag: safe (or a correct flag) advances; a bad pick or
    // a wrong flag busts. A correct flag only claims the row — it is
    // no longer an instant win. Peeks are instant and never reach
    // the pairing resolution.
    if (a.safe === true) {
      const newLane = Number(a.round) + 1;
      if (a.seat === "player1") p1Lane = Math.max(p1Lane, newLane);
      else p2Lane = Math.max(p2Lane, newLane);
    }
  }

  // Settle-style callers re-append the last action, so hand them a
  // match whose action list already contains everything except it.
  const next = {
    ...match,
    p1Lane,
    p2Lane,
    p1Held,
    p2Held,
    actions: applied.slice(0, -1),
  };
  const lastAction = applied[applied.length - 1];

  // A both-bust row is not special-cased anymore: afterRound's
  // settlement compares final scores (two no-bank busts are 0 vs 0
  // → DRAW; any banked total survives).
  return await afterRound(tx, next, lastAction, lastAction.seat);
}

// ── Decide the match state after every action pair / lone action ─────
// Shared by manual picks, holds, flags, busts, AFK force-picks, and
// the bot. Checks, in order:
//   1. The 1,000-BANKED RACE: the first player whose banked total
//      reaches WIN_BANKED_SCORE (1,000) wins instantly. Banking
//      never freezes the match — both keep climbing at reduced
//      rates until someone locks 1,000.
//   2. A single completer (lane ≥ MAX_LANES) wins outright.
//   3. Fallback settlement — only when BOTH climbs are over
//      (busted / completed): each player's final is finalScoreOf
//      (a busted player keeps their banked total, 0 if never
//      banked). Higher final wins; equal finals → DRAW.
//   4. Otherwise the next turn: the last actor's opponent, unless
//      that opponent's climb is over — then the actor climbs alone
//      (the lone climber still needs to bank 1,000 to win).
async function afterRound(tx, next, entry, lastSeat) {
  const full = {
    ...next,
    actions: [
      ...(Array.isArray(next.actions) ? next.actions : []),
      entry,
    ].filter(Boolean),
  };

  // Rule 1 — the 1,000-banked race: whoever locks ≥ WIN_BANKED_SCORE
  // first takes the pot instantly. `bankedWinnerOf` scans the action
  // history chronologically, so the first hold to cross the target
  // wins (covers the both-bank-1000-on-the-same-row edge case).
  const bankedWinner = bankedWinnerOf(full);
  if (bankedWinner === "player1") {
    return await resolveMatch(tx, next, {
      loserId: next.player2Id,
      reason: "banked_target",
      action: entry,
    });
  }
  if (bankedWinner === "player2") {
    return await resolveMatch(tx, next, {
      loserId: next.player1Id,
      reason: "banked_target",
      action: entry,
    });
  }

  // Rule 2 — completing the tower is an instant win: no one can
  // climb higher.
  const p1Top = Number(full.p1Lane) >= MAX_LANES;
  const p2Top = Number(full.p2Lane) >= MAX_LANES;
  if (p1Top && !p2Top) {
    return await resolveMatch(tx, next, {
      loserId: next.player2Id,
      reason: "completed",
      action: entry,
    });
  }
  if (p2Top && !p1Top) {
    return await resolveMatch(tx, next, {
      loserId: next.player1Id,
      reason: "completed",
      action: entry,
    });
  }

  // Rule 3 — fallback settlement ONLY when both climbs are over
  // (busted / completed). Banking by itself never settles: if one
  // player busts, the survivor climbs on alone toward 1,000 banked;
  // if both keep banking below the target, the race continues.
  const p1Ended = climbEnded(full, "player1");
  const p2Ended = climbEnded(full, "player2");
  if (p1Ended && p2Ended) {
    return await resolveByFinalScores(tx, next, entry);
  }

  return await advanceTurn(tx, next, lastSeat, entry);
}

// ── Advance the turn ──────────────────────────────────────────────────
// `next` is the full post-action match state (already carries the
// actor's updated lane/bank flags). The last actor's opponent picks
// next UNLESS that opponent's climb is over (busted/completed) —
// then the actor keeps climbing alone. A banked player is NOT done:
// both players keep alternating at reduced rates until someone banks
// WIN_BANKED_SCORE, completes, or both climbs are over.
async function advanceTurn(tx, next, lastSeat, entry) {
  const lastUserId =
    lastSeat === "player1" ? next.player1Id : next.player2Id;
  const otherUserId = opponentOf(next, lastUserId);
  const otherSeat = otherUserId === next.player1Id ? "player1" : "player2";
  const otherEnded = climbEnded(next, otherSeat);

  // If the other player's climb is over, the actor climbs alone.
  const nextUserId = otherEnded ? lastUserId : otherUserId;
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

// ── Settle the match by final scores (fallback) ──────────────────────
// Only reached when BOTH climbs are over and nobody banked 1,000 (the
// 1,000-banked race is checked first in afterRound). Each player's
// final is finalScoreOf: a busted player keeps their banked total (0
// if never banked — the insurance banking buys), a completed player
// keeps everything. Higher final wins; equal finals → DRAW (both
// refunded, no rake).
async function resolveByFinalScores(tx, match, entry) {
  const actions = Array.isArray(match.actions)
    ? [...match.actions, entry].filter(Boolean)
    : entry
      ? [entry]
      : [];
  const withActions = { ...match, actions };
  const p1Score = finalScoreOf(withActions, "player1");
  const p2Score = finalScoreOf(withActions, "player2");

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

  const existingActions = Array.isArray(match.actions) ? match.actions : [];
  const actions = action && existingActions.includes(action)
    ? existingActions
    : [...existingActions, action].filter(Boolean);

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
      // Stored finals = what each player kept (banked totals for
      // busts, accumulated for completions).
      p1Points: finalScoreOf({ ...match, actions }, "player1"),
      p2Points: finalScoreOf({ ...match, actions }, "player2"),
      endedAt: new Date(),
    })
    .where(eq(laneRushDuelMatches.id, match.id))
    .returning();

  const finalRow = updated || match;
  mirrorQueueTransition({ gameKey: "lane-rush-duel", matchId: match.id, status: "completed", playerCount: [match.player1Id, match.player2Id].filter(Boolean).length });

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
    game: "lane-rush-duel",
    betAmount: stake,
    payout: winnerPayout,
    isPvpWin: true,
  }).catch(() => {});
  applyLeaderboardCounters({
    clerkId: loserId,
    game: "lane-rush-duel",
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
    source: "lane-rush-duel",
    sourceId: String(match.id),
  }).catch(() => {});
  await applyPrestigeResult({
    tx,
    clerkId: loserId,
    outcome: "loss",
    source: "lane-rush-duel",
    sourceId: String(match.id),
  }).catch(() => {});
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

    // Upgrade matches created by the old turn-based implementation.
    // They become simultaneous as soon as either participant polls them.
    if (
      (match.status === MATCH_STATUS.P1_TURN ||
        match.status === MATCH_STATUS.P2_TURN) &&
      match.player2Id
    ) {
      const [upgraded] = await tx
        .update(laneRushDuelMatches)
        .set({
          status: MATCH_STATUS.ACTIVE,
          currentTurnUserId: null,
          roundDeadline: null,
        })
        .where(
          and(
            eq(laneRushDuelMatches.id, match.id),
            eq(laneRushDuelMatches.status, match.status),
          ),
        )
        .returning();
      return { match: upgraded || match };
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
    return { ...result, match: scrubMatchForViewer(result.match, userId) };
  }
  return result;
}

async function advanceFromReady(tx, match) {
  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      status: MATCH_STATUS.ACTIVE,
      currentTurnUserId: null,
      roundDeadline: null,
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
// Goes through the same deferred-reveal flow as a manual action:
// parks as pending and only resolves when the opponent answers the
// row (or immediately, when the opponent is already done).
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
    lane,
    round: lane,
    points: didFail
      ? 0
      : pickPointsForSeat(match, seat, lane, pathKey, match.difficulty),
    autoPicked: true,
    pending: true,
    at: new Date().toISOString(),
  };

  const next = {
    ...match,
    [seat === "player1" ? "p1AutoPicked" : "p2AutoPicked"]: true,
  };

  const oppSeat = seat === "player1" ? "player2" : "player1";
  const oppEnded = climbEnded(match, oppSeat);

  const pending = lastPendingAction(next);
  const pairComplete =
    pending !== null &&
    pending.seat !== seat &&
    Number(pending.round) === lane;

  if (pairComplete) {
    return await resolveRound(tx, next, entry);
  }
  if (oppEnded) {
    entry.pending = false;
    return await applyEntryImmediately(tx, next, entry, seat);
  }
  return await parkPendingAction(tx, next, entry, seat);
}

// Scrub server-only state from a match row before sending it to a
// client. Hides both towers (bad tile positions) and the server seed
// until the match reaches `finished`. Also hides the OPPONENT's
// auto-pick flag mid-match so neither side can infer the other's AFK
// state, and redacts the OPPONENT's PEEK details (which tile + the
// safe/bad answer) so peeks stay private until the tower is revealed.
export function scrubMatchForViewer(match, viewerUserId) {
  if (!match) return match;
  const finished = match.status === MATCH_STATUS.FINISHED;
  const viewerSeat =
    viewerUserId === match.player1Id
      ? "player1"
      : viewerUserId === match.player2Id
        ? "player2"
        : null;

  // Deferred reveal: while an action is parked (pending), the other
  // side must not learn anything about it — not even its type (pick /
  // flag / hold / peek). Strip everything except who/where until it
  // resolves.
  const actions = Array.isArray(match.actions)
    ? match.actions.map((a) => {
        if (a && a.pending === true) {
          return {
            action: "pending",
            userId: a.userId,
            seat: a.seat,
            lane: a.lane,
            round: a.round,
            pending: true,
            autoPicked: a.autoPicked === true,
            at: a.at,
          };
        }
        // A resolved PEEK is private: the opponent learns only that
        // you peeked, never which tile or the answer, until finish.
        if (a && a.action === "peek" && a.seat !== viewerSeat && !finished) {
          return {
            action: "peek",
            userId: a.userId,
            seat: a.seat,
            lane: a.lane,
            round: a.round,
            pending: false,
            at: a.at,
          };
        }
        return a;
      })
    : match.actions;

  return {
    ...match,
    actions,
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
