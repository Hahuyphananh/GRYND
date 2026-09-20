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
//   * one authoritative, row-locked action transition per seat (both
//     seats may act at any time — see SIMULTANEOUS PLAY below)
//   * SIMULTANEOUS PLAY — each seat owns its lane on the shared tower
//     and resolves an action the instant it lands (no turn queue and
//     no parked "pending" row). Every mutation funnels through ONE
//     row-locked transition (`act` → `applyEntryImmediately`), guarded
//     by the client's `actionId` (idempotency) and `round`
//     (staleness), so the two seats can never interleave a
//     half-applied action.
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
//   * 20-second pick-window auto-pick for a legacy turn-based row
//     (AFK → random tile, which may be the bad tile — that's the
//     punishment for going AFK)
//   * end-state resolution: banked target / resignation (a bust only
//     clears the unbanked run and never settles the match)
//   * 90/10 payout split (winner gets 1.9× stake, house keeps 0.1×)
//   * towers + server seed hidden from clients until match finishes
//
// State machine:
//   waiting → ready → active → finished
//   (waiting/ready/active → cancelled; p1_turn / p2_turn are legacy
//    states, upgraded to `active` on the first poll)
//
// Turn progression: both seats act whenever they like on their own
// lane. A pick/flag advances the seat's lane, or busts it — and a
// bust only clears the UNBANKED run: it never ends the duel and never
// touches the banked total. A hold locks the accumulated run into the
// banked total and keeps the climb going at a halved rate. A PEEK is
// instant, private, and keeps the seat's row. Only a banked total
// reaching WIN_BANKED_SCORE (the 1,000-banked race) or a resignation
// settles the match.

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
  RESULT,
  RISK_PATH_KEYS,
  RISK_PATHS,
  WIN_BANKED_SCORE,
  buildPlayerTower,
  computePayout,
  decideBotAction,
  decideOutcome,
  finalScoreOf,
  flagsUsedBySeat,
  hasResolvedActionId,
  isBotMatch,
  isStaleRoundAction,
  isValidPath,
  laneMultiplier,
  peeksUsedBySeat,
  pickPointsForSeat,
  releasePendingActions,
  scoreFromActions,
  seatForUserId,
} from "./constants";
import { getServerSeedHash } from "../laneRunner";

// ── Helpers ───────────────────────────────────────────────────────────

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
      // Simultaneous play has NO per-turn window: both seats act
      // whenever they like. Leaving the legacy ready-window deadline
      // here would render a phantom countdown in the match header.
      roundDeadline: null,
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
export async function botAct({ matchId, requesterId, actionId }) {
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

    // Idempotency: one client wake-up (identified by `actionId`) must
    // resolve exactly one bot action, even if the request is retried
    // or two poll effects fire for the same state.
    if (hasResolvedActionId(match.actions, actionId)) {
      return { duplicate: true, match, status: match.status };
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

    if (actionId) entry.actionId = String(actionId);
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

// ── Act: pick a tile, flag, hold, or peek ───────────────────────────
// The ONE authoritative player transition. `action` is "pick" (with
// path + tileIndex), "flag" (call a tile as the bad one — with path +
// tileIndex), "hold" (bank: locks the accumulated run toward the
// 1,000-banked win) or "peek" (private, instant, keeps the row).
// Validates participant / pickable state / row / budgets, resolves the
// tile against the seat's tower, updates the unbanked run (and the
// locked banked total on a hold), then decides whether the duel
// actually ended — all inside one row-locked transaction, so the two
// seats can never interleave a half-applied action. A bust resolves
// the action without ending the duel: only a banked total reaching
// WIN_BANKED_SCORE (or a resignation) settles the match.
//
// TWO GUARDS keep this ONE transition atomic now that both seats act
// independently:
//   * `actionId` — the client's unique stamp for this action. A repeat
//     (network retry, double tap, a second tab) is a benign no-op, so
//     the same action can never resolve twice.
//   * `round` — the row the client rendered the click against. If the
//     seat has since moved (its own resolved action, or an AFK
//     force-pick), the click is rejected rather than resolving on a
//     row the player never saw.
export async function act({
  userId,
  matchId,
  action,
  path,
  tileIndex,
  actionId,
  round,
}) {
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

    // Idempotency: a retried POST (network hiccup, double tap, second
    // tab) must not resolve the same action twice — that would double
    // the points or double the bust. A repeat is a success no-op.
    if (hasResolvedActionId(match.actions, actionId)) {
      return { duplicate: true, match, status: match.status };
    }

    const seat = seatForUser(match, userId);
    const lane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;

    // Staleness: reject a click computed against a row the seat has
    // already left. `hold` has no row, so it is exempt.
    if (
      actAction !== "hold" &&
      isStaleRoundAction({ expectedRound: round, currentLane: lane })
    ) {
      return {
        error: "That level already changed — refreshing",
        status: 409,
      };
    }

    // Flag budget: each player gets MAX_FLAGS calls per match. The
    // limit is checked BEFORE the flag is recorded, so a spent flag
    // always consumes the budget (a wrong flag busts you — it does not
    // end the match).
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
    if (actionId != null && String(actionId) !== "") {
      entry.actionId = String(actionId);
    }

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

// Apply one resolved action to the seat's lane/bank state. This is the
// single write path for every action (pick, flag, hold, bot, AFK
// force-pick): it moves the lane, locks the banked total on a hold, and
// only settles the match when a hold actually banks the win target —
// a bust here never ends the duel.
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

// Persist the post-action state for ONE seat. The other seat's lane and
// held flag are written from the same row-locked snapshot (`next` was
// derived from the locked read), so a write can never clobber a newer
// change made by the other player — transactions serialize on the row.
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

// ── Resolve a settled match ───────────────────────────────────────────
// Called only for a genuine end: a hold that banked the win target
// (loser = the other seat) or a resignation. A bust never reaches here.
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
      // A `pending` entry parked by the old engine is scrubbed to
      // `{ action: "pending" }` for clients, so leaving the flag set
      // would hide a real action from BOTH players forever. Release
      // those flags in the same write as the upgrade.
      const [upgraded] = await tx
        .update(laneRushDuelMatches)
        .set({
          status: MATCH_STATUS.ACTIVE,
          currentTurnUserId: null,
          roundDeadline: null,
          actions: releasePendingActions(match.actions),
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

    // AFK auto-pick is a LEGACY turn-based concern: it only fires when a
    // seat actually owns the turn. Simultaneous matches never set
    // `currentTurnUserId`, so a leftover `roundDeadline` (e.g. the ready
    // window written at join time) can't drag an active match into this
    // path.
    if (
      PICKABLE_STATES.has(match.status) &&
      match.currentTurnUserId &&
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
// Resolves immediately through the same single transition as a manual
// action (a simultaneous match never parks an action as pending), so
// an auto-pick can never strand a row.
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
    pending: false,
    at: new Date().toISOString(),
  };

  const next = {
    ...match,
    [seat === "player1" ? "p1AutoPicked" : "p2AutoPicked"]: true,
  };

  return await applyEntryImmediately(tx, next, entry, seat);
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

  // LEGACY rows only (the simultaneous engine never parks an action):
  // while a `pending` entry is still parked, the other side must not
  // learn anything about it — not even its type. Strip everything
  // except who/where. The upgrade path in fetchMatchWithAutoResolve
  // releases these flags as soon as either participant polls.
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
    // A deadline only means something while a seat actually owns a turn.
    // Simultaneous play has none, so a legacy/leftover deadline is
    // scrubbed here instead of rendering a phantom "0s" countdown.
    roundDeadline: match.currentTurnUserId ? match.roundDeadline : null,
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
