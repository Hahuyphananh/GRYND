// src/lib/lane-rush-duel/constants.js
//
// Shared constants + provably-fair tower generation + outcome
// resolution for the "Lane Rush Duel" match system. Built as a
// parallel to `src/lib/mines-pvp/constants.js` so the lobby + match
// flow shares the same shape (stake presets / round timer / status
// enum / advisory-lock namespace / RESULT enum) while the game logic
// is lane-runner-specific.
//
// ── Game rules (per user spec) ───────────────────────────────────
// Both players race the SAME shared provably-fair tower (same
// difficulty), alternating turns. Picks are DEFERRED: they park as
// pending and only reveal once both players have acted on the row,
// so neither player can mirror the other's current-row pick. On
// your turn you either:
//   • PICK a tile in your current lane — safe advances your lane
//     (points grow), bad busts you (instant loss).
//   • FLAG — call the bad tile (limited to MAX_FLAGS per match):
//     a CORRECT flag claims the row (advance + points, the game
//     CONTINUES) and reveals the bad tile to both players; a WRONG
//     flag busts you. The budget stops flags from becoming a free
//     instant win.
//   • HOLD (BANK) — lock your accumulated points as your SAFE score
//     and keep climbing. Banking never ends your climb: every pick
//     after your Nth bank earns points × 0.5^N (first bank → 50%, and
//     stacking lower with each extra bank). Only BANKED points are
//     safe — if you bust, you lose everything you hadn't banked.
//   • PEEK — spend one of MAX_PEEKS calls (on your turn, before your
//     pick/flag/bank) to privately learn whether a chosen tile on
//     your current lane is safe or the bad tile. The result is yours
//     alone: the opponent only sees that you peeked, not which tile
//     or the answer. Verifiable post-match (the peek is a fact of the
//     shared tower). Peeking does not consume your turn.
//
// Terminal conditions (the 1,000-banked race):
//   • WIN: the first player whose BANKED total reaches
//     WIN_BANKED_SCORE (1,000) wins instantly — the race is to lock
//     1,000 points, not to out-score the opponent. Banking never
//     ends the climb, so both players keep climbing (at reduced
//     rates) until someone banks 1,000.
//   • Bust (picked the bad tile / wrong flag) → your climb ends; you
//     keep only your banked total (0 if never banked). Unbanked
//     points are lost. The survivor keeps climbing alone toward
//     1,000 banked.
//   • Completed all 8 lanes → completer wins outright.
//   • Fallback: if BOTH climbs are over (busted/completed) and
//     nobody banked 1,000, the higher FINAL score takes the pot — a
//     busted player's final is their banked total (insurance), a
//     completed player keeps everything. Equal finals → DRAW (full
//     refund, no house fee).
//
// Payout (90/10 split, mirrors mines-pvp / roulette-pvp):
//   Winner: own stake back + 90% of loser's stake (1.9× net)
//   Loser:   loses entire stake
//   House:   10% rake on loser's stake only
//   Draw:    both refunded, no rake

import crypto from "crypto";
import {
  buildProvablyFairSequence,
  DEFAULT_LANES,
  getMultiplier,
  LANE_RUNNER_DIFFICULTIES,
} from "../laneRunner";

// ── Re-export the difficulty table (the lobby + match UI render
// these values; the tile WIDTH per difficulty is the base odds, and
// the risk paths below layer on top). ────────────────────────────────
export const DIFFICULTIES = LANE_RUNNER_DIFFICULTIES;
export const MAX_LANES = DEFAULT_LANES;

// ── The win target: first to BANK this many points wins ───────────
// Points only count once they're BANKED (a hold locks your
// accumulated total). The race ends the moment either player's
// banked total reaches this — the opponent's score is irrelevant.
export const WIN_BANKED_SCORE = 1000;

// The seat whose EARLIEST qualifying hold locked ≥ WIN_BANKED_SCORE,
// or null. Actions are stored chronologically, so the first hold
// entry with bankedTotal ≥ the target is the winner (covers the
// both-bank-1000-on-the-same-row edge case: the first actor wins).
export function bankedWinnerOf(match) {
  const actions = Array.isArray(match?.actions) ? match.actions : [];
  for (const a of actions) {
    if (
      a &&
      a.action === "hold" &&
      a.bankedTotal != null &&
      Number(a.bankedTotal) >= WIN_BANKED_SCORE
    ) {
      return a.seat;
    }
  }
  return null;
}

// ── Points scoring (replaces the multiplier ladder as the score) ──
// Base points for a safe pick on lane N (1-indexed 1..8). Geometric
// growth — the higher you climb, the more each safe pick pays.
export const LANE_POINTS = [10, 20, 40, 80, 150, 300, 600, 1200];

// Difficulty multiplier on points — hard isn't just worse odds, it
// pays more for surviving them.
export const DIFFICULTY_POINT_MULT = Object.freeze({
  easy: 1,
  medium: 1.5,
  hard: 2,
});

// ── Risk paths (the core skill mechanic) ──────────────────────────
// On every lane you CHOOSE your odds: pick a wider path (safer, fewer
// points) or a narrower one (riskier, more points). Each path's bad
// tile is provably fair on its own AND coupled to the previous lane's
// full layout (see the CROSS-PATH DEPENDENCE note below), so no path
// can be solved in isolation.
export const RISK_PATHS = Object.freeze({
  safe: {
    key: "safe",
    label: "Safe",
    tiles: 4,
    pointFactor: 1,
    color: "emerald",
  },
  balanced: {
    key: "balanced",
    label: "Balanced",
    tiles: 3,
    pointFactor: 1.6,
    color: "amber",
  },
  risky: {
    key: "risky",
    label: "Risky",
    tiles: 2,
    pointFactor: 2.5,
    color: "rose",
  },
});

export const RISK_PATH_KEYS = Object.keys(RISK_PATHS);

export function isValidPath(path) {
  return Boolean(RISK_PATHS[path]);
}

// ── Flag budget ─────────────────────────────────────────────────────
// Each player gets a small number of FLAG calls per match. A correct
// flag claims the row (advance + points, game continues) and reveals
// the bad tile to both players; a wrong flag busts you. The budget
// stops the flag from being a repeatable free-win and caps how many
// rows a solver can skip.
export const MAX_FLAGS = 2;

// Flags used so far by a seat (counted from the action history).
export function flagsUsedBySeat(match, seat) {
  const actions = Array.isArray(match?.actions) ? match.actions : [];
  return actions.filter(
    (a) => a && a.action === "flag" && a.seat === seat,
  ).length;
}

// ── Peek budget ───────────────────────────────────────────────────────
// Each player gets MAX_PEEKS private peeks per match. A peek instantly
// reveals whether a chosen tile on your current lane is safe or bad —
// to YOU only — and does not consume your turn. The scarce budget is
// the cost: spend it to convert a coin-flip risky row into a sure
// climb, or save it for a row the opponent's picks have narrowed.
export const MAX_PEEKS = 2;

// Peeks used so far by a seat (counted from the action history).
export function peeksUsedBySeat(match, seat) {
  const actions = Array.isArray(match?.actions) ? match.actions : [];
  return actions.filter(
    (a) => a && a.action === "peek" && a.seat === seat,
  ).length;
}

// Points awarded for a SAFE pick on `laneIndex` (0-based 0..7) using
// `path` at `difficulty`. Rounded to a whole number.
export function pointsForSafePick(laneIndex, path, difficulty = "easy") {
  const idx = Number(laneIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_LANES) return 0;
  const pathCfg = RISK_PATHS[path] || RISK_PATHS.safe;
  const diffMult = DIFFICULTY_POINT_MULT[difficulty] ?? 1;
  return Math.round(
    LANE_POINTS[idx] * pathCfg.pointFactor * diffMult,
  );
}

// ── Soft bank: the banked score + rate-decay helpers ────────────────
// Banking (HOLD) locks your accumulated points but never ends your
// climb. Every pick after your Nth bank earns points × 0.5^N, so
// repeated banking is expensive and banking early costs you rate
// forever. All of this is derivable from the action history — no
// extra schema columns.

// How many times a seat has banked (each hold action = one bank).
export function banksUsedBySeat(match, seat) {
  const actions = Array.isArray(match?.actions) ? match.actions : [];
  return actions.filter(
    (a) => a && a.action === "hold" && a.seat === seat,
  ).length;
}

// Has the seat banked at least once?
export function hasBanked(match, seat) {
  return banksUsedBySeat(match, seat) > 0;
}

// Point rate after `banks` banks: 1, 0.5, 0.25, …
export function bankRate(banks) {
  return Math.pow(0.5, Number(banks) || 0);
}

// The seat's current bank rate, from its action history.
export function bankRateForSeat(match, seat) {
  return bankRate(banksUsedBySeat(match, seat));
}

// Points a safe pick/flag on `path` at `laneIndex` is worth for a
// seat, including the bank-rate decay.
export function pickPointsForSeat(match, seat, laneIndex, path, difficulty = "easy") {
  return Math.round(
    pointsForSafePick(laneIndex, path, difficulty) * bankRateForSeat(match, seat),
  );
}

// The seat's locked banked total: the bankedTotal recorded on their
// most recent hold action (0 if they never banked).
export function bankedScoreOf(match, seat) {
  const actions = Array.isArray(match?.actions) ? match.actions : [];
  let last = 0;
  for (const a of actions) {
    if (a && a.action === "hold" && a.seat === seat && a.bankedTotal != null) {
      last = Number(a.bankedTotal) || 0;
    }
  }
  return last;
}

// Whether the seat has busted (picked a bad tile or thrown a wrong
// flag) — their climb is over and unbanked points are lost.
export function hasBusted(match, seat) {
  const actions = Array.isArray(match?.actions) ? match.actions : [];
  return actions.some((a) => a && a.seat === seat && a.safe === false);
}

// Whether the seat's climb is over: busted, or completed the tower.
// Banking does NOT end a climb.
export function climbEnded(match, seat) {
  if (!match) return false;
  const lane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;
  return lane >= MAX_LANES || hasBusted(match, seat);
}

// Both climbs are over.
export function bothEnded(match) {
  return climbEnded(match, "player1") && climbEnded(match, "player2");
}

// What a player KEEPS when the match settles:
//   • Busted → their last banked total (0 if never banked) — the
//     insurance banking buys; unbanked points are lost.
//   • Completed → their full accumulated score.
//   • Banked but still active when the other side ends it → their
//     banked total (only banked points are safe).
//   • Active with no bank when the opponent busts → their
//     accumulated score (they survived; the opponent lost all).
export function finalScoreOf(match, seat) {
  if (hasBusted(match, seat)) return bankedScoreOf(match, seat);
  const accumulated = scoreFromActions(match.actions, seat);
  if (climbEnded(match, seat)) return accumulated; // completed
  return hasBanked(match, seat) ? bankedScoreOf(match, seat) : accumulated;
}

// Total points from an action history for a seat. Counts every SAFE
// action — safe picks AND correct flags both carry `safe: true` +
// points (a correct flag claims the row exactly like a safe pick).
// Holds, busts, and wrong flags never carry points.
export function scoreFromActions(actions, seat) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) {
    if (a && a.safe === true && a.seat === seat) {
      total += Number(a.points) || 0;
    }
  }
  return total;
}

// ── Bot identity for Test vs Bot practice matches ─────────────────
// The same reserved clerkId-style id dice-duel uses (`AI_BOT`), so
// practice opponents are recognisable everywhere without a schema
// column. Bot matches are zero-stake: no escrow, no payout, no
// leaderboard stats — pure practice.
export const BOT_USER_ID = "AI_BOT";

export function isBotUser(userId) {
  return userId === BOT_USER_ID;
}

// Is this match a Test vs Bot practice match? True when the second
// seat is the reserved bot id.
export function isBotMatch(match) {
  return Boolean(match && isBotUser(match.player2Id));
}

// Multiplier at a given lane step for a difficulty (kept for
// backwards-compat with tests and the fair-reveal copy; the UI now
// scores by POINTS, not multipliers).
export function laneMultiplier(lane, difficulty = "easy") {
  return getMultiplier(lane, 0, difficulty);
}

// ── Status state machine ─────────────────────────────────────────
// Six states — identical shape to mines-pvp: host creates (waiting),
// player2 joins (ready → 3s banner → p1_turn/p2_turn), the active
// player picks or holds (→ other turn or finished), `cancelled` is
// reachable when the host leaves before player2 joins.
export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  P1_TURN: "p1_turn",
  P2_TURN: "p2_turn",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match is still in progress (not yet terminal).
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.P1_TURN,
  MATCH_STATUS.P2_TURN,
]);

// States where a pick/hold action is accepted. `READY` is excluded
// (the brief auto-transition window after both players join).
export const PICKABLE_STATES = new Set([
  MATCH_STATUS.P1_TURN,
  MATCH_STATUS.P2_TURN,
]);

// Terminal states — no further state transitions allowed.
export const TERMINAL_STATES = new Set([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

// Auto-advance window between player2 joining and the first turn.
export const READY_WINDOW_MS = 3000;

// Auto-advance window between FINISHED and the client being allowed
// to navigate back to the lobby.
export const FINISHED_GRACE_MS = 5000;

// ── Per-turn window ───────────────────────────────────────────────
export const ROUND_TIMER_SECONDS = 20;
export const ROUND_PICK_DEADLINE_MS = ROUND_TIMER_SECONDS * 1000;

// ── Stake matchmaking constants ───────────────────────────────────
export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MIN_STAKE = 1;
export const MAX_STAKE = 1000000;

// ── House fee (10% rake on the LOSER's stake) ─────────────────────
export const HOUSE_FEE_PCT = 0.1;
export const WINNER_RATIO = 0.9;
export const HOUSE_RATIO = 0.1;

// ── Result string constants ───────────────────────────────────────
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
});

// ── Stake-key advisory-lock namespace ─────────────────────────────
// "LRD!" packed: L=0x4C, R=0x52, D=0x44, !=0x21 → 0x4c524421 &
// 0x7fffffff keeps it a positive 32-bit signed integer.
export const LANE_RUSH_DUEL_LOCK_NAMESPACE = 0x4c524421 & 0x7fffffff;

// ── Tower generation (provably fair + deduction constraints) ──
// The tower is, per lane, the bad tile for EACH risk path:
//   [{ safe: b, balanced: b, risky: b }, ...]  (8 lanes)
// Every bad tile derives from a SHA-256 digest of the SHARED server
// seed + the client seed + the match id + (lane, path) + the PREVIOUS
// lane's full bad-tile set, so every path is independently verifiable
// post-match.
//
// CROSS-PATH DEPENDENCE (the anti-isolation rule): each lane's digest
// hashes the previous lane's bad tile on ALL THREE paths, not just
// the path being derived. A player who only tracks one path cannot
// predict its next bad tile — the layout depends on the other paths,
// which you only learn by playing (or observing) them. No single
// path can be solved in isolation.
//
// SAME-PATH MEMORY RULE (safe/balanced only): a bad tile never sits
// in the same position as the previous lane's bad tile on the SAME
// path. On a 4- or 3-tile path this just eliminates one candidate
// from the next lane's odds — a documented, deterministic constraint
// anyone can re-derive and verify.
//
// CROSS-PATH CONSTRAINT (risky path only): the risky path's bad tile
// never sits in the previous lane's SAFE bad-tile position (when that
// position is in risky range 0..1). Solving the safe path therefore
// constrains the risky path — the "reason across paths" skill. There
// is deliberately NO same-path memory rule on risky: a "never repeat"
// rule on a 2-tile path would force a 0,1,0,1 alternation, making the
// entire risky path solvable from a single safe pick.
export function buildPlayerTower({ serverSeed, clientSeed, nonce, difficulty }) {
  const tower = [];
  const prevBad = { safe: -1, balanced: -1, risky: -1 };
  for (let lane = 0; lane < DEFAULT_LANES; lane += 1) {
    const entry = {};
    // The previous lane's FULL bad-tile set feeds every path's digest
    // (lane 0 has no previous row → a sentinel triple).
    const prevRow = lane > 0 ? tower[lane - 1] : null;
    const prevTriple = prevRow
      ? [prevRow.safe, prevRow.balanced, prevRow.risky].join(":")
      : "-1:-1:-1";
    for (const pathKey of RISK_PATH_KEYS) {
      const cfg = RISK_PATHS[pathKey];
      const { digest } = simulateLaneDigest(
        serverSeed,
        clientSeed,
        nonce,
        lane,
        pathKey,
        prevTriple,
      );
      let badTile = Number.parseInt(digest.slice(0, 8), 16) % cfg.tiles;
      if (pathKey === "risky") {
        // Cross-path constraint: never sit in the previous lane's SAFE
        // bad-tile position (when that position is in risky range 0..1).
        // No same-path memory rule — a "never repeat" rule on a 2-tile
        // path would force alternation and make risky solvable alone.
        const safePrev = prevRow ? prevRow.safe : -1;
        if (safePrev >= 0 && safePrev < 2 && badTile === safePrev) {
          badTile = badTile === 0 ? 1 : 0;
        }
      } else if (badTile === prevBad[pathKey] && cfg.tiles > 1) {
        // Same-path memory rule (safe/balanced only): never repeat the
        // previous lane's bad tile on this path. Deterministic bump —
        // auditable by anyone re-deriving.
        badTile = (badTile + 1) % cfg.tiles;
      }
      prevBad[pathKey] = badTile;
      entry[pathKey] = badTile;
    }
    tower.push(entry);
  }
  return tower;
}

// SHA-256 digest for a specific lane+path of the tower. The previous
// lane's full bad-tile triple is part of the input, so the layout of
// every path is coupled to the whole previous row.
function simulateLaneDigest(serverSeed, clientSeed, nonce, lane, path, prevTriple) {
  const digest = crypto
    .createHash("sha256")
    .update(
      `${serverSeed}:${clientSeed}:${nonce}:${lane}:${path}:${prevTriple}`,
    )
    .digest("hex");
  return { digest };
}

// ── Outcome resolver ──────────────────────────────────────────────
// Given the loser (the player who busted on a bad tile), decide the
// match result. Pure mapping — no DB, no state.
export function decideOutcome({ loserId, player1Id, player2Id }) {
  if (loserId === player1Id) return RESULT.PLAYER2;
  if (loserId === player2Id) return RESULT.PLAYER1;
  throw new RangeError(
    `decideOutcome: loserId must equal player1Id or player2Id, got ${loserId}`,
  );
}

// ── Payout calculator ─────────────────────────────────────────────
// { stake, winnerNet, loserNet, houseFee, prizePaid }
//   DRAW:    both refunded. winnerNet = loserNet = null, fees = 0.
//   PLAYER1: player1 gets (stake + 0.9*stake); player2 loses stake;
//            house rake = 0.1*stake. prizePaid = 1.9*stake.
export function computePayout({ stakeAmount, result }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake < 0) {
    throw new RangeError(
      `computePayout: stakeAmount must be a non-negative number, got ${stakeAmount}`,
    );
  }
  if (![RESULT.PLAYER1, RESULT.PLAYER2, RESULT.DRAW].includes(result)) {
    throw new RangeError(
      `computePayout: result must be one of player1|player2|draw, got ${result}`,
    );
  }
  if (result === RESULT.DRAW) {
    return {
      stake: round2(stake),
      winnerNet: null,
      loserNet: null,
      houseFee: round2(0),
      prizePaid: round2(0),
    };
  }
  const winnerPrize = round2(stake * WINNER_RATIO);
  const houseFee = round2(stake * HOUSE_RATIO);
  return {
    stake: round2(stake),
    winnerNet: round2(stake + winnerPrize),
    loserNet: round2(-stake),
    houseFee,
    prizePaid: round2(stake + winnerPrize),
  };
}

// ── Bot strategy (pure + deterministic for tests) ─────────────────
// The practice bot's skill is its risk calibration + BANK timing, not
// x-ray vision: it picks tiles at random (same bust odds as a human)
// but CHOOSES its path from the game state — safer when ahead,
// riskier when behind — and banks to race toward the 1,000-banked
// win. Because banking halves the bot's future rate, it only banks
// when locking points is worth the penalty.
//
// Decision rules, in order:
//   1. Bot's climb is over (busted/completed) → cannot act.
//   2. Bot's accumulated score ≥ WIN_BANKED_SCORE → bank now: the
//      banked total hits 1,000 and the race is won instantly.
//   3. Player busted and the bot hasn't banked → bank now (locks
//      insurance: any bank beats the player's final in the fallback,
//      and the bot keeps climbing toward 1,000 banked).
//   4. Bot hasn't banked: bank when it clears the player's target
//      (their banked total, or accumulated score while they climb),
//      or when comfortably ahead at its own target.
//   5. Bot already banked (reduced rate): re-bank when it has
//      materially out-grown its floor (raising the locked total
//      toward 1,000) or to leapfrog the player's bank.
//   6. Otherwise → pick, choosing path by position: ahead → safe,
//      even → balanced, behind → risky.
//
// Returns { action: "hold" } | { action: "pick", path, tileIndex }.
export function decideBotAction(match, { random = Math.random } = {}) {
  if (!match) return null;
  if (match.currentTurnUserId !== BOT_USER_ID) return null;
  if (climbEnded(match, "player2")) return null; // busted/completed

  const difficulty = match.difficulty || "easy";
  const botBanked = hasBanked(match, "player2");
  const botBankedScore = bankedScoreOf(match, "player2");
  const p2Score = scoreFromActions(match.actions, "player2");
  const playerEnded = climbEnded(match, "player1");
  const playerBanked = hasBanked(match, "player1");
  const playerTarget = playerBanked
    ? bankedScoreOf(match, "player1")
    : scoreFromActions(match.actions, "player1");

  // Rule 2: the winning bank — accumulated ≥ 1,000 locks a 1,000+
  // banked total, which is an instant win.
  if (p2Score >= WIN_BANKED_SCORE) {
    return { action: "hold" };
  }

  // Points the bot wants before it willingly banks while ahead
  // (difficulty-scaled fraction of the 1,000 target).
  const targets = { easy: 350, medium: 600, hard: 1000 };
  const base = targets[difficulty] ?? 600;
  const target = base * (0.85 + random() * 0.3);

  // Rule 3: the player is done (busted) and the bot has nothing
  // locked — bank now to lock insurance (any bank beats the player's
  // final in the fallback), then keep climbing toward 1,000.
  if (playerEnded && !botBanked) {
    return { action: "hold" };
  }

  if (!botBanked) {
    // Rule 4: first bank — lock the lead when the bot clears the
    // player's target, or when comfortably ahead at its own target.
    if (playerBanked && p2Score > playerTarget) return { action: "hold" };
    if (p2Score >= target && p2Score >= playerTarget) return { action: "hold" };
  } else {
    // Rule 5: already banked — picks pay half (or less). Re-bank
    // when materially ahead of the floor (raising the locked total
    // toward 1,000) or to leapfrog the player's bank.
    if (!playerEnded && p2Score >= botBankedScore + target * 0.5) {
      return { action: "hold" };
    }
    if (playerBanked && p2Score > playerTarget && botBankedScore < playerTarget) {
      return { action: "hold" }; // catch-up lock
    }
  }

  // Rule 6: choose the path by position — protect a lead, gamble to
  // catch up.
  const path =
    p2Score > playerTarget
      ? "safe"
      : p2Score === playerTarget
        ? "balanced"
        : "risky";
  return { action: "pick", path, tileIndex: pickRandomTile(RISK_PATHS[path].tiles, random) };
}

// Random tile index in [0, tilesPerLane) — the bot picks blind, same
// bust probability as a human player.
export function pickRandomTile(tilesPerLane, random = Math.random) {
  return Math.floor(random() * tilesPerLane);
}

// ── Zugzwang pressure math (used by the match page's pressure strip)
// A banked SCORE is the target: to BEAT it you must out-score it. The
// number of SAFE picks that implies depends on the path you take
// (risky paths score more per pick, so they close a deficit faster).
// These helpers return how many safe picks on a given path are needed
// to reach (beat) a target score — the countdown the strip displays.
// Returns 0 when already at/above the target (the chicken game is
// already decided in the climber's favour).
export function safePicksToReachScore(targetScore, currentScore, path, difficulty = "easy") {
  const target = Number(targetScore);
  const current = Number(currentScore);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return 0;
  if (current >= target) return 0;
  const pathCfg = RISK_PATHS[path] || RISK_PATHS.balanced;
  // Average points per safe pick on this path across remaining lanes.
  const avg = averagePointsPerPick(path, difficulty);
  if (avg <= 0) return 0;
  return Math.ceil((target - current) / avg);
}

// Mean points of a single safe pick on `path` over the whole tower —
// used to translate a point deficit into a "picks needed" estimate.
export function averagePointsPerPick(path, difficulty = "easy") {
  const pathCfg = RISK_PATHS[path] || RISK_PATHS.balanced;
  const diffMult = DIFFICULTY_POINT_MULT[difficulty] ?? 1;
  const sum = LANE_POINTS.reduce((acc, p) => acc + p * pathCfg.pointFactor, 0);
  return (sum * diffMult) / MAX_LANES;
}

// Probability of surviving `picks` consecutive safe picks when each
// lane hides 1 bad tile out of `tilesPerLane`. This is the odds of
// a blind (random-tile) climber actually overtaking the hold — the
// number the pressure strip displays. When `tilesPerLane` is null,
// defaults to a 3-tile (balanced) path.
export function survivalOdds(picks, tilesPerLane) {
  const n = Number(picks);
  const w = Number(tilesPerLane);
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (!Number.isFinite(w) || w < 2) return 0;
  return Math.pow((w - 1) / w, n);
}

// ── Live deduction tracker (candidate counts per lane + path) ───────
// For every lane and risk path, how many tiles could STILL be the
// bad tile given everything both players have revealed on the shared
// tower:
//   • every safe pick (either player's) eliminates that tile,
//   • a CORRECT flag reveals the bad tile exactly (solved),
//   • the SAME-PATH memory rule (safe/balanced only): a solved
//     previous row eliminates its bad tile from the next row's
//     candidates on that same path,
//   • the CROSS-PATH constraint (risky only): a solved SAFE row
//     eliminates its bad tile from the NEXT row's risky candidates
//     (when that position is in risky range 0..1) — the one place a
//     solved row constrains a DIFFERENT path.
// Returns a map `row → path → { candidates, solved, badTile }` for
// all MAX_LANES rows. `badTile` is the known position when `solved`
// (flag reveal or a single remaining candidate) — the player can then
// pick the other tile(s) with certainty.
//
// Because of CROSS-PATH DEPENDENCE, a solved row can only ever
// ELIMINATE candidates from the next row — it never reveals the next
// bad tile outright, since that layout also mixes in the other paths'
// previous tiles, which aren't all known. Solving one path in
// isolation is therefore impossible; the tracker stays exact because
// these are the only deterministic constraints.
export function computeDeductions(actions = []) {
  const picksByRowPath = new Map(); // "row:path" → Set of survived tiles
  const flagsByRowPath = new Map(); // "row:path" → correct-flag tile

  for (const a of actions) {
    if (!a || a.safe !== true || !a.path) continue;
    const key = `${a.round ?? a.lane}:${a.path}`;
    if (a.action === "flag") {
      flagsByRowPath.set(key, a.tile);
    } else {
      if (!picksByRowPath.has(key)) picksByRowPath.set(key, new Set());
      picksByRowPath.get(key).add(a.tile);
    }
  }

  const result = {};
  const prevExact = {}; // path → exact bad tile of the PREVIOUS row

  for (let row = 0; row < MAX_LANES; row += 1) {
    result[row] = {};
    const rowExact = {}; // this row's solved tiles, committed after the loop
    for (const path of RISK_PATH_KEYS) {
      const tiles = RISK_PATHS[path].tiles;
      const flagTile = flagsByRowPath.get(`${row}:${path}`);
      if (flagTile !== undefined) {
        // A correct flag claimed the row: the bad tile is known.
        result[row][path] = { candidates: 1, solved: true, badTile: flagTile };
        rowExact[path] = flagTile;
        continue;
      }
      const survived = picksByRowPath.get(`${row}:${path}`) || new Set();
      const prev = prevExact[path];
      const candidates = [];
      for (let t = 0; t < tiles; t += 1) {
        if (survived.has(t)) continue;
        // Same-path memory rule (safe/balanced only): a solved previous
        // row never repeats its bad tile on this path.
        if (path !== "risky" && prev !== null && prev !== undefined && t === prev) {
          continue;
        }
        // Cross-path constraint (risky only): never sit in the previous
        // row's SAFE bad-tile position (when in risky range 0..1).
        if (path === "risky") {
          const safePrev = prevExact.safe;
          if (
            safePrev !== null &&
            safePrev !== undefined &&
            safePrev < 2 &&
            t === safePrev
          ) {
            continue;
          }
        }
        candidates.push(t);
      }
      const solved = candidates.length === 1;
      result[row][path] = {
        candidates: candidates.length,
        solved,
        badTile: solved ? candidates[0] : null,
      };
      rowExact[path] = solved ? candidates[0] : null;
    }
    // Commit this row's solved tiles as the "previous row" for the next
    // lane — so risky's cross-path check reads the SAFE tile of THIS
    // previous row, not the current one.
    for (const path of RISK_PATH_KEYS) prevExact[path] = rowExact[path];
  }
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────
export function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

// Whether a player is "done climbing" — held, or completed the tower
// (lane === MAX_LANES). A done player never picks again.
export function isPlayerDone(lane, held) {
  return Boolean(held) || lane >= MAX_LANES;
}

// Whether BOTH players are done — the match is ready to resolve via
// lane comparison (no one can still bust).
export function bothDone(match) {
  return (
    isPlayerDone(Number(match.p1Lane) || 0, Boolean(match.p1Held)) &&
    isPlayerDone(Number(match.p2Lane) || 0, Boolean(match.p2Held))
  );
}

// Seat label for a clerkId. Returns "player1" | "player2" | null.
export function seatForUserId(match, userId) {
  if (match.player1Id === userId) return "player1";
  if (match.player2Id === userId) return "player2";
  return null;
}

// The clerkId of the opponent of `userId`.
export function opponentOf(match, userId) {
  if (match.player1Id === userId) return match.player2Id;
  if (match.player2Id === userId) return match.player1Id;
  return null;
}
