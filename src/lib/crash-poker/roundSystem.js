// src/lib/crash-poker/roundSystem.js
//
// Crash Poker — pure hand rules engine (NO database access).
//
// Everything here operates on a plain `hand` object and returns new state,
// so the engine is trivially unit-testable and the routes stay thin. The
// server (API routes) is the only writer of the database; this module just
// decides what a hand *is*:
//
//   • Opening: everyone posts the Small Blind as their minimum opening
//     contribution (the ante); the SB seat's ante IS their small blind, the
//     BB seat tops up to the Big Blind total.
//   • Checkpoints: betting decisions open at 1.25x and every +0.25x after
//     that. The crash can land anywhere, including between checkpoints.
//   • Actions: FOLD (lose only what you've contributed), CALL/MATCH the
//     current required bet (0 = check when already matched), or RAISE (which
//     raises the required contribution for everyone still in the hand).
//   • Settlement: the winner is decided by fold-order / pot rules in
//     `resolveHand()` — the single, clean place to change the payout rules:
//       - one active player left  → that player wins the pot (fold-out)
//       - crash with 2+ active    → everyone active loses; pot carries over
//
// Money truth lives in crash_arena_entries (server); `hand.players` mirrors
// it for validation and settlement.

import {
  FIRST_BETTING_CHECKPOINT,
  CHECKPOINT_STEP,
  SMALL_BLIND_RATIO,
  MIN_SMALL_BLIND,
  MIN_RAISE_UNITS,
  BETTING_ACTIONS,
  CHECKPOINT_ACTION_DEADLINE_MS,
  checkpointMultiplier,
  checkpointIndexAtOrBelow,
  roundMoney,
} from "./constants.js";

/**
 * Resolve the Small Blind for a table: an explicit per-table value wins;
 * otherwise the standard ratio applies — SB = round(BB / 2), floored at
 * $0.01 so a $1 table gets a $0.50 blind.
 *
 * @param {number} bigBlind
 * @param {number} [smallBlind] optional per-table override (configurable blinds)
 * @returns {{ smallBlind: number }}
 */
export function computeBlinds(bigBlind, smallBlind = null) {
  const bb = Number(bigBlind);
  if (smallBlind != null && Number.isFinite(Number(smallBlind)) && Number(smallBlind) > 0) {
    return { smallBlind: Math.max(MIN_SMALL_BLIND, roundMoney(Number(smallBlind))) };
  }
  const raw = Number.isFinite(bb) ? bb * SMALL_BLIND_RATIO : 0;
  return { smallBlind: Math.max(MIN_SMALL_BLIND, roundMoney(raw)) };
}

/**
 * Assign seat roles for a hand.
 *
 * @param {Array<{userId: number}>} players seated players (ordered by seat)
 * @param {number} dealerPosition seat index of the dealer button
 * @returns {Map<number, "sb"|"bb"|"ante">} userId → role
 */
export function assignRoles(players, dealerPosition) {
  const n = players.length;
  const roles = new Map();
  players.forEach((p) => roles.set(p.userId, "ante"));
  if (n === 0) return roles;
  const dealer = ((dealerPosition % n) + n) % n;
  // Heads-up (2 players): SB is the dealer, BB is the other seat.
  const sbIndex = n === 2 ? dealer : (dealer + 1) % n;
  const bbIndex = n === 2 ? (dealer + 1) % n : (dealer + 2) % n;
  roles.set(players[sbIndex].userId, "sb");
  roles.set(players[bbIndex].userId, "bb");
  return roles;
}

/**
 * Compute each player's opening contribution (blinds + ante).
 *
 *   • SB seat  → smallBlind
 *   • BB seat  → bigBlind
 *   • everyone → smallBlind (the minimum opening contribution / ante)
 *
 * The contribution is capped at the player's available stack: a player who
 * can't cover their full blind/ante posts their whole stack and is all-in
 * (allIn: true) — the natural all-in path from the opening. A player with
 * no stack at all can't post anything and is flagged `cannotPlay`.
 *
 * @param {Array<{userId: number}>} players
 * @param {number} dealerPosition
 * @param {number} smallBlind
 * @param {number} bigBlind
 * @param {Map<number, number>} [stackByUser] server-authoritative table
 *   balances (the route passes the DB values — never client-supplied)
 * @returns {Array<{userId: number, amount: number, role: "sb"|"bb"|"ante", allIn: boolean, cannotPlay: boolean}>}
 */
export function computeOpeningContributions(
  players,
  dealerPosition,
  smallBlind,
  bigBlind,
  stackByUser = null,
) {
  const roles = assignRoles(players, dealerPosition);
  return players.map((p) => {
    const role = roles.get(p.userId) || "ante";
    const amount = roundMoney(role === "bb" ? bigBlind : smallBlind);
    const stack = stackByUser?.get(p.userId);
    if (stack == null) {
      return { userId: p.userId, amount, role, allIn: false, cannotPlay: false };
    }
    if (stack < MIN_SMALL_BLIND) {
      return {
        userId: p.userId,
        amount: 0,
        role,
        allIn: false,
        cannotPlay: true,
      };
    }
    if (amount >= stack) {
      // Short stack: post everything, go all-in on the opening.
      return {
        userId: p.userId,
        amount: roundMoney(stack),
        role,
        allIn: true,
        cannotPlay: false,
      };
    }
    return { userId: p.userId, amount, role, allIn: false, cannotPlay: false };
  });
}

/**
 * Create a brand-new hand.
 *
 * @param {object} opts
 * @param {Array<{userId: number, name?: string}>} opts.players seated players
 * @param {number} opts.bigBlind table wager
 * @param {number} opts.dealerPosition dealer seat index
 * @param {number} [opts.smallBlind] per-table Small Blind override
 *   (configurable blinds); defaults to round(bigBlind / 2)
 * @param {number} [opts.carryOver] pot carried over from the previous hand
 * @param {Map<number, number>} [opts.stackByUser] server-authoritative
 *   table balances, used to cap opening contributions (all-in on the blinds)
 * @returns {object} the initial hand state
 */
export function createHand({
  players,
  bigBlind,
  dealerPosition,
  smallBlind = null,
  carryOver = 0,
  stackByUser = null,
}) {
  const { smallBlind: sb } = computeBlinds(bigBlind, smallBlind);
  const contributions = computeOpeningContributions(
    players,
    dealerPosition,
    sb,
    Number(bigBlind),
    stackByUser,
  );
  const handPlayers = players.map((p) => {
    const c = contributions.find((x) => x.userId === p.userId) || {
      amount: 0,
      role: "ante",
      allIn: false,
      cannotPlay: false,
    };
    return {
      userId: p.userId,
      name: p.name ?? null,
      role: c.role,
      contributed: c.amount,
      isActive: !c.cannotPlay,
      folded: false,
      foldedAtMultiplier: null,
      allIn: Boolean(c.allIn),
      lastAction: c.role === "bb" ? "bb" : c.role === "sb" ? "sb" : "ante",
      actedThisCheckpoint: Boolean(c.allIn),
    };
  });

  // A short stack that went all-in on the opening is committed for the
  // hand: they count as having acted, and the required bet is capped at the
  // highest contribution actually posted so the checkpoint can still resolve.
  const maxPosted = handPlayers.reduce((m, p) => Math.max(m, p.contributed), 0);
  const requiredBet = roundMoney(Math.min(Number(bigBlind), Math.max(maxPosted, sb)));

  const pot = roundMoney(
    handPlayers.reduce((sum, p) => sum + p.contributed, 0) + Number(carryOver),
  );

  return {
    bigBlind: Number(bigBlind),
    smallBlind: sb,
    dealerPosition,
    carryOver: Number(carryOver),
    checkpointIndex: 0,
    bettingOpen: true,
    requiredBet,
    pot,
    players: handPlayers,
    actions: [],
    // Stall guard: checkpoint 0 opens at hand start — unmatched players
    // must act before this deadline or the server auto-folds them.
    windowDeadlineAt: Date.now() + CHECKPOINT_ACTION_DEADLINE_MS,
  };
}

/**
 * Whether the open checkpoint is fully resolved — i.e. every active player
 * has made their decision at this checkpoint. Matching alone is NOT enough:
 * the Big Blind (and anyone who matched earlier) still gets a chance to
 * check / raise / fold at each checkpoint, so a player who has not acted
 * yet always blocks resolution. All-in players are committed — they've put
 * their whole stack in, so they can't (and don't need to) act again.
 *
 * @param {object} hand
 * @returns {boolean}
 */
export function isCheckpointResolved(hand) {
  const active = hand.players.filter((p) => p.isActive && !p.folded);
  if (active.length === 0) return true;
  return active.every((p) => p.allIn || p.actedThisCheckpoint);
}

/**
 * Stall guard: auto-resolve every player who hasn't acted before the open
 * checkpoint's window deadline.
 *
 * The deadline is `windowDeadlineAt` — set when a checkpoint window opens
 * (hand start) and refreshed when a raise re-opens action. Silent players
 * are resolved by their position at the deadline:
 *   • matched but silent (contributed >= required bet) → implicit CHECK
 *     (they owe nothing extra; folding them would cost them matched chips
 *     for no reason);
 *   • unmatched and silent → auto-FOLD (their call is unreturned, so
 *     leaving them in would freeze betting for everyone else).
 * All-in players are committed and never appear here. A sole surviving
 * player is never touched — the fold-out is already determined.
 *
 * Pure and clock-driven: callers (action route, settle path, sweep) pass an
 * explicit `now` so behaviour is deterministic in tests.
 *
 * @param {object} hand
 * @param {number} [now] epoch ms — defaults to Date.now()
 * @param {number|null} [exceptUserId] a player who is about to submit an
 *   action and must not be auto-resolved by this pass (their own action
 *   resolves them)
 * @returns {{
 *   hand: object, autoFolded: number[], autoChecked: number[],
 *   handOver: boolean, winnerUserId: number|null
 * }}
 */
export function expireStaleActions(hand, now = Date.now(), exceptUserId = null) {
  if (!hand || !hand.bettingOpen) {
    return { hand, autoFolded: [], autoChecked: [], handOver: false, winnerUserId: null };
  }
  const deadline = Number(hand.windowDeadlineAt ?? 0);
  if (!deadline || now < deadline) {
    return { hand, autoFolded: [], autoChecked: [], handOver: false, winnerUserId: null };
  }

  const active = hand.players.filter((p) => p.isActive && !p.folded);
  // Never fold a sole survivor — the fold-out is already decided.
  if (active.length < 2) {
    return { hand, autoFolded: [], autoChecked: [], handOver: false, winnerUserId: null };
  }

  const silent = active.filter(
    (p) => p.userId !== exceptUserId && !p.allIn && !p.actedThisCheckpoint,
  );
  if (silent.length === 0) {
    return { hand, autoFolded: [], autoChecked: [], handOver: false, winnerUserId: null };
  }

  const silentIds = new Set(silent.map((p) => p.userId));
  const multiplier = checkpointMultiplier(hand.checkpointIndex);
  const autoChecked = [];
  const autoFolded = [];
  const nextPlayers = hand.players.map((p) => {
    if (!silentIds.has(p.userId)) return p;
    if (p.contributed >= hand.requiredBet) {
      // Matched but silent → implicit check: no money moves, just marks
      // the player as having acted so the checkpoint can resolve.
      autoChecked.push(p.userId);
      return { ...p, lastAction: "check", actedThisCheckpoint: true };
    }
    // Unmatched and silent → auto-fold.
    autoFolded.push(p.userId);
    return {
      ...p,
      isActive: false,
      folded: true,
      foldedAtMultiplier: multiplier,
      lastAction: "fold",
      actedThisCheckpoint: true,
    };
  });
  const nextHand = {
    ...hand,
    players: nextPlayers,
    bettingOpen: !isCheckpointResolved({
      ...hand,
      players: nextPlayers,
    }),
  };

  const remaining = nextPlayers.filter((p) => p.isActive && !p.folded);
  if (remaining.length === 1) {
    return {
      hand: nextHand,
      autoFolded,
      autoChecked,
      handOver: true,
      winnerUserId: remaining[0].userId,
    };
  }

  return {
    hand: nextHand,
    autoFolded,
    autoChecked,
    handOver: false,
    winnerUserId: null,
  };
}

/**
 * Open the next betting checkpoint (used when the first action for the next
 * checkpoint arrives after the current one fully resolved).
 *
 * @param {object} hand
 * @returns {object} updated hand
 */
export function openNextCheckpoint(hand) {
  if (hand.bettingOpen) return hand;
  if (!isCheckpointResolved(hand)) return hand;
  const nextIndex = hand.checkpointIndex + 1;
  return {
    ...hand,
    checkpointIndex: nextIndex,
    bettingOpen: true,
    // Fresh stall-guard deadline for the new window.
    windowDeadlineAt: Date.now() + CHECKPOINT_ACTION_DEADLINE_MS,
    players: hand.players.map((p) =>
      p.isActive && !p.folded && !p.allIn
        ? { ...p, actedThisCheckpoint: false }
        : p,
    ),
  };
}

/**
 * Apply one betting action to the hand. Pure — returns the next hand (or an
 * error). The caller (route) is responsible for persisting and for balance
 * checks against the player's table balance.
 *
 * @param {object} hand
 * @param {object} action
 * @param {number} action.userId acting player
 * @param {"fold"|"call"|"raise"} action.action
 * @param {number} [action.raiseTo] for raise — the new total required bet
 * @param {number} [action.stack] server-authoritative remaining table
 *   balance for the acting player. When set, call/raise amounts are capped
 *   at the stack and the player goes all-in instead of being rejected.
 *   Never trust a client-supplied balance.
 * @returns {{ hand: object, error?: string, handOver?: boolean, winnerUserId?: number|null }}
 */
export function applyAction(hand, { userId, action, raiseTo, stack = null }) {
  if (!hand || hand.bettingOpen !== true) {
    return { hand, error: "Betting is closed" };
  }
  if (!BETTING_ACTIONS.includes(action)) {
    return { hand, error: `Unknown action "${action}"` };
  }
  const player = hand.players.find(
    (p) => p.userId === userId && p.isActive && !p.folded,
  );
  if (!player) {
    return { hand, error: "Not active in this hand" };
  }
  if (player.allIn) {
    return { hand, error: "All-in — cannot act at this checkpoint" };
  }
  if (player.actedThisCheckpoint) {
    return {
      hand,
      error: "Already acted at this checkpoint (a raise re-opens action)",
    };
  }

  // The acting player's spendable stack, server-authoritative. The route
  // passes the DB balance; the engine caps all commitments at it.
  const stackNum = stack != null && Number.isFinite(Number(stack)) ? Number(stack) : null;
  const maxTotal = stackNum != null ? roundMoney(player.contributed + stackNum) : null;
  const wouldBeAllIn = (total) =>
    stackNum != null && roundMoney(total) >= roundMoney(player.contributed + stackNum);

  const multiplier = checkpointMultiplier(hand.checkpointIndex);
  const nextPlayers = hand.players.map((p) => ({ ...p }));
  const me = nextPlayers.find((p) => p.userId === userId);
  let requiredBet = hand.requiredBet;

  if (action === "fold") {
    me.isActive = false;
    me.folded = true;
    me.foldedAtMultiplier = multiplier;
    me.lastAction = "fold";
    me.actedThisCheckpoint = true;
  } else if (action === "call") {
    const needed = roundMoney(Math.max(0, hand.requiredBet - me.contributed));
    // Short stack: commit everything and go all-in rather than reject.
    const callAmount = maxTotal != null ? roundMoney(Math.min(needed, maxTotal - me.contributed)) : needed;
    me.contributed = roundMoney(me.contributed + callAmount);
    me.lastAction = callAmount > 0 ? "call" : "check";
    me.actedThisCheckpoint = true;
    if (callAmount > 0 && maxTotal != null && me.contributed >= maxTotal) {
      me.allIn = true;
    }
  } else if (action === "raise") {
    const raiseToNum = Number(raiseTo);
    if (!Number.isFinite(raiseToNum)) {
      return { hand, error: "Invalid raise amount" };
    }
    const minRaiseTo = roundMoney(hand.requiredBet + hand.bigBlind * MIN_RAISE_UNITS);
    // Cap the raise at the player's whole stack (all-in raise).
    const cappedRaw = maxTotal != null ? roundMoney(Math.min(raiseToNum, maxTotal)) : raiseToNum;
    const capped = roundMoney(cappedRaw);
    // Below-min raises are only legal as an all-in shove — a player who
    // can't cover the minimum raise commits their whole stack instead.
    if (capped < minRaiseTo && !(maxTotal != null && capped >= maxTotal)) {
      return { hand, error: `Minimum raise is to ${minRaiseTo.toFixed(2)}` };
    }
    if (capped <= me.contributed) {
      return { hand, error: "Raise must be higher than your current contribution" };
    }
    me.contributed = capped;
    me.lastAction = "raise";
    me.actedThisCheckpoint = true;
    requiredBet = capped;
    if (wouldBeAllIn(capped)) {
      me.allIn = true;
    }
    // A raise re-opens action for every other active player (but never the
    // all-in player — they're committed and can't act again).
    for (const p of nextPlayers) {
      if (p.userId !== userId && p.isActive && !p.folded && !p.allIn) {
        p.actedThisCheckpoint = false;
      }
    }
  }

  const pot = roundMoney(
    nextPlayers.reduce((sum, p) => sum + p.contributed, 0) + hand.carryOver,
  );

  const nextHand = {
    ...hand,
    requiredBet,
    pot,
    // A raise re-opens action for everyone — give the whole table a fresh
    // stall-guard deadline for the new round of decisions.
    windowDeadlineAt:
      action === "raise"
        ? Date.now() + CHECKPOINT_ACTION_DEADLINE_MS
        : hand.windowDeadlineAt,
    bettingOpen: !isCheckpointResolved({
      ...hand,
      requiredBet,
      players: nextPlayers,
    }),
    players: nextPlayers,
    actions: [
      ...hand.actions,
      {
        checkpointIndex: hand.checkpointIndex,
        multiplier,
        userId,
        action: me.lastAction || action,
        amount: me.contributed,
        at: new Date().toISOString(),
      },
    ],
  };

  // Fold-order rule: when a fold leaves exactly one active player the hand
  // is over and that player wins the pot.
  const active = nextPlayers.filter((p) => p.isActive && !p.folded);
  if (action === "fold" && active.length === 1) {
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
 * The per-player money truth comes from the entries; the transient betting
 * window state (acted flags, action log) comes from round.handState when
 * present, otherwise defaults are derived.
 *
 * @param {object} data
 * @param {object} data.round round row (checkpointIndex, requiredBet,
 *   bettingOpen, smallBlind, bigBlind, dealerPosition, handState)
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
    // released player could be crowned the fold-out winner and be paid
    // twice (refunded seat balance + pot credit).
    const released = e.result === "lost";
    const isActive = e.isActive !== false && !folded && !released;
    const allIn = e.allIn === true || Boolean(savedP.allIn);
    return {
      userId: e.userId,
      name: savedP.name ?? null,
      role: savedP.role ?? "ante",
      contributed: Number(e.contributed || 0),
      isActive,
      folded,    foldedAtMultiplier:
      e.foldedAtMultiplier != null ? Number(e.foldedAtMultiplier) : null,
      allIn,
      lastAction: e.lastAction ?? null,
      actedThisCheckpoint: allIn || Boolean(savedP.actedThisCheckpoint),
    };
  });
  return {
    bigBlind: round.bigBlind != null ? Number(round.bigBlind) : 0,
    smallBlind: round.smallBlind != null ? Number(round.smallBlind) : 0,
    dealerPosition: round.dealerPosition ?? 0,
    carryOver: Number(carryOver),
    checkpointIndex: round.checkpointIndex ?? -1,
    bettingOpen: Boolean(round.bettingOpen),
    requiredBet: round.requiredBet != null ? Number(round.requiredBet) : 0,
    pot: roundMoney(
      players.reduce((sum, p) => sum + p.contributed, 0) + Number(carryOver),
    ),
    players,
    actions: Array.isArray(saved.actions) ? saved.actions : [],
    windowDeadlineAt: saved.windowDeadlineAt ?? null,
  };
}

/**
 * Build the pot tiers (main pot + side pots) for a hand.
 *
 * Real-poker tiering: slice every contribution into layers. Each layer
 * [prevLevel, level] is funded by everyone who contributed ≥ level, and is
 * winnable only by those same players who have NOT folded (folded players'
 * chips stay in the pots they reached — folding forfeits the claim, not the
 * chips). A top layer funded by exactly one player is "uncalled" money: it
 * was never matched, so it returns to its owner at settlement.
 *
 * The table's carry-over pot is its own bottom layer (level 0) contested by
 * every active player.
 *
 * @param {object} hand
 * @param {number} [carryOver] pot carried in from the previous hand
 * @returns {Array<{ level: number, amount: number, funders: number[], eligible: number[] }>}
 */
export function computePots(hand, carryOver = 0) {
  const contributors = hand.players.filter((p) => p.contributed > 0);
  const levels = [...new Set(contributors.map((p) => p.contributed))].sort(
    (a, b) => a - b,
  );
  const pots = [];
  if (Number(carryOver) > 0) {
    pots.push({
      level: 0,
      amount: roundMoney(Number(carryOver)),
      funders: contributors.map((p) => p.userId),
      eligible: hand.players
        .filter((p) => p.isActive && !p.folded)
        .map((p) => p.userId),
    });
  }
  let prev = 0;
  for (const level of levels) {
    const funders = contributors.filter((p) => p.contributed >= level);
    pots.push({
      level,
      amount: roundMoney((level - prev) * funders.length),
      funders: funders.map((p) => p.userId),
      eligible: funders
        .filter((p) => p.isActive && !p.folded)
        .map((p) => p.userId),
    });
    prev = level;
  }
  return pots;
}

/**
 * THE WINNER-DETERMINATION HOOK.
 *
 * Decides the outcome of a hand given the server-authoritative crash
 * multiplier. This is the single function to change when the fold-order /
 * pot rules evolve (different rake structure, split pots, …).
 *
 * Rules implemented (the agreed Crash Poker fold-order / pot rules):
 *   1. Any fold recorded at a checkpoint whose multiplier is ABOVE the crash
 *      point is void — that checkpoint never opened, so the player is
 *      restored to active (and busts with the rest).
 *   2. Exactly one active player → fold-out. That player wins the WHOLE pot
 *      (minus the platform fee applied at settlement) — every folded
 *      contribution and the carry-over tier included. Folded players lose
 *      only what they already contributed; nothing is returned to them.
 *   3. Two or more active players at the crash → every active player loses.
 *      The pot then follows the fold-order mechanic:
 *        • at least one successful fold → the LATEST successful fold before
 *          the crash (highest checkpoint, then the fold recorded last within
 *          that checkpoint) wins the whole pot;
 *        • nobody folded → no winner: the whole pot carries over to the next
 *          hand.
 *
 * There are NO side-pot returns in any branch: folded players keep their
 * losses (they committed to the pot), a player who crashed can never win,
 * and the winner receives the pot exactly once (never a return + the pot).
 *
 * @param {object} hand
 * @param {number} crashMultiplier server-authoritative crash point
 * @returns {{
 *   winnerUserId: number|null, activeAtCrash: number[], pot: number,
 *   carryOver: number, payoutGross: number,
 *   pots: Array<{level, amount, funders, eligible}>, returns: Array<{userId, amount}>
 * }}
 */
export function resolveHand(hand, crashMultiplier) {
  const effective = checkpointIndexAtOrBelow(crashMultiplier);
  const players = hand.players.map((p) => {
    if (p.folded && p.foldedAtMultiplier != null) {
      const foldIndex = checkpointIndexAtOrBelow(p.foldedAtMultiplier);
      // Void folds recorded at a checkpoint beyond the crash point.
      if (foldIndex > effective) {
        return { ...p, folded: false, isActive: true, foldedAtMultiplier: null };
      }
    }
    return p;
  });
  const resolvedHand = { ...hand, players };

  const active = players.filter((p) => p.isActive && !p.folded);
  const pot = roundMoney(hand.pot);
  const pots = computePots(resolvedHand, hand.carryOver);

  if (active.length === 1) {
    // Fold-out: the sole survivor wins the whole pot — no returns.
    return {
      winnerUserId: active[0].userId,
      activeAtCrash: [],
      pot,
      carryOver: 0,
      payoutGross: pot,
      pots,
      returns: [],
    };
  }

  // 2+ players still active at the crash (or none left active after voiding
  // over-eager folds — treated the same): everyone still in loses. The
  // fold-order mechanic then decides the pot.
  const folded = players.filter((p) => p.folded && p.foldedAtMultiplier != null);
  if (folded.length > 0) {
    return {
      winnerUserId: latestSuccessfulFold(resolvedHand),
      activeAtCrash: active.map((p) => p.userId),
      pot,
      carryOver: 0,
      payoutGross: pot,
      pots,
      returns: [],
    };
  }

  // Nobody folded and 2+ players were active at the crash → no winner: the
  // whole pot carries over to the next hand.
  return {
    winnerUserId: null,
    activeAtCrash: active.map((p) => p.userId),
    pot,
    carryOver: pot,
    payoutGross: 0,
    pots,
    returns: [],
  };
}

/**
 * Fold-order tie-break: among a hand's successful (non-voided) folds, return
 * the one that happened LATEST. The latest fold is the one at the highest
 * checkpoint multiplier; when several players folded at the same checkpoint,
 * the fold recorded last in the hand's chronological action log wins. Folds
 * with no log entry (server auto-folds) all happened at the same deadline, so
 * they break ties deterministically by roster order.
 *
 * @param {object} hand the resolved hand (voided folds already removed)
 * @returns {number|null} userId of the latest successful fold
 */
function latestSuccessfulFold(hand) {
  const folds = hand.players.filter((p) => p.folded && p.foldedAtMultiplier != null);
  if (folds.length === 0) return null;
  const log = Array.isArray(hand.actions) ? hand.actions : [];
  const foldLogIndex = new Map();
  log.forEach((a, i) => {
    if (a && a.action === "fold" && a.userId != null) foldLogIndex.set(a.userId, i);
  });
  let best = null;
  for (const p of folds) {
    if (!best) {
      best = p;
      continue;
    }
    const pCp = checkpointIndexAtOrBelow(p.foldedAtMultiplier);
    const bCp = checkpointIndexAtOrBelow(best.foldedAtMultiplier);
    if (pCp !== bCp) {
      if (pCp > bCp) best = p;
      continue;
    }
    const pLog = foldLogIndex.get(p.userId) ?? -1;
    const bLog = foldLogIndex.get(best.userId) ?? -1;
    if (pLog !== bLog) {
      if (pLog > bLog) best = p;
      continue;
    }
    const pPos = hand.players.indexOf(p);
    const bPos = hand.players.indexOf(best);
    if (pPos > bPos) best = p;
  }
  return best.userId;
}
