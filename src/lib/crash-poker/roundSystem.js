// src/lib/crash-poker/roundSystem.js
//
// Crash Arena v2 — pure hand rules engine (NO database access).
//
// Everything here operates on a plain `hand` object and returns new state,
// so the engine is trivially unit-testable and the routes stay thin. The
// server (API routes) is the only writer of the database; this module just
// decides what a hand *is*:
//
//   • Opening: EVERY player posts the table wager as a flat ante. No
//     blinds, no dealer rotation, no roles. A short stack posts everything
//     and is all-in from the start; a player with no stack is left out.
//   • The curve: climbs continuously from 1.00x (multiplier = e^(rate·t))
//     — NO betting checkpoints, NO pauses, NO deadlines. Anyone can fold
//     at ANY moment; the fold's multiplier is the server-authoritative
//     curve value at the moment the server accepts it.
//   • Actions: FOLD only (all-in players are committed and can't fold).
//   • Settlement (resolveHand): rank the players by fold order — rank 1 is
//     the sole survivor (fold-out) or the LAST player to fold before the
//     crash; then the remaining folders in reverse fold order. Crash
//     victims are unranked and get NOTHING. The pot (minus the 5% fee) is
//     split by linear weights: rank r of R takes weight (R − r + 1).
//     Nobody folded + crash → the whole pot carries over to the next hand.

import { CRASH_GROWTH_RATE, PLATFORM_FEE, roundMoney } from "./constants.js";

/**
 * Create a brand-new hand.
 *
 * @param {object} opts
 * @param {Array<{userId: number, name?: string}>} opts.players seated players
 * @param {number} opts.wager table wager — the flat ante everyone posts
 * @param {number} [opts.carryOver] pot carried over from the previous hand
 * @param {Map<number, number>} [opts.stackByUser] server-authoritative
 *   table balances, used to cap the ante at the stack (all-in on the
 *   opening; a player below the $0.01 floor can't play)
 * @param {number} [opts.startedAt] server epoch-ms the hand started — the
 *   curve anchor (defaults to now)
 * @returns {object} the initial hand state
 */
export function createHand({
  players,
  wager,
  carryOver = 0,
  stackByUser = null,
  startedAt = null,
}) {
  const ante = roundMoney(Number(wager));
  const handPlayers = players.map((p) => {
    const stack = stackByUser?.get(p.userId);
    let contributed = ante;
    let allIn = false;
    let cannotPlay = false;
    if (stack != null) {
      if (stack < 0.01) {
        // Can't even post the floor ante → sits the hand out.
        contributed = 0;
        cannotPlay = true;
      } else if (contributed >= stack) {
        // Short stack: post everything, go all-in on the opening.
        contributed = roundMoney(stack);
        allIn = true;
      }
    }
    return {
      userId: p.userId,
      name: p.name ?? null,
      contributed,
      isActive: !cannotPlay,
      folded: false,
      foldedAtMultiplier: null,
      allIn: Boolean(allIn),
      lastAction: cannotPlay ? null : "ante",
    };
  });

  const pot = roundMoney(
    handPlayers.reduce((sum, p) => sum + p.contributed, 0) + Number(carryOver),
  );

  const startedAtMs =
    startedAt != null && Number.isFinite(Number(startedAt))
      ? Number(startedAt)
      : Date.now();

  return {
    wager: ante,
    carryOver: Number(carryOver),
    pot,
    players: handPlayers,
    actions: [],
    // The curve is continuous from the hand start — no checkpoint pauses,
    // so the flight never re-anchors.
    flightResumedAt: startedAtMs,
  };
}

/**
 * The multiplier the shared curve shows at a wall-clock moment.
 * multiplier = e^(GROWTH_RATE · (now − startedAt)) — continuous, never
 * paused (the new game has no betting checkpoints).
 *
 * @param {object} hand
 * @param {number} [now] epoch ms
 * @param {number} [growthRate]
 * @returns {number}
 */
export function curveMultiplierAt(hand, now = Date.now(), growthRate = CRASH_GROWTH_RATE) {
  const resumedAt = Number(hand?.flightResumedAt ?? now);
  const elapsed = Math.max(0, (now - resumedAt) / 1000);
  return Math.exp(growthRate * elapsed);
}

/**
 * Whether the hand's crash is due at `now` — i.e. the continuous curve has
 * reached the server-authoritative crash point.
 *
 * @param {object} hand
 * @param {number} now epoch ms
 * @param {number} crashPoint the server-authoritative crash multiplier
 * @param {number} [growthRate]
 * @returns {boolean}
 */
export function isCrashDueAt(hand, now, crashPoint, growthRate = CRASH_GROWTH_RATE) {
  const cp = Number(crashPoint);
  if (!Number.isFinite(cp) || cp <= 1) return false;
  return curveMultiplierAt(hand, now, growthRate) >= cp;
}

/**
 * Apply a FOLD to the hand. Pure — returns the next hand (or an error).
 * The caller (route) is responsible for persisting and for computing the
 * server-authoritative fold multiplier from the curve.
 *
 * @param {object} hand
 * @param {object} action
 * @param {number} action.userId acting player
 * @param {number} action.multiplier the curve multiplier at the moment the
 *   server accepted the fold (recorded as foldedAtMultiplier)
 * @returns {{ hand: object, error?: string, handOver?: boolean, winnerUserId?: number|null }}
 */
export function applyFold(hand, { userId, multiplier }) {
  if (!hand) return { hand, error: "No hand" };
  const player = hand.players.find(
    (p) => p.userId === userId && p.isActive && !p.folded,
  );
  if (!player) return { hand, error: "Not active in this hand" };
  if (player.allIn) {
    return { hand, error: "All-in — committed to the crash, cannot fold" };
  }
  const mult = Number(multiplier);
  if (!Number.isFinite(mult) || mult < 1) {
    return { hand, error: "Invalid fold multiplier" };
  }
  const foldedAt = roundMoney(mult);

  const nextPlayers = hand.players.map((p) =>
    p.userId === userId
      ? {
          ...p,
          isActive: false,
          folded: true,
          foldedAtMultiplier: foldedAt,
          lastAction: "fold",
        }
      : p,
  );

  const nextHand = {
    ...hand,
    players: nextPlayers,
    actions: [
      ...hand.actions,
      { userId, action: "fold", multiplier: foldedAt, at: new Date().toISOString() },
    ],
  };

  // Fold-out rule: when a fold leaves exactly one active player the hand is
  // over and that player is rank 1 (they can never lose after this).
  const active = nextPlayers.filter((p) => p.isActive && !p.folded);
  if (active.length === 1) {
    return {
      hand: nextHand,
      handOver: true,
      winnerUserId: active[0].userId,
    };
  }

  return { hand: nextHand };
}

/**
 * Rebuild a hand object from persisted data (round row + entries + carryOver).
 * The per-player money truth comes from the entries; the fold log + curve
 * anchor come from round.handState when present.
 *
 * @param {object} data
 * @param {object} data.round round row (bigBlind = wager, handState)
 * @param {Array<object>} data.entries entry rows (userId, contributed,
 *   isActive, foldedAtMultiplier, lastAction, allIn, result)
 * @param {number} [data.carryOver]
 * @returns {object}
 */
export function handFromEntries({ round, entries, carryOver = 0 }) {
  const saved = round.handState && typeof round.handState === "object"
    ? round.handState
    : {};
  const savedPlayers = Array.isArray(saved.players) ? saved.players : [];
  const players = entries.map((e) => {
    const savedP = savedPlayers.find((sp) => sp.userId === e.userId) || {};
    // Folded: explicit result, the hand snapshot says so, or a live fold
    // (still "pending" in the DB but the seat was deactivated).
    const folded =
      e.result === "folded" ||
      Boolean(savedP.folded) ||
      (e.result === "pending" && e.isActive === false);
    // A player released mid-hand (disconnect cleanup marks their entry
    // "lost" before settlement) is OUT of the hand: their committed chips
    // stay in the pot as dead money, but they can no longer win the pot or
    // count toward the fold-out / active-at-crash sets — otherwise a
    // released player could be crowned the winner and paid twice (refunded
    // seat balance + pot credit).
    const released = e.result === "lost";
    return {
      userId: e.userId,
      name: savedP.name ?? null,
      contributed: Number(e.contributed || 0),
      isActive: e.isActive !== false && !folded && !released,
      folded,
      foldedAtMultiplier:
        e.foldedAtMultiplier != null ? Number(e.foldedAtMultiplier) : null,
      allIn: e.allIn === true,
      lastAction: e.lastAction ?? null,
    };
  });
  return {
    wager: round.bigBlind != null ? Number(round.bigBlind) : 0,
    carryOver: Number(carryOver),
    pot: roundMoney(
      players.reduce((sum, p) => sum + p.contributed, 0) + Number(carryOver),
    ),
    players,
    actions: Array.isArray(saved.actions) ? saved.actions : [],
    // Epoch-ms the curve started (hand start). Null on legacy hands → falls
    // back to the round creation time by callers that need the curve.
    flightResumedAt:
      saved.flightResumedAt != null ? Number(saved.flightResumedAt) : null,
  };
}

/**
 * Fold-order sort: among a hand's successful folds, return the one that
 * happened LATEST first. The latest fold is the one at the highest
 * multiplier; when several players folded at the same multiplier, the fold
 * recorded last in the hand's chronological action log wins. Folds with no
 * log entry break ties deterministically by roster order.
 *
 * @param {object} hand
 * @returns {Array<object>} folded players, latest fold first
 */
function latestFoldFirst(hand) {
  const folds = hand.players.filter((p) => p.folded && p.foldedAtMultiplier != null);
  const log = Array.isArray(hand.actions) ? hand.actions : [];
  const foldLogIndex = new Map();
  log.forEach((a, i) => {
    if (a && a.action === "fold" && a.userId != null) foldLogIndex.set(a.userId, i);
  });
  return [...folds].sort((a, b) => {
    if (Number(a.foldedAtMultiplier) !== Number(b.foldedAtMultiplier)) {
      return Number(b.foldedAtMultiplier) - Number(a.foldedAtMultiplier);
    }
    const aLog = foldLogIndex.get(a.userId) ?? -1;
    const bLog = foldLogIndex.get(b.userId) ?? -1;
    if (aLog !== bLog) return bLog - aLog;
    return hand.players.indexOf(b) - hand.players.indexOf(a);
  });
}

/**
 * THE WINNER-DETERMINATION HOOK.
 *
 * Decides the outcome of a hand given the server-authoritative crash
 * multiplier. This is the single function to change when the payout rules
 * evolve (different rake structure, different weights, …).
 *
 * Rules implemented (the agreed Crash Arena v2 rules):
 *   1. Exactly one active player → fold-out. The survivor is rank 1; every
 *      folder ranks below them by fold order (latest fold = best rank).
 *   2. Two or more active players at the crash → every active player loses
 *      (unranked, get nothing). The folders rank by fold order — the LAST
 *      successful fold before the crash is rank 1.
 *   3. Nobody folded + 2+ active at the crash → no winner: the whole pot
 *      carries over to the next hand.
 *
 * Payout: take the pot, subtract the 5% fee, then split by linear weights —
 * with R ranked players, rank r gets weight (R − r + 1); payout =
 * distributable × weight / (1 + 2 + … + R). The lowest rank absorbs any
 * cent-rounding remainder so every chip of the pot is accounted for.
 *
 * @param {object} hand
 * @param {number} crashMultiplier server-authoritative crash point
 * @returns {{
 *   winnerUserId: number|null, activeAtCrash: number[], pot: number,
 *   carryOver: number, rake: number, payoutGross: number,
 *   payouts: Array<{userId: number, rank: number, amount: number}>
 * }}
 */
export function resolveHand(hand, crashMultiplier) {
  const active = hand.players.filter((p) => p.isActive && !p.folded);
  const pot = roundMoney(hand.pot);

  // Build the ranked list (rank 1 first).
  let ranked = [];
  if (active.length === 1) {
    // Fold-out: the survivor is rank 1, folders below by fold order.
    ranked = [active[0], ...latestFoldFirst(hand)];
  } else if (active.length >= 2 && latestFoldFirst(hand).length > 0) {
    // Crash: only folders rank (crash victims are unranked and get nothing).
    ranked = latestFoldFirst(hand);
  }

  if (ranked.length === 0) {
    // Nobody folded (or everyone was released) → carry over the whole pot.
    return {
      winnerUserId: null,
      activeAtCrash: active.map((p) => p.userId),
      pot,
      carryOver: pot,
      rake: 0,
      payoutGross: 0,
      payouts: [],
    };
  }

  const R = ranked.length;
  const rake = Math.floor(pot * PLATFORM_FEE);
  const distributable = roundMoney(pot - rake);
  const sumWeights = (R * (R + 1)) / 2;
  const payouts = [];
  let accounted = 0;
  for (let i = 0; i < R; i += 1) {
    const weight = R - i; // rank i+1 weight
    const amount =
      i === R - 1
        ? roundMoney(distributable - accounted) // last rank absorbs rounding
        : roundMoney((distributable * weight) / sumWeights);
    accounted += amount;
    payouts.push({ userId: ranked[i].userId, rank: i + 1, amount });
  }

  return {
    winnerUserId: ranked[0].userId,
    activeAtCrash: active.length >= 2 ? active.map((p) => p.userId) : [],
    pot,
    carryOver: 0,
    rake,
    payoutGross: distributable,
    payouts,
  };
}