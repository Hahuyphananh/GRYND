// src/lib/lane-rush-duel/serverStore.js
//
// Server-side canonical helpers for the "Lane Rush Duel" match
// system. Mirrors `src/lib/mines-pvp/serverStore.js` so the lobby +
// match flow shares the same architecture:
//   * matchmaking lock (stake-keyed) prevents lobby-race duplicates
//   * host-picked difficulty is locked at lobby creation; joiner
//     gets the same difficulty
//   * server randomizes who selects first (the coin-flipped first
//     player owns the opening 15s window)
//   * ONE SHARED provably-fair bridge: 10 rows, EXACTLY one bad tile
//     per row, derived from the shared server seed + the host's client
//     seed + the match id as nonce. Both players cross the SAME bridge
//     and it never regenerates mid-match.
//   * 3-second ready banner auto-advance
//   * TURN-BASED tile selection — only the seat that owns the turn may
//     choose, and only on the row it is standing on. Every mutation
//     funnels through ONE row-locked transition (`act` →
//     `applyBridgeJump`), guarded by the client's `actionId`
//     (idempotency) and `row` (staleness), so a replayed or stale click
//     can never resolve twice.
//   * SAFE tile → advance one row and KEEP the turn (choose again).
//     BAD tile → the tile breaks for the rest of the match, the attempt
//     ends (progress resets to row 1) and the turn passes to the
//     opponent. Safe tiles are never permanently revealed.
//     Row BRIDGE_ROWS crossed → that player wins immediately.
//   * MEMORY FLAGS — BRIDGE_FLAGS_PER_PLAYER per player, placeable only
//     on a row the seat personally landed on safely, visible to both
//     players, and never consuming the turn.
//   * 15-second choice window per tile (AFK → the attempt simply ends:
//     back to row 1 and the turn hands over, breaking NO tile — see
//     timeoutAttempt)
//   * end-state resolution: crossing the bridge / resignation (a fall
//     never settles the match)
//   * 90/10 payout split (winner gets 1.9× stake, house keeps 0.1×)
//   * the bridge layout + server seed are hidden from clients until the
//     match finishes (the client receives geometry + broken tiles only)
//
// State machine:
//   waiting → ready → active → finished
//   (waiting/ready/active → cancelled; p1_turn / p2_turn are legacy
//    states, upgraded to `active` on the first poll)
//
// Turn progression: the seat that owns the turn selects a tile on the
// row it is standing on. A safe tile advances it one row and it keeps
// choosing; a bad tile ends its attempt (back to row 1) and hands the
// turn over. Only crossing the last row or a resignation settles the
// match.

import { eq, and, sql, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { applyPrestigeResult } from "../prestige";
import { applyRatingResult } from "../rating";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { laneRushDuelMatches, users } from "../../db/schema";
import { sendSystemNotificationEmail } from "../emails/system";
import { mirrorQueueCreated, mirrorQueueTransition } from "../canonicalQueueLifecycle";
import { randomHex } from "../laneRunner";
import {
  BOT_ACTION_INTERVAL_MS,
  BOT_USER_ID,
  BRIDGE_ACTIONS,
  BRIDGE_ROWS,
  BRIDGE_TILE_CHOICE_SECONDS,
  bridgeClientView,
  bridgeTurnAfterJump,
  brokenTilesOf,
  buildSharedBridge,
  canPlaceFlag,
  decideBridgeBotAction,
  flagPlacement,
  isTileBroken,
  resolveJump,
  seatRow,
  DIFFICULTIES,
  LANE_RUSH_DUEL_LOCK_NAMESPACE,
  MATCH_STATUS,
  TERMINAL_STATES,
  MAX_STAKE,
  MIN_STAKE,
  PICKABLE_STATES,
  READY_WINDOW_MS,
  RESULT,
  computePayout,
  decideOutcome,
  hasResolvedActionId,
  isBotMatch,
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

// ── Shared bridge helpers ─────────────────────────────────────────────
// The bridge is persisted on the match row at creation (one layout per
// match, read by both seats). Rows created before the bridge existed fall
// back to deriving it from the row's committed seeds — the bridge is a pure
// function of those seeds, so the derived layout is identical to what
// creation would have stored and cannot change mid-match.
function bridgeForMatch(match) {
  const stored = match?.bridge;
  if (stored && Array.isArray(stored.badTiles) && stored.badTiles.length > 0) {
    return stored;
  }
  return buildSharedBridge({
    serverSeed: match?.serverSeed,
    clientSeed: match?.p1ClientSeed,
    nonce: match?.id,
    difficulty: match?.difficulty,
  });
}

// Absolute deadline for the current tile choice (15s).
function nextTurnDeadline(now = Date.now()) {
  return new Date(now + BRIDGE_TILE_CHOICE_SECONDS * 1000);
}

// The clerkId of the opponent of the seat that just acted.
function opponentIdOf(match, seat) {
  return seat === "player1" ? match.player2Id : match.player1Id;
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
  // SHARED BRIDGE is derived after insert so we can use the serial id.
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
      status: MATCH_STATUS.WAITING,
      serverSeed,
      serverSeedHash,
      p1ClientSeed: clientSeed,
      roundTimerSeconds: BRIDGE_TILE_CHOICE_SECONDS,
      startedAt: null,
    })
    .returning();

  // THE SHARED BRIDGE: ONE layout per match, derived from the committed
  // seeds with the match id as nonce and stored on the match row — so both
  // seats read the exact same 10 rows, and it can never regenerate mid-match
  // (it is a pure function of those seeds).
  const bridge = buildSharedBridge({
    serverSeed,
    clientSeed,
    nonce: match.id,
    difficulty: match.difficulty,
  });

  const [withBridge] = await tx
    .update(laneRushDuelMatches)
    .set({ bridge })
    .where(eq(laneRushDuelMatches.id, match.id))
    .returning();

  if (Number(stakeAmount) >= 1000) {
    sendSystemNotificationEmail({
      eventType: "bet_placed",
      description: `User ${userId} created Lane Rush Duel lobby (${stakeAmount} stake, ${match.difficulty}).`,
      metadata: { userId, stakeAmount, difficulty: match.difficulty, matchId: match.id },
    }).catch(() => {});
  }

  const queuedMatch = withBridge || match;
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

  // Coin-flip who selects first. The joined match keeps the host's already
  // stored shared bridge (one layout for both seats — the joiner's client
  // seed is copied in purely so the layout stays re-derivable).
  const firstPlayerId = Math.random() < 0.5 ? match.player1Id : userId;

  // Brief 3-second "Get ready" window (same convention as mines-pvp /
  // keno-pvp / memory-grid): the coin-flipped first player's 15s choice
  // window must NOT start ticking while both clients are still reading the
  // match-found banner — otherwise the opening turn could be lost to a
  // timeout neither player ever saw. The first status poll after this
  // deadline opens the real window via `advanceFromReady`.
  const readyDeadline = new Date(Date.now() + READY_WINDOW_MS);

  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      player2Id: userId,
      p2ClientSeed: match.p1ClientSeed,
      status: MATCH_STATUS.READY,
      firstPlayerId,
      // TILE SELECTION IS TURN-BASED on the shared bridge: turn ownership is
      // seeded by `advanceFromReady` when the ready window closes, together
      // with the opening 15s window. (Turn ownership is the server's, never
      // the client's.)
      currentTurnUserId: null,
      roundDeadline: readyDeadline,
      roundTimerSeconds: BRIDGE_TILE_CHOICE_SECONDS,
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
// Both seats share one client seed + one bridge, exactly like a real
// PvP match — the provably-fair reveal still verifies.
async function createBotMatch(tx, userId, difficulty) {
  const diff = String(difficulty).toLowerCase();

  const serverSeed = randomHex(32);
  const serverSeedHash = getServerSeedHash(serverSeed);
  // One shared client seed → one shared bridge for both seats.
  const clientSeed = randomHex(16);

  // Coin-flip who selects first; that seat owns the opening 15s window. The
  // human's client polls `ai-turn` while the bot owns the turn, so a bot-first
  // match still starts.
  const firstPlayerId = Math.random() < 0.5 ? userId : BOT_USER_ID;

  const [match] = await tx
    .insert(laneRushDuelMatches)
    .values({
      player1Id: userId,
      player2Id: BOT_USER_ID,
      stakeAmount: "0.00",
      difficulty: diff,
      status: MATCH_STATUS.ACTIVE,
      serverSeed,
      serverSeedHash,
      p1ClientSeed: clientSeed,
      p2ClientSeed: clientSeed,
      firstPlayerId,
      currentTurnUserId: firstPlayerId,
      roundDeadline: nextTurnDeadline(),
      roundTimerSeconds: BRIDGE_TILE_CHOICE_SECONDS,
      startedAt: new Date(),
    })
    .returning();

  // One shared bridge for the practice match too (same seeds, match id as
  // nonce) — the human and the bot cross the identical 10 rows.
  const bridge = buildSharedBridge({
    serverSeed,
    clientSeed,
    nonce: match.id,
    difficulty: diff,
  });

  const [withBridge] = await tx
    .update(laneRushDuelMatches)
    .set({ bridge })
    .where(eq(laneRushDuelMatches.id, match.id))
    .returning();

  const botMatch = withBridge || match;
  mirrorQueueCreated({ gameKey: "lane-rush-duel", matchId: botMatch.id, playerCount: 2, queuedAt: botMatch.createdAt ? new Date(botMatch.createdAt) : undefined, mode: `ai:${botMatch.difficulty}` });
  return { match: botMatch, joined: true };
}

// ── Bot executor ─────────────────────────────────────────────────────
// The bot is just another simultaneous player. The client periodically
// wakes this endpoint, while the transaction below remains authoritative
// for turn ownership, the choice window, the bridge layout, the tiles that
// are already broken, and the win.
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

    // The bot plays by the same rules as a human: it only acts when the turn
    // is its own. The human's client polls this endpoint; turn ownership stays
    // server-side.
    if (match.currentTurnUserId !== BOT_USER_ID) return match;

    // …and the 15s window is just as authoritative for the bot. A wake-up that
    // arrives after the window closed ends the bot's attempt (back to Row 1,
    // turn handed over) exactly like a human's late click: the bot never gets
    // to act on borrowed time.
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const timedOut = await timeoutAttempt(tx, match);
      return { ...timedOut, timedOut: true };
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

    const bridge = bridgeForMatch(match);
    const decision = decideBridgeBotAction({
      match,
      seat: "player2",
      bridge,
      random: Math.random,
      // Tile selection only: the memory-flag action is wired separately.
      allowFlags: false,
    });
    if (!decision || decision.action !== BRIDGE_ACTIONS.JUMP) return match;

    const outcome = resolveJump({
      bridge,
      broken: brokenTilesOf(match),
      row: decision.row,
      tile: decision.tile,
    });

    const entry = {
      userId: BOT_USER_ID,
      seat: "player2",
      action: BRIDGE_ACTIONS.JUMP,
      row: decision.row,
      tile: decision.tile,
      outcome: outcome.outcome,
      safe: outcome.outcome !== "fell",
      autoPicked: false,
      at: new Date().toISOString(),
    };
    if (actionId) entry.actionId = String(actionId);

    const brokenBefore = brokenTilesOf(match);
    const applied = await applyBridgeJump(tx, match, {
      entry,
      seat: "player2",
      outcome,
    });
    // The bot's fall breaks a tile exactly like a human's, so it rides the
    // same realtime signal.
    return { ...applied, ...brokeTileSignal({ outcome, brokenBefore }) };
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

// ── Act: TILE SELECTION on the shared bridge ────────────────────────
// The ONE authoritative player transition. `action` is "jump" (the
// redesigned name; "pick" is accepted as a legacy alias) and carries
// the `row` the player is standing on plus the `tile` they chose.
// Validates participant / pickable state / TURN OWNERSHIP / the row,
// resolves the tile against the ONE SHARED bridge, then applies it
// through `applyBridgeJump` — all inside one row-locked transaction, so
// a replayed or stale click can never be interleaved or resolved twice.
// A fall ends the seat's attempt and hands the turn over; it never
// settles the match. Only crossing row BRIDGE_ROWS (or a resignation)
// ends the duel.
//
// TWO GUARDS keep this ONE transition atomic:
//   * `actionId` — the client's unique stamp for this action. A repeat
//     (network retry, double tap, a second tab) is a benign no-op, so
//     the same action can never resolve twice.
//   * `row` — the row the client rendered the click against. If the
//     seat has since moved (its own resolved action, an AFK
//     auto-select, or the opponent's turn), the click is rejected
//     rather than resolving on a row the player never saw.
export async function act({ userId, matchId, action, row, tile, actionId }) {
  // The player actions on the shared bridge are TILE SELECTION (`jump`) and
  // placing a MEMORY FLAG (`flag`).
  const actAction = String(action || "");
  const wantsFlag = actAction === BRIDGE_ACTIONS.FLAG;
  if (actAction !== BRIDGE_ACTIONS.JUMP && !wantsFlag) {
    return { error: "Invalid action", status: 400 };
  }

  const selectedTile = Number(tile);
  const selectedRow = Number(row);
  if (!Number.isInteger(selectedTile) || selectedTile < 0) {
    return { error: "Invalid tile index", status: 400 };
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
    // the row or double the fall. A repeat is a success no-op.
    if (hasResolvedActionId(match.actions, actionId)) {
      return { duplicate: true, match, status: match.status };
    }

    const seat = seatForUser(match, userId);
    const bridge = bridgeForMatch(match);

    // ── MEMORY FLAG ────────────────────────────────────────────────
    // A flag is not a tile choice: it never consumes the turn, never moves a
    // row, never breaks a tile and never touches the bridge. Its ONLY gate is
    // that the seat must have PERSONALLY landed safely on that exact tile,
    // which is validated against the server's own action history — never
    // against the request. A flag is append-only: existing flags are never
    // moved, removed or reordered, and the budget is a hard 2 per match.
    if (wantsFlag) {
      const check = canPlaceFlag({
        match,
        seat,
        row: selectedRow,
        tile: selectedTile,
        bridge,
      });
      if (!check.ok) {
        return { error: check.error, status: 409 };
      }

      const placement = flagPlacement({
        match,
        seat,
        row: selectedRow,
        tile: selectedTile,
      });
      const [flagged] = await tx
        .update(laneRushDuelMatches)
        .set({ [placement.field]: placement.flags })
        .where(
          and(
            eq(laneRushDuelMatches.id, match.id),
            eq(laneRushDuelMatches.status, match.status),
          ),
        )
        .returning();

      const applied = flagged || { ...match, [placement.field]: placement.flags };
      // Both seats' flags travel on the match payload (they are PUBLIC), so the
      // realtime push below can hand them out without a refetch.
      return {
        ...applied,
        flagPlaced: {
          seat,
          row: Number(selectedRow),
          tile: Number(selectedTile),
        },
      };
    }

    const currentRow = seatRow(match, seat);

    // ONLY THE CURRENT PLAYER MAY ACT. Turn ownership is the server's, not
    // the client's: a stale tab (or the opponent) can never select a tile
    // out of turn.
    if (!match.currentTurnUserId || match.currentTurnUserId !== userId) {
      return { error: "Not your turn", status: 409 };
    }

    // THE 15s WINDOW IS AUTHORITATIVE. A tile submitted after `roundDeadline`
    // is NOT a valid choice: the attempt is over. Resolve the expiry here (back
    // to Row 1, turn to the opponent) and refuse the late click, so a slow
    // client — or a device clock running behind — can never buy extra time.
    // The same resolution runs on the status read, so both routes agree.
    if (
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const timedOut = await timeoutAttempt(tx, match);
      return {
        error: "Time ran out — the attempt ended",
        status: 409,
        timedOut: true,
        matchStatus: timedOut.status,
      };
    }

    // THE SELECTED ROW MUST BE THE PLAYER'S CURRENT ROW: a click rendered
    // against a row the player has since left (their own resolved action, a
    // fall, an AFK auto-select) is refused instead of resolving on a row they
    // never saw.
    if (!Number.isInteger(selectedRow) || selectedRow !== currentRow) {
      return { error: "That level already changed — refreshing", status: 409 };
    }

    const tiles = Number(bridge?.tiles) || 1;
    if (selectedTile >= tiles) {
      return { error: "Invalid tile index", status: 400 };
    }

    // Resolve the choice against the ONE SHARED bridge (pure engine: safe →
    // advance, bad → break the tile + fall to row 1, row 10 crossed → win).
    const outcome = resolveJump({
      bridge,
      broken: brokenTilesOf(match),
      row: currentRow,
      tile: selectedTile,
    });

    const entry = {
      userId,
      seat,
      action: BRIDGE_ACTIONS.JUMP,
      row: currentRow,
      tile: selectedTile,
      outcome: outcome.outcome,
      safe: outcome.outcome !== "fell",
      autoPicked: false,
      at: new Date().toISOString(),
    };
    if (actionId != null && String(actionId) !== "") {
      entry.actionId = String(actionId);
    }

    // The public broken set BEFORE this jump — used to tell a freshly broken
    // tile from one that was already broken, so the realtime push can announce
    // only a genuine change.
    const brokenBefore = brokenTilesOf(match);
    const applied = await applyBridgeJump(tx, match, { entry, seat, outcome });
    return { ...applied, ...brokeTileSignal({ outcome, brokenBefore }) };
  });
}

// ── Broken-tile signal (for the realtime push) ─────────────────────────
// A tile that is stepped on stays BROKEN for the rest of the match and becomes
// public knowledge, so the routes can push it on the existing per-match event
// instead of making both seats wait for their next poll. The signal carries
// ONLY public information:
//   * `brokeTile`   — the exact tile this jump hit (`{row,tile}`), or null when
//     the choice was safe;
//   * `newlyBroken` — true only the first time that tile broke (a repeat visit
//     reports the tile but changes nothing);
//   * `broken`      — the public broken list after the jump.
// It never contains the bridge layout, and a SAFE tile never becomes public.
function brokeTileSignal({ outcome, brokenBefore = [] }) {
  const brokeTile = outcome?.brokeTile ?? null;
  return {
    brokeTile,
    newlyBroken: Boolean(
      brokeTile && !isTileBroken(brokenBefore, brokeTile.row, brokeTile.tile),
    ),
    broken: Array.isArray(outcome?.broken) ? outcome.broken : brokenBefore,
  };
}

// Apply ONE resolved tile choice to the match. This is the single write path
// for every jump — human, bot and AFK auto-select — and it owns the three
// outcomes of the redesigned rules:
//   • SAFE  → that player advances one row, KEEPS the turn, and the 15s
//             choice window resets (they may choose again);
//   • BAD   → the tile breaks for the rest of the match, that player's
//             attempt ends (progress resets to row 1) and the turn switches
//             to the opponent;
//   • ROW 10 crossed → that player is the winner and the match settles
//             immediately (credits, rake, stats — the shared settle path).
// The turn/deadline move in the SAME write as the row, so no reader can ever
// see a seat that advanced while the turn did not move.
async function applyBridgeJump(tx, match, { entry, seat, outcome }) {
  const actions = [...(Array.isArray(match.actions) ? match.actions : []), entry];
  const broken = Array.isArray(outcome.broken) ? outcome.broken : brokenTilesOf(match);

  // MEMORY FLAGS ARE NEVER TOUCHED HERE. A flag can only mark a tile its owner
  // landed on safely (see canPlaceFlag), and a safe tile never breaks — so a
  // flag can never refer to a broken tile and is never rewritten. The update
  // below therefore leaves both flag columns exactly as they are: a flag cannot
  // be removed or moved by any jump.
  const shared = {
    broken,
    actions,
  };

  // ONE source of truth for the row + turn consequence of the jump (pure
  // engine helper): safe → advance + keep the turn, bad → reset + hand over,
  // row 10 crossed → win and end.
  const turn = bridgeTurnAfterJump({ match, seat, outcome });

  if (turn.ended) {
    // Crossed the last row → winner, immediately. `resolveMatch` handles the
    // settlement (winner credited, 10% rake, stats/prestige).
    return await resolveMatch(
      tx,
      { ...match, ...shared, [turn.rowField]: BRIDGE_ROWS },
      {
        loserId: opponentIdOf(match, seat),
        reason: "crossed_bridge",
        action: entry,
      },
    );
  }

  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      ...shared,
      // A fall ends the attempt: progress resets to row 1 (0 rows crossed).
      // A safe choice advances exactly one row.
      [turn.rowField]: turn.row,
      status: MATCH_STATUS.ACTIVE,
      // Safe → the SAME player chooses again; bad → the opponent is up.
      currentTurnUserId: turn.turnUserId,
      // "The timer resets after every successful jump" (and a fall starts the
      // opponent's fresh window).
      roundDeadline: nextTurnDeadline(),
    })
    .where(
      and(
        eq(laneRushDuelMatches.id, match.id),
        eq(laneRushDuelMatches.status, match.status),
      ),
    )
    .returning();

  return updated || { ...match, ...shared, [turn.rowField]: turn.row };
}

// ── Resolve a settled match ───────────────────────────────────────────
// Called only for a genuine end: a seat crossing row BRIDGE_ROWS (the
// loser is the other seat) or a resignation. A fall never reaches here —
// it resets the attempt and hands the turn over.
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
      // The bridge state as it stood at the end (the winner crossed row 10; a
      // resignation keeps both seats where they were) — persisted here so the
      // win path doesn't lose the final rows/broken tiles.
      p1Row: Number(match.p1Row) || 0,
      p2Row: Number(match.p2Row) || 0,
      broken: Array.isArray(match.broken) ? match.broken : brokenTilesOf(match),
      p1Flags: Array.isArray(match.p1Flags) ? match.p1Flags : [],
      p2Flags: Array.isArray(match.p2Flags) ? match.p2Flags : [],
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

  // Per-game Elo — same guarded single-execution path as Prestige above, so
  // only ONE settlement of this match can ever move a rating. The
  // rating_events journal keyed by (user, game, match) makes it idempotent.
  await applyRatingResult({
    tx,
    gameKey: "lane-rush-duel",
    matchId: String(match.id),
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}

// ── Status fetch with auto-resolve ────────────────────────────────────
// Auto-advance paths (mirrors mines-pvp; there is no background scheduler,
// so these run on the status read and use the SERVER's clock):
//   1. `ready` deadline elapsed → advance to the first pick state.
//   2. the current player's 15s choice window elapsed with no tile
//      selected → end that attempt (back to Row 1) and hand the turn to
//      the opponent (see timeoutAttempt).
// Compact fingerprint of the fields the auto-advance steps touch. Used
// by fetchMatchWithAutoResolve to report whether a request actually
// moved the match forward, so the /status ROUTE can push the new state
// to the other player's socket.
function phaseSignature(match) {
  if (!match) return "";
  return [
    match.status ?? "",
    match.currentTurnUserId ?? "",
    match.roundDeadline ? new Date(match.roundDeadline).getTime() : "",
  ].join("|");
}

export async function fetchMatchWithAutoResolve(userId, matchId) {
  const result = await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }

    // The row's state BEFORE the auto-advance steps below. There is no
    // background scheduler: the `ready` window only ends when a status
    // request arrives, so without this flag the player whose request
    // opened the match would be able to place tiles while the other
    // client still showed the "get ready" banner.
    const before = phaseSignature(match);

    if (
      match.status === MATCH_STATUS.READY &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const advanced = await advanceFromReady(tx, match);
      return { match: advanced, advanced: phaseSignature(advanced) !== before };
    }

    // Heal a playable bridge match that has no turn owner (rows created
    // before the opening turn was initialized, or a turn cleared by the
    // legacy upgrade). With no `currentTurnUserId` the "only the current
    // player may act" rule would reject EVERY seat forever, so hand the
    // opening choice to the first player with a fresh 15s window.
    if (
      PICKABLE_STATES.has(match.status) &&
      match.player2Id &&
      !match.currentTurnUserId
    ) {
      const openingTurnUserId = match.firstPlayerId || match.player1Id || null;
      if (openingTurnUserId) {
        const [healed] = await tx
          .update(laneRushDuelMatches)
          .set({
            currentTurnUserId: openingTurnUserId,
            roundDeadline: nextTurnDeadline(),
          })
          .where(
            and(
              eq(laneRushDuelMatches.id, match.id),
              eq(laneRushDuelMatches.status, match.status),
              isNull(laneRushDuelMatches.currentTurnUserId),
            ),
          )
          .returning();
        const healedMatch = healed || match;
        return {
          match: healedMatch,
          advanced: phaseSignature(healedMatch) !== before,
        };
      }
    }

    // TIMEOUT: the 15s window elapsed with no tile chosen → the current
    // player's attempt ends (Row 1) and the turn switches to the opponent.
    if (
      PICKABLE_STATES.has(match.status) &&
      match.currentTurnUserId &&
      match.roundDeadline &&
      new Date(match.roundDeadline).getTime() <= Date.now()
    ) {
      const advanced = await timeoutAttempt(tx, match);
      return { match: advanced, advanced: phaseSignature(advanced) !== before };
    }

    return { match, advanced: phaseSignature(match) !== before };
  });

  if (result?.match) {
    return { ...result, match: scrubMatchForViewer(result.match, userId) };
  }
  return result;
}

async function advanceFromReady(tx, match) {
  // READY → ACTIVE. The opening tile choice belongs to the coin-flipped
  // first player and gets a fresh 15s window — clearing the turn here would
  // deadlock the match (nobody could ever be "the current player").
  const openingTurnUserId = match.firstPlayerId || match.player1Id || null;
  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      status: MATCH_STATUS.ACTIVE,
      currentTurnUserId: openingTurnUserId,
      roundDeadline: openingTurnUserId ? nextTurnDeadline() : null,
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

// TIMEOUT — the 15s choice window elapsed with no tile selected. The server
// ends THAT player's attempt: progress resets to Row 1 and the turn passes to
// the opponent. NO tile is chosen, so no bad tile breaks and no hidden board
// state is touched; the expiry is recorded in the history as a `timeout` entry.
//
// Server-authoritative by construction: this is reached from the status read
// (there is no client-side resolution and no background scheduler), so the
// countdown a device renders can never decide the result — the deadline is
// re-compared against the server's own clock here.
async function timeoutAttempt(tx, match) {
  const userId = match.currentTurnUserId;
  if (!userId) return match;

  const seat = seatForUser(match, userId);
  if (!seat) return match;

  // ONE source of truth for the consequence: row → 0, turn → opponent.
  const turn = bridgeTurnAfterJump({
    match,
    seat,
    outcome: { outcome: "timed_out", to: 0 },
  });

  const entry = {
    userId,
    seat,
    action: BRIDGE_ACTIONS.TIMEOUT,
    row: seatRow(match, seat),
    outcome: "timed_out",
    at: new Date().toISOString(),
  };
  const actions = [...(Array.isArray(match.actions) ? match.actions : []), entry];

  const [updated] = await tx
    .update(laneRushDuelMatches)
    .set({
      actions,
      // The attempt is over: back to Row 1 (0 rows crossed)…
      [turn.rowField]: turn.row,
      status: MATCH_STATUS.ACTIVE,
      // …and the opponent's own fresh 15s window starts now.
      currentTurnUserId: turn.turnUserId,
      roundDeadline: nextTurnDeadline(),
    })
    .where(
      and(
        eq(laneRushDuelMatches.id, match.id),
        eq(laneRushDuelMatches.status, match.status),
      ),
    )
    .returning();

  return (
    updated || {
      ...match,
      actions,
      [turn.rowField]: turn.row,
      currentTurnUserId: turn.turnUserId,
      roundDeadline: nextTurnDeadline(),
    }
  );
}

// Scrub server-only state from a match row before sending it to a client.
// Hides the SERVER SEED until the match reaches `finished` (so the shared
// bridge's derivation stays provably fair), stamps the viewer's seat, and
// replaces the raw bridge layout with the public client view.
export function scrubMatchForViewer(match, viewerUserId) {
  if (!match) return match;
  const finished = match.status === MATCH_STATUS.FINISHED;

  return {
    ...match,
    // The SHARED bridge. Mid-match the client gets ONLY the public view —
    // row geometry, the broken tiles and the commitment hash — so the
    // layout's hidden bad tiles never leave the server and the memory /
    // deduction is genuine. At `finished` the full layout is revealed,
    // exactly like the server seed.
    bridge:
      finished && match.bridge
        ? match.bridge
        : bridgeClientView(bridgeForMatch(match), {
            broken: brokenTilesOf(match),
          }),
    // A deadline only means something while a seat actually owns a turn: a
    // finished match has none, so a leftover deadline is scrubbed here
    // instead of rendering a phantom "0s" countdown.
    roundDeadline: match.currentTurnUserId ? match.roundDeadline : null,
    serverSeed: finished ? match.serverSeed : null,
    serverSeedHash: match.serverSeedHash,
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
