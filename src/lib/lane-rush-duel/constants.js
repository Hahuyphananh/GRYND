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
// Each player races their OWN provably-fair tower (same difficulty),
// alternating turns. On your turn you either:
//   • PICK a tile in your current lane — safe advances your lane
//     (multiplier grows), bad busts you (instant loss).
//   • HOLD — bank your current lane as your final score. This is
//     the flag-to-win chicken move: you stop risking, and the
//     opponent must climb PAST your lane to beat you (or bust
//     trying).
//
// Terminal conditions:
//   • Bust (picked the bad tile)       → the OTHER player wins.
//   • Completed all 8 lanes            → completer wins outright
//     (no one can climb past the top).
//   • Both players held (or completed) → higher lane wins;
//     equal lanes → DRAW (full refund, no house fee).
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
// points) or a narrower one (riskier, more points). The bad-tile
// layout for each path is derived independently from the seed, so
// each path is provably fair on its own.
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

// Total points from an action history for a seat (sum of safe picks).
export function scoreFromActions(actions, seat) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) {
    if (a && a.action === "pick" && a.safe === true && a.seat === seat) {
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

// ── Tower generation (provably fair + the bad-tile memory rule) ──
// Each player's tower is, per lane, the bad tile for EACH risk path:
//   [{ safe: b, balanced: b, risky: b }, ...]  (8 lanes)
// Every bad tile derives from a SHA-256 digest of the SHARED server
// seed + that player's own client seed + the match id + (lane, path),
// so every path is independently verifiable post-match.
//
// Bad-tile MEMORY RULE (the deduction mechanic): a bad tile can never
// sit in the same position as the previous lane's bad tile on the
// SAME path. A player who tracks what they've seen can eliminate one
// tile from the next lane's odds — e.g. on a 3-tile path, knowing the
// last bad tile was position 2 narrows the next guess to 2 options.
// This is a documented, deterministic constraint — anyone can
// re-derive the towers and verify it.
export function buildPlayerTower({ serverSeed, clientSeed, nonce, difficulty }) {
  const tower = [];
  const prevBad = { safe: -1, balanced: -1, risky: -1 };
  for (let lane = 0; lane < DEFAULT_LANES; lane += 1) {
    const entry = {};
    for (const pathKey of RISK_PATH_KEYS) {
      const cfg = RISK_PATHS[pathKey];
      const { digest } = simulateLaneDigest(
        serverSeed,
        clientSeed,
        nonce,
        lane,
        pathKey,
      );
      let badTile = Number.parseInt(digest.slice(0, 8), 16) % cfg.tiles;
      // Memory rule: never repeat the previous lane's bad tile on this
      // path. Deterministic bump — auditable by anyone re-deriving.
      if (badTile === prevBad[pathKey] && cfg.tiles > 1) {
        badTile = (badTile + 1) % cfg.tiles;
      }
      prevBad[pathKey] = badTile;
      entry[pathKey] = badTile;
    }
    tower.push(entry);
  }
  return tower;
}

// SHA-256 digest for a specific lane+path of a player's tower.
function simulateLaneDigest(serverSeed, clientSeed, nonce, lane, path) {
  const digest = crypto
    .createHash("sha256")
    .update(`${serverSeed}:${clientSeed}:${nonce}:${lane}:${path}`)
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
// The practice bot's skill is its risk calibration + HOLD timing, not
// x-ray vision: it picks tiles at random (same bust odds as a human)
// but CHOOSES its path from the game state — safer when ahead,
// riskier when behind — and banks when its points clear its target.
//
// Decision rules, in order:
//   1. Already past the player's banked SCORE → hold (bank the win).
//   2. Player banked and bot behind → keep climbing, choosing a
//      riskier path the bigger the deficit (chicken game).
//   3. Player still climbing, bot ahead with points ≥ target → hold.
//   4. Otherwise → pick, choosing path by position: ahead → safe,
//      even → balanced, behind → risky.
//
// Returns { action: "hold" } | { action: "pick", path, tileIndex }.
export function decideBotAction(match, { random = Math.random } = {}) {
  if (!match) return null;
  if (match.currentTurnUserId !== BOT_USER_ID) return null;
  if (isPlayerDone(Number(match.p2Lane) || 0, Boolean(match.p2Held))) {
    return null; // bot already banked or completed — cannot act
  }

  const difficulty = match.difficulty || "easy";
  const playerHeld = Boolean(match.p1Held);
  const p1Score = scoreFromActions(match.actions, "player1");
  const p2Score = scoreFromActions(match.actions, "player2");

  // Points the bot wants before it willingly banks while ahead.
  const targets = { easy: 350, medium: 600, hard: 1000 };
  const base = targets[difficulty] ?? 600;
  const target = base * (0.85 + random() * 0.3);

  if (playerHeld && p2Score > p1Score) {
    // Bank the win — never keep risking a position that already wins.
    return { action: "hold" };
  }

  if (playerHeld) {
    // Player banked and bot is behind: climb past them or bust
    // trying. Bigger deficit → riskier path (need points fast).
    const deficit = p1Score - p2Score;
    const path =
      deficit > 500 ? "risky" : deficit > 150 ? "balanced" : "safe";
    return { action: "pick", path, tileIndex: pickRandomTile(RISK_PATHS[path].tiles, random) };
  }

  // Player still climbing. Hold when ahead and at target.
  if (p2Score >= target && p2Score > p1Score) {
    return { action: "hold" };
  }

  // Choose the path by position: protect a lead, gamble to catch up.
  const path =
    p2Score > p1Score ? "safe" : p2Score === p1Score ? "balanced" : "risky";
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
