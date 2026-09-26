// src/lib/keno-pvp/serverStore.js
//
// Server-side canonical helpers for the Keno PvP "Keno Survival Duel"
// match system.
//
// Why a dedicated serverStore (mirrors `src/lib/slots-pvp/serverStore.js`
// + `src/lib/mines-pvp/serverStore.js`): the match state machine has to
// be authoritative on the server:
//   * matchmaking lock (stake-keyed) prevents lobby-race duplicates
//   * both stakes escrowed at create/join so settlement is balance-neutral
//   * the live tile + its deadline are server-set, so both players race
//     for the SAME tile with the SAME window (no client can pick its own)
//   * claims are graded against the server clock — a claim only counts if
//     it arrived inside the tile's window (+ a small hidden network
//     grace), so a client can never self-report a win
//   * the window tightens by 100ms for every claimed tile, derived from
//     server-owned counters (a client cannot slow the game down)
//   * a tile nobody claims is resolved by the server as a BOTH-MISS, so
//     the match progresses even if both players go AFK
//   * 3-second ready banner auto-advance
//   * end-state resolution per the survival rulebook (lives 3 → 0)
//   * 90/10 payout split (winner 1.9× stake, house keeps 0.1×)
//
// State machine:
//   waiting → ready → <live> → finished
//   (waiting → cancelled; a disconnect mid-run settles as a forfeit win)
//
// `<live>` is MATCH_STATUS.LIVE — one continuous survival run that reuses
// the legacy `round_1` enum value (see constants.js).

import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { applyRatingResult } from "../rating";
import { applyTrophyResult } from "../trophyStore";
import { applyLeaderboardCounters } from "../leaderboardCounters";
import { getFrameDecorations } from "../cosmetics";
import {
  glows,
  kenoPvpMatches,
  kenoPvpRounds,
  tokenSubscriptions,
  users,
} from "../../db/schema";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../stripe/subscriptions";
import { sendSystemNotificationEmail } from "../emails/system";
import { mirrorKenoQueued, mirrorKenoTransition } from "./canonicalLifecycle";
import {
  ACTIVE_STATES,
  KENO_AI_PLAYER_ID,
  KENO_PVP_LOCK_NAMESPACE,
  KENO_POOL_SIZE,
  LIVE_STATES,
  MATCH_STATUS,
  MAX_STAKE,
  MIN_STAKE,
  READY_WINDOW_MS,
  RESULT,
  STARTING_LIVES,
  START_WINDOW_MS,
  TAP_GRACE_MS,
  TILE_LOG_LIMIT,
  computePayout,
  isFreeAiMatch,
  round2,
} from "./constants";
import {
  applyMissesToLives,
  capTileLog,
  chooseAiClaim,
  decideSurvivalResult,
  isClaimInWindow,
  pickLiveTile,
  TILE_OUTCOME,
  tileLogEntry,
  tileWindowMs,
} from "./engine";
import { aiDifficultyFromMatch, coerceAiDifficulty } from "../aiDifficulty";

// ── Helpers ───────────────────────────────────────────────────────────

// Opening window, stored on the row for compatibility with the legacy
// `round_timer_seconds` column (the live window shrinks from here).
const OPENING_WINDOW_SECONDS = Math.ceil(START_WINDOW_MS / 1000);

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

function summariseUsers(rows, decorationByClerkId) {
  const out = {};
  for (const r of rows) {
    if (!r || !r.clerkId) continue;
    out[r.clerkId] = {
      id: r.clerkId,
      displayName: r.displayName || r.clerkId,
      // Official Grynd icon key only — never an arbitrary avatar URL.
      iconKey: r.iconKey || "default",
      // Equipped profile frame (server-resolved catalog visual), or null.
      profileFrame: decorationByClerkId?.get(r.clerkId) || null,
      // Equipped name color — battlepass glow wins; the GRYND PRO chat
      // color only surfaces for active members (chat-route precedence).
      nameColor:
        r.glowColor ||
        (Boolean(r.isPremium) ? r.chatColor || null : null),
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
      .where(inArray(users.clerkId, Array.from(ids)));
  } catch (err) {
    console.warn(
      "[keno-pvp] enrichMatchesWithUsers: users lookup failed:",
      err && err.message ? err.message : err,
    );
    rows = [];
  }
  const decorations = await getFrameDecorations(
    rows.map((r) => r.equippedCosmetics),
  );
  const decorationByClerkId = new Map(
    rows.map((r, i) => [r.clerkId, decorations[i]]),
  );
  const summary = summariseUsers(rows, decorationByClerkId);
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
// The bot occupies player2. No stake is escrowed; it races for the same
// live tiles as the human and is graded by the same clock/window rules.
export async function createAiMatch({ userId, difficulty }) {
  if (!userId) return { error: "Unauthorized", status: 401 };

  // The lobby's AI tier. Stored on the row so both the polling path and the
  // /ai-turn trigger make the bot race at the same tier.
  const aiDifficulty = coerceAiDifficulty(difficulty);
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
        aiDifficulty,
        currentRound: 1,
        p1Lives: STARTING_LIVES,
        p2Lives: STARTING_LIVES,
        p1Tiles: 0,
        p2Tiles: 0,
        liveTile: null,
        liveTileIndex: 0,
        usedTiles: [],
        tileLog: [],
        roundTimerSeconds: OPENING_WINDOW_SECONDS,
        roundDeadline: readyDeadline,
        houseFee: "0.00",
        prizePaid: "0.00",
        startedAt: new Date(),
      })
      .returning();
    return { match, joined: true };
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
      p1Lives: STARTING_LIVES,
      p2Lives: STARTING_LIVES,
      p1Tiles: 0,
      p2Tiles: 0,
      liveTile: null,
      liveTileIndex: 0,
      usedTiles: [],
      tileLog: [],
      roundTimerSeconds: OPENING_WINDOW_SECONDS,
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

  mirrorKenoQueued({
    matchId: String(match.id),
    playerCount: 1,
    queuedAt: match.createdAt ? new Date(match.createdAt) : undefined,
  });
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

  mirrorKenoQueued({
    matchId: String(updated.id),
    playerCount: 2,
    queuedAt: updated.createdAt ? new Date(updated.createdAt) : undefined,
  });
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

    mirrorKenoTransition({
      matchId: String(matchId),
      status: "cancelled",
      cancelReason: "user_cancelled",
      playerCount: 1,
    });
    return { match: updated || match };
  });
}

// ── Row lock + survival-run plumbing ──────────────────────────────────

async function fetchMatchForUpdate(tx, matchId) {
  const [match] = await tx
    .select()
    .from(kenoPvpMatches)
    .where(eq(kenoPvpMatches.id, matchId))
    .for("update");
  return match;
}

function intOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function usedTilesOf(match) {
  return Array.isArray(match?.usedTiles) ? match.usedTiles : [];
}

function tileLogOf(match) {
  return Array.isArray(match?.tileLog) ? match.tileLog : [];
}

// Tiles claimed so far by either player — the value the shrinking window
// is derived from (a both-miss does NOT speed the game up).
export function claimedTotal(match) {
  return Math.max(0, intOr(match?.p1Tiles)) + Math.max(0, intOr(match?.p2Tiles));
}

// How long the CURRENT live tile stays claimable.
export function currentWindowMs(match) {
  return tileWindowMs(claimedTotal(match));
}

function liveDeadlineMs(match) {
  const raw = match?.roundDeadline;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function liveStartedMs(match) {
  const raw = match?.liveStartedAt;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function hasLiveTile(match) {
  const tile = Number(match?.liveTile);
  return Number.isInteger(tile) && tile >= 1 && tile <= KENO_POOL_SIZE;
}

// ── Who tapped the tile that is currently lit ─────────────────────────
//
// Per-tile scratch state, reset every time a tile lights. `p1`/`p2` are
// whether that seat tapped before the window closed; the `*Ms` values are
// their reactions from `liveStartedAt` (null while they have not tapped).
// A seat still false when the tile resolves has MISSED it, which is now
// the only way to lose a life.
function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function liveTapOf(match) {
  return {
    p1: Boolean(match?.p1ClaimedLive),
    p2: Boolean(match?.p2ClaimedLive),
    p1Ms: numOrNull(match?.p1ClaimedMs),
    p2Ms: numOrNull(match?.p2ClaimedMs),
  };
}

// The cleared tap state, spread into every write that ends a tile.
const NO_LIVE_TAPS = Object.freeze({
  p1ClaimedLive: false,
  p2ClaimedLive: false,
  p1ClaimedMs: null,
  p2ClaimedMs: null,
});

// Stable server-side seed for the tile draw + the bot plan. Never sent to
// a client.
function runSeed(match) {
  return `keno-pvp:${match?.id ?? 0}`;
}

// ── The bot's tap is an INSTANT, not a request ────────────────────────
//
// The bot is not a real actor: nothing it does happens until the server is
// read. So its plan gives the instant it tapped — `liveStartedAt +
// reactionMs`, which is always inside the tile's window (the window is a
// parameter of the plan, and a reaction that cannot fit it is not a claim
// at all). That instant decides every race on the tile, no matter when the
// read — or the human's tap — actually reaches the server.
//
// This is what makes the AI actually play. If instead the claim were only
// written when the server happened to be read at/after the due time, then
// any human tap that arrived in the gap before the next poll would take a
// tile the bot had already tapped (and a read that landed after the
// deadline left the tile as a both-miss), so an ordinary human could beat
// the bot without it ever claiming anything at all.
//
// Returns null when this match has no bot, no live tile, or the bot's plan
// declines the tile. Otherwise:
//   { claims: true, reactionMs, dueAtMs, windowMs }
function aiPlanFor(match) {
  if (!isFreeAiMatch(match)) return null;
  if (match.player2Id !== KENO_AI_PLAYER_ID) return null;
  if (!LIVE_STATES.has(match.status) || !hasLiveTile(match)) return null;

  const windowMs = tileWindowMs(
    Math.max(0, intOr(match.p1Tiles)) + Math.max(0, intOr(match.p2Tiles)),
  );
  const plan = chooseAiClaim({
    seed: `${runSeed(match)}:ai`,
    index: match.liveTileIndex,
    tile: match.liveTile,
    windowMs,
    startedMs: liveStartedMs(match),
    difficulty: aiDifficultyFromMatch(match),
  });
  if (!plan.claims || plan.dueAtMs == null) return null;
  return { ...plan, windowMs };
}

// ── Record one player's tap on the live tile ──────────────────────────
//
// A tap no longer ends the tile — the tile stays lit for its whole window
// so the slower player still has time to save their own life. This only
// writes down that the seat tapped, and (for whoever tapped first) the
// tile credit.
//
// `credit` is decided by the CALLER because being first is a question of
// instants, not of request order: the bot taps on a schedule and the human
// taps on a request, so the caller compares the two reactions and says who
// won. A tap that arrives second is still recorded — it is what keeps that
// player from missing.
async function persistTap(tx, match, { seat, reactionMs, credit = false }) {
  const patch =
    seat === "player1"
      ? { p1ClaimedLive: true, p1ClaimedMs: reactionMs }
      : { p2ClaimedLive: true, p2ClaimedMs: reactionMs };
  if (credit) {
    if (seat === "player1") patch.p1Tiles = Math.max(0, intOr(match.p1Tiles)) + 1;
    else patch.p2Tiles = Math.max(0, intOr(match.p2Tiles)) + 1;
  }

  const [updated] = await tx
    .update(kenoPvpMatches)
    .set(patch)
    .where(eq(kenoPvpMatches.id, match.id))
    .returning();
  return updated || match;
}

// ── Light the next tile ───────────────────────────────────────────────
//
// `reset` starts a brand-new run (lives back to 3, counters cleared): that
// is the `ready → live` transition. Without it the run continues from the
// current lives/tiles/log.
async function lightNextTile(tx, match, { now = Date.now(), reset = false } = {}) {
  const lives1 = reset ? STARTING_LIVES : Math.max(0, intOr(match.p1Lives));
  const lives2 = reset ? STARTING_LIVES : Math.max(0, intOr(match.p2Lives));
  const tiles1 = reset ? 0 : Math.max(0, intOr(match.p1Tiles));
  const tiles2 = reset ? 0 : Math.max(0, intOr(match.p2Tiles));
  const log = reset ? [] : capTileLog(tileLogOf(match), TILE_LOG_LIMIT);
  const used = reset ? [] : usedTilesOf(match);
  const index = reset ? 0 : Math.max(0, intOr(match.liveTileIndex));

  const tile = pickLiveTile({ seed: runSeed(match), index, used });
  if (tile == null) {
    // Board exhausted with nobody eliminated — the run cannot continue.
    // (Reached only through the defensive re-entry path; the normal
    // advance path settles from inside applyResolution.)
    const resolved = await persistRunState(tx, match, {
      p1Lives: lives1,
      p2Lives: lives2,
      p1Tiles: tiles1,
      p2Tiles: tiles2,
      log,
      used,
      live: null,
      index,
    });
    return await settleMatch(tx, resolved, {
      result: decideSurvivalResult({
        p1Lives: lives1,
        p2Lives: lives2,
        p1Tiles: tiles1,
        p2Tiles: tiles2,
        exhausted: true,
      }) || RESULT.DRAW,
      reason: "exhausted",
    });
  }

  const windowMs = tileWindowMs(tiles1 + tiles2);
  const [updated] = await tx
    .update(kenoPvpMatches)
    .set({
      status: MATCH_STATUS.LIVE,
      p1Lives: lives1,
      p2Lives: lives2,
      p1Tiles: tiles1,
      p2Tiles: tiles2,
      tileLog: log,
      usedTiles: [...used, tile],
      liveTile: tile,
      liveTileIndex: index,
      liveStartedAt: new Date(now),
      roundDeadline: new Date(now + windowMs),
      // A fresh tile starts with nobody having tapped it.
      ...NO_LIVE_TAPS,
    })
    .where(eq(kenoPvpMatches.id, match.id))
    .returning();
  return updated || match;
}

// Persist the run columns without touching the live tile (used by the
// board-exhausted path, where there is no next tile to light).
async function persistRunState(tx, match, { p1Lives, p2Lives, p1Tiles, p2Tiles, log, used, live, index }) {
  const [updated] = await tx
    .update(kenoPvpMatches)
    .set({
      p1Lives,
      p2Lives,
      p1Tiles,
      p2Tiles,
      tileLog: log,
      usedTiles: used,
      liveTile: live,
      liveTileIndex: index,
      liveStartedAt: live == null ? null : match.liveStartedAt,
      roundDeadline: null,
      // The tile is gone, so nobody's tap on it survives.
      ...NO_LIVE_TAPS,
    })
    .where(eq(kenoPvpMatches.id, match.id))
    .returning();
  return updated || match;
}

// ── Apply one resolved tile ───────────────────────────────────────────
//
// `logEntry` is already fully written (survivor lives, outcome, timing).
// This persists the run state and then either lights the next tile or
// settles the match, so both resolution paths (a claim and a both-miss)
// share one implementation.
async function applyResolution(tx, match, {
  now = Date.now(),
  p1Lives,
  p2Lives,
  p1Tiles,
  p2Tiles,
  logEntry,
}) {
  const log = capTileLog([...tileLogOf(match), logEntry], TILE_LOG_LIMIT);
  const used = usedTilesOf(match);
  const index = Math.max(0, intOr(match.liveTileIndex));

  const result = decideSurvivalResult({
    p1Lives,
    p2Lives,
    p1Tiles,
    p2Tiles,
    exhausted: false,
  });
  if (result) {
    const resolved = await persistRunState(tx, match, {
      p1Lives,
      p2Lives,
      p1Tiles,
      p2Tiles,
      log,
      used,
      live: null,
      index,
    });
    return await settleMatch(tx, resolved, { result, reason: "eliminated" });
  }

  const nextIndex = index + 1;
  const nextTile = pickLiveTile({ seed: runSeed(match), index: nextIndex, used });
  if (nextTile == null) {
    const resolved = await persistRunState(tx, match, {
      p1Lives,
      p2Lives,
      p1Tiles,
      p2Tiles,
      log,
      used,
      live: null,
      index: nextIndex,
    });
    return await settleMatch(tx, resolved, {
      result:
        decideSurvivalResult({
          p1Lives,
          p2Lives,
          p1Tiles,
          p2Tiles,
          exhausted: true,
        }) || RESULT.DRAW,
      reason: "exhausted",
    });
  }

  const windowMs = tileWindowMs(p1Tiles + p2Tiles);
  const [updated] = await tx
    .update(kenoPvpMatches)
    .set({
      p1Lives,
      p2Lives,
      p1Tiles,
      p2Tiles,
      tileLog: log,
      usedTiles: [...used, nextTile],
      liveTile: nextTile,
      liveTileIndex: nextIndex,
      liveStartedAt: new Date(now),
      roundDeadline: new Date(now + windowMs),
      // A fresh tile starts with nobody having tapped it.
      ...NO_LIVE_TAPS,
    })
    .where(eq(kenoPvpMatches.id, match.id))
    .returning();
  return updated || match;
}

// ── Settle the match ──────────────────────────────────────────────────

async function settleMatch(tx, match, { result, reason = "resolved" } = {}) {
  const finalResult = result || RESULT.DRAW;
  const isAi = isFreeAiMatch(match);
  const payout = isAi
    ? { winnerNet: 0, houseFee: 0, prizePaid: 0, refundEach: null }
    : computePayout({ stakeAmount: match.stakeAmount, result: finalResult });

  let winnerId = null;
  if (finalResult === RESULT.PLAYER1) winnerId = match.player1Id;
  else if (finalResult === RESULT.PLAYER2) winnerId = match.player2Id;

  if (!isAi && finalResult === RESULT.DRAW) {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.refundEach}` })
      .where(eq(users.clerkId, match.player1Id));
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.refundEach}` })
      .where(eq(users.clerkId, match.player2Id));
  } else if (!isAi && winnerId) {
    await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout.winnerNet}` })
      .where(eq(users.clerkId, winnerId));
  }

  const settlement = {
    winnerId,
    result: finalResult,
    houseFee: payout.houseFee.toFixed(2),
    prizePaid: payout.prizePaid.toFixed(2),
  };

  const [updated] = await tx
    .update(kenoPvpMatches)
    .set({
      status: MATCH_STATUS.FINISHED,
      roundDeadline: null,
      liveTile: null,
      liveStartedAt: null,
      currentDraw: null,
      p1Catches: null,
      p2Catches: null,
      // Legacy score columns keep a human-readable tally for history
      // rows: tiles claimed first this match.
      p1Score: Math.max(0, intOr(match.p1Tiles)),
      p2Score: Math.max(0, intOr(match.p2Tiles)),
      ...settlement,
      endedAt: new Date(),
    })
    .where(eq(kenoPvpMatches.id, match.id))
    .returning();

  const finalRow = updated || match;
  mirrorKenoTransition({
    matchId: String(match.id),
    status: "completed",
    playerCount: [match.player1Id, match.player2Id].filter(Boolean).length,
  });

  if (!isAi) {
    await recordPvPResult(tx, finalRow, winnerId, finalResult).catch(() => {});
  }

  return { ...finalRow, settleReason: reason };
}

// Best-effort stat side-effect — mirrors mines-pvp / slots-pvp.
async function recordPvPResult(tx, match, winnerId, result) {
  if (!winnerId) return;
  const loserId =
    result === RESULT.PLAYER1 ? match.player2Id : match.player1Id;
  if (!loserId) return;

  await tx
    .update(users)
    .set({ gamesWon: sql`${users.gamesWon} + 1` })
    .where(eq(users.clerkId, winnerId));
  await tx
    .update(users)
    .set({ gamesLost: sql`${users.gamesLost} + 1` })
    .where(eq(users.clerkId, loserId));

  // Canonical stats pipeline (user_stats wins/losses/win_rate/
  // total_bets, pvp_wins, wagered/won, streaks). Fire-and-forget on its own
  // pool — never blocks settlement.
  const stake = Number(match.stakeAmount) || 0;
  const winnerPayout = Number(match.prizePaid) || 0;
  applyLeaderboardCounters({
    clerkId: winnerId,
    game: "keno-pvp",
    betAmount: stake,
    payout: winnerPayout,
    isPvpWin: true,
  }).catch(() => {});
  applyLeaderboardCounters({
    clerkId: loserId,
    game: "keno-pvp",
    betAmount: stake,
    payout: 0,
  }).catch(() => {});

  // Per-game Elo — guarded single-execution path: only ONE settlement of this
  // match can ever move a rating. The rating_events journal keyed by
  // (user, game, match) makes it idempotent.
  await applyRatingResult({
    tx,
    gameKey: "keno-pvp",
    matchId: String(match.id),
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
  // Per-game trophies — the same authoritative result (+30 / −30).
  await applyTrophyResult({
    tx,
    gameKey: "keno-pvp",
    matchId: String(match.id),
    winnerClerkId: winnerId,
    loserClerkId: loserId,
  }).catch(() => {});
}

// ── Resolve the live tile ─────────────────────────────────────────────
//
// The ONLY place a tile ends. It ends when its window (plus the hidden
// network grace) has closed, or — from a caller that knows both players
// have already tapped and nothing left can change — immediately.
//
// Whoever did not tap loses a life. Tapping SECOND still counts as tapping,
// so beating someone to the tile costs them nothing; the tile credit was
// already written by the first tap (see `persistTap`).
async function resolveLiveTile(tx, match, { now = Date.now() } = {}) {
  if (!LIVE_STATES.has(match.status) || !hasLiveTile(match)) return match;

  // The bot taps on an INSTANT, not a request (see `aiPlanFor`): if its
  // instant for this tile has passed, that tap happened, whether or not a
  // read arrived in between. It is graded the same as a human — it kept its
  // own life by tapping, and it takes the tile credit only if it got there
  // before the human did.
  let current = match;
  const before = liveTapOf(current);
  if (!before.p2 && isFreeAiMatch(current) && current.player2Id === KENO_AI_PLAYER_ID) {
    const plan = aiPlanFor(current);
    if (plan && plan.dueAtMs <= now) {
      const humanWasFirst =
        before.p1 && before.p1Ms != null && before.p1Ms <= plan.reactionMs;
      current = await persistTap(tx, current, {
        seat: "player2",
        reactionMs: plan.reactionMs,
        credit: !humanWasFirst,
      });
    }
  }

  const taps = liveTapOf(current);
  const lives = applyMissesToLives({
    p1Lives: current.p1Lives,
    p2Lives: current.p2Lives,
    p1Missed: !taps.p1,
    p2Missed: !taps.p2,
  });
  const windowMs = currentWindowMs(current);
  const outcome =
    taps.p1 && taps.p2
      ? TILE_OUTCOME.BOTH_CLAIM
      : taps.p1
        ? TILE_OUTCOME.PLAYER1
        : taps.p2
          ? TILE_OUTCOME.PLAYER2
          : TILE_OUTCOME.BOTH_MISS;

  // The log's single `reactionMs` is the fastest tap on the tile — null
  // when nobody tapped at all. Both players' reactions ride alongside it.
  const reactions = [taps.p1Ms, taps.p2Ms].filter((v) => v != null);
  const logEntry = tileLogEntry({
    tile: current.liveTile,
    index: current.liveTileIndex,
    outcome,
    at: now,
    p1Lives: lives.p1Lives,
    p2Lives: lives.p2Lives,
    windowMs,
    reactionMs: reactions.length ? Math.min(...reactions) : null,
    p1Claimed: taps.p1,
    p2Claimed: taps.p2,
    p1ReactionMs: taps.p1Ms,
    p2ReactionMs: taps.p2Ms,
  });

  return await applyResolution(tx, current, {
    now,
    ...lives,
    p1Tiles: Math.max(0, intOr(current.p1Tiles)),
    p2Tiles: Math.max(0, intOr(current.p2Tiles)),
    logEntry,
  });
}

// ── claimTile (the main action) ───────────────────────────────────────
//
// The client sends the TILE NUMBER it tapped. The server grades the tap
// against the server clock, so a client can never self-report a claim:

//   * the tile must be the live tile
//   * the tap must land inside [liveStartedAt, roundDeadline + grace]
//   * the FIRST accepted tap wins the tile: the claimant's tile count
//     goes up, the opponent loses a life, and the next tile lights up
//
// In a free AI match the bot is graded on the same rule, by INSTANT rather
// than by arrival: if the bot's scheduled tap (see `aiPlanFor`) precedes
// this tap, the bot owns the tile and the tap is rejected — the client is
// told so and reconciles. A human who taps first still wins the tile.
//
// A tap that arrives after the window is not a claim: the tile is resolved
// inside the same transaction (the bot's claim if it went for the tile,
// otherwise a both-miss — both lose a life), so the game keeps moving even
// if the player is the only one polling.
export async function claimTile({ userId, matchId, tile }) {
  const tileNumber = Number(tile);
  if (!Number.isInteger(tileNumber) || tileNumber < 1 || tileNumber > KENO_POOL_SIZE) {
    return { error: "Invalid tile", status: 400 };
  }

  return await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);

    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }
    if (!LIVE_STATES.has(match.status)) {
      return { error: "Match is not live", status: 400 };
    }
    if (!hasLiveTile(match)) {
      // The run has not lit a tile yet (or is between tiles) — the caller
      // simply retries on the next poll.
      return { error: "No tile is live yet", status: 409 };
    }

    const now = Date.now();
    const deadlineMs = liveDeadlineMs(match);
    const startedMs = liveStartedMs(match);
    const windowMs = currentWindowMs(match);

    if (tileNumber !== Number(match.liveTile)) {
      // Not the tile that is lit. If the live tile's window has already
      // closed, resolve that miss here so a stale board cannot stall the
      // match; either way this tap is not a claim.
      if (deadlineMs > 0 && now > deadlineMs + TAP_GRACE_MS) {
        const advanced = await resolveLiveTile(tx, match, { now });
        return { error: "That tile is no longer live", status: 409, match: advanced };
      }
      return { error: "That tile is not live", status: 409 };
    }

    if (now < startedMs) {
      return { error: "Tile is not live yet", status: 400 };
    }

    if (!isClaimInWindow({ atMs: now, startedMs, deadlineMs })) {
      // The window closed before this tap arrived, so it is not a tap at
      // all: this player missed the tile, loses a life for it, and the tile
      // is resolved right here so a stale board cannot stall the match.
      const advanced = await resolveLiveTile(tx, match, { now });
      return { error: "Too slow — the tile expired", status: 409, match: advanced };
    }

    const seat = seatForUser(match, userId);
    const reactionMs = Math.max(0, now - startedMs);

    // Idempotent: a retried request for a tile this player already tapped
    // must not be recorded twice (and must not double a life).
    const priorTaps = liveTapOf(match);
    if (seat === "player1" ? priorTaps.p1 : priorTaps.p2) {
      return { error: "You already tapped this tile", status: 409, match };
    }

    // The bot's tap is an instant, not a request: if its scheduled instant
    // for this tile precedes this tap, the bot tapped FIRST and takes the
    // tile credit. That no longer costs the human anything — the tap below
    // still lands, so they keep their life and lose only the credit.
    let current = match;
    const aiPlan = aiPlanFor(current);
    const aiGotThereFirst = Boolean(!priorTaps.p2 && aiPlan && aiPlan.dueAtMs <= now);
    if (aiGotThereFirst) {
      current = await persistTap(tx, current, {
        seat: "player2",
        reactionMs: aiPlan.reactionMs,
        credit: true,
      });
    }

    const tapsNow = liveTapOf(current);
    const mine = seat === "player1" ? tapsNow.p1 : tapsNow.p2;
    const theirs = seat === "player1" ? tapsNow.p2 : tapsNow.p1;
    const credited = !mine && !theirs;

    current = await persistTap(tx, current, { seat, reactionMs, credit: credited });

    // Both players have tapped. Nothing left can change, so resolve the tile
    // now rather than making them sit out the rest of the window.
    const after = liveTapOf(current);
    if (after.p1 && after.p2) {
      const resolved = await resolveLiveTile(tx, current, { now });
      return {
        match: resolved,
        claim: {
          tile: tileNumber,
          seat,
          reactionMs,
          windowMs,
          credited,
          aiClaimed: aiGotThereFirst,
          complete: true,
        },
        finished: resolved?.status === MATCH_STATUS.FINISHED,
      };
    }

    return {
      match: current,
      claim: {
        tile: tileNumber,
        seat,
        reactionMs,
        windowMs,
        credited,
        aiClaimed: aiGotThereFirst,
        complete: false,
      },
      finished: false,
    };
  });
}

// ── Server AI ─────────────────────────────────────────────────────────
//
// The bot races for the same live tile as a human and is graded by the
// same server clock. Its plan is deterministic per (match, tile index) and
// the store only writes a claim once the plan's absolute due time has
// passed — so the bot can never tap early, and can never tap a tile that
// is no longer live. That due time is also the instant it is graded at, so
// the bot's play never depends on when a client happened to ask (see
// `aiPlanFor`).
async function playAiTurnInTransaction(tx, match) {
  if (!match || !isFreeAiMatch(match) || match.player2Id !== KENO_AI_PLAYER_ID) {
    return { match, actions: 0, alreadyPlayed: true };
  }
  if (!LIVE_STATES.has(match.status) || !hasLiveTile(match)) {
    return { match, actions: 0, alreadyPlayed: true };
  }

  // No deadline guard here: the bot's due instant is inside the window by
  // construction, so a read that arrives late (a backgrounded tab, a slow
  // request) must still record the tap the bot had already made — otherwise
  // the bot would be marked as having missed a tile it actually tapped, and
  // would lose a life for the server being read late. The tap is only ever
  // recorded once (`taps.p2` guard), so a second read cannot double it.
  const plan = aiPlanFor(match);
  if (!plan) return { match, actions: 0, alreadyPlayed: true };

  const now = Date.now();
  if (now < plan.dueAtMs) return { match, actions: 0, alreadyPlayed: false };

  const taps = liveTapOf(match);
  if (taps.p2) return { match, actions: 0, alreadyPlayed: true };

  // The bot keeps its own life by tapping, and takes the tile credit only
  // when the human has not already taken it.
  let current = await persistTap(tx, match, {
    seat: "player2",
    reactionMs: plan.reactionMs,
    credit: !taps.p1,
  });

  // The human has already tapped too, so the tile is decided: resolve it now
  // rather than leaving it to expire.
  if (liveTapOf(current).p1) {
    current = await resolveLiveTile(tx, current, { now });
  }

  return { match: current, actions: 1, alreadyPlayed: false };
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

// ── Status fetch with auto-resolve ────────────────────────────────────
//
// Auto-advance paths, all driven by the client polling (the single source
// of forward progress):
//   1. `ready` deadline elapsed → light the first tile.
//   2. a live run with no tile on the board (defensive) → light one.
//   3. free AI match → record the bot's due tap.
//   4. the live tile's window (plus grace) elapsed → resolve the tile,
//      charging a life to whichever player never tapped it.
export async function fetchMatchWithAutoResolve(userId, matchId) {
  const result = await db.transaction(async (tx) => {
    const match = await fetchMatchForUpdate(tx, matchId);
    if (!match) return { error: "Match not found", status: 404 };
    if (!isParticipant(match, userId)) {
      return { error: "Forbidden", status: 403 };
    }

    let current = match;

    // 1) Ready banner → first tile.
    if (
      current.status === MATCH_STATUS.READY &&
      current.roundDeadline &&
      new Date(current.roundDeadline).getTime() <= Date.now()
    ) {
      current = await lightNextTile(tx, current, { reset: true });
    }

    // 2) A live run must always have a tile on the board.
    if (LIVE_STATES.has(current.status) && !hasLiveTile(current)) {
      current = await lightNextTile(tx, current, { reset: false });
    }

    // 3) The bot's due tap (free matches only). Runs before the expiry check
    //    so a tap the bot had already earned is recorded before the tile is
    //    graded — otherwise the bot would be charged a life for a tile it
    //    tapped.
    if (isFreeAiMatch(current) && LIVE_STATES.has(current.status)) {
      const aiResult = await playAiTurnInTransaction(tx, current);
      current = aiResult.match || current;
    }

    // 4) Window elapsed → the tile is resolved, and every player who never
    //    tapped it loses a life.
    if (LIVE_STATES.has(current.status) && hasLiveTile(current)) {
      const deadlineMs = liveDeadlineMs(current);
      if (deadlineMs > 0 && Date.now() > deadlineMs + TAP_GRACE_MS) {
        current = await resolveLiveTile(tx, current, { now: Date.now() });
      }
    }

    return { match: current };
  });

  if (result?.match) {
    return { ...result, match: scrubMatchForViewer(result.match, userId) };
  }
  return result;
}

// The survival duel has no hidden per-player state: the live tile, both
// players' claimed tiles (the public tile log) and the lives are all
// visible by design, since both players watch every tile resolve. The
// legacy per-round catch columns are cleared before a row is handed to a
// client anyway — this keeps that guarantee in one place.
export function scrubMatchForViewer(match) {
  if (!match) return match;
  return { ...match, currentDraw: null, p1Catches: null, p2Catches: null };
}

// ── Round history (legacy) ────────────────────────────────────────────
// The survival duel writes no round rows; this stays so pre-rework
// matches still render their replay.

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

    // The OPPONENT wins the match outright: the leaver's lives are zeroed
    // and the standard 90/10 payout applies.
    const loserIsP1 = match.player1Id === loserClerkId;
    const winnerUserId = loserIsP1 ? match.player2Id : match.player1Id;
    const result = loserIsP1 ? RESULT.PLAYER2 : RESULT.PLAYER1;
    const isAi = isFreeAiMatch(match);
    const payout = isAi
      ? { winnerNet: 0, houseFee: 0, prizePaid: 0 }
      : computePayout({ stakeAmount: match.stakeAmount, result });

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
        p1Lives: loserIsP1 ? 0 : Math.max(0, intOr(match.p1Lives)),
        p2Lives: loserIsP1 ? Math.max(0, intOr(match.p2Lives)) : 0,
        p1Score: Math.max(0, intOr(match.p1Tiles)),
        p2Score: Math.max(0, intOr(match.p2Tiles)),
        roundDeadline: null,
        liveTile: null,
        liveStartedAt: null,
        currentDraw: null,
        p1Catches: null,
        p2Catches: null,
        ...settlement,
        endedAt: new Date(),
      })
      .where(eq(kenoPvpMatches.id, matchId))
      .returning();

    const finalRow = updated || match;
    mirrorKenoTransition({
      matchId: String(match.id),
      status: "completed",
      playerCount: [match.player1Id, match.player2Id].filter(Boolean).length,
    });

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
// truth for the survival rulebook.
export { round2 };
export { KENO_POOL_SIZE, STARTING_LIVES };
