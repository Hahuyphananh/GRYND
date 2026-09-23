// src/lib/keno-pvp/engine.js
//
// Pure game logic for the 1v1 Keno SURVIVAL DUEL — no DB, no side
// effects, fully unit-testable. The server store calls these helpers to
// stay authoritative; the client imports the same window helper so its
// ring/timer always agrees with the server's grading.
//
// The skill model: ONE tile is lit at a time and BOTH players race for
// it, but the race is for the TILE, not for your opponent's life. You
// lose a life for your OWN miss only — you did not tap the tile before
// its window closed. Beating your opponent to it credits you the tile
// (which is also the exhausted-board tiebreak) and costs them nothing,
// so a faster opponent can no longer bleed you dry; a slower one still
// can. The window tightens with every claimed tile, so the match ends as
// a pure test of whether you can keep tapping in time. Lose all your
// lives and the match is over (both eliminated on the same both-miss at
// once → DRAW).

import {
  KENO_POOL_SIZE,
  MIN_WINDOW_MS,
  RESULT,
  STARTING_LIVES,
  START_WINDOW_MS,
  TAP_GRACE_MS,
  WINDOW_STEP_MS,
} from "./constants";

// A lives value that is missing or malformed must never be read as "this
// player is eliminated" (a nil column would otherwise end a live match).
// Anything unusable falls back to a full bar.
function lifeOr(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return STARTING_LIVES;
  return Math.max(0, Math.trunc(n));
}

// ── Deterministic hashing ─────────────────────────────────────────────
// FNV-1a 32-bit. Used for the tile pick and the AI plan so a match can be
// replayed deterministically from its id, while still looking random to
// the players (the seed is server-side only).
function hash32(text) {
  const value = String(text ?? "");
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// ── The shrinking window ──────────────────────────────────────────────

/**
 * How long the live tile stays claimable after `claimedTotal` tiles have
 * been claimed in this match. Starts at START_WINDOW_MS and tightens by
 * WINDOW_STEP_MS per claim, never below MIN_WINDOW_MS.
 *
 * Both players (and the server) derive the SAME window from the same
 * public claim count, so the ring a player sees is the window the server
 * grades against.
 */
export function tileWindowMs(claimedTotal) {
  const claimed = Number(claimedTotal);
  const n = Number.isFinite(claimed) && claimed > 0 ? Math.floor(claimed) : 0;
  return Math.max(MIN_WINDOW_MS, START_WINDOW_MS - WINDOW_STEP_MS * n);
}

/** Milliseconds left in the current window (never negative). */
export function windowRemainingMs({ deadlineMs, atMs }) {
  const deadline = Number(deadlineMs);
  const at = Number(atMs);
  if (!Number.isFinite(deadline) || !Number.isFinite(at)) return 0;
  return Math.max(0, deadline - at);
}

// ── Tile draw ─────────────────────────────────────────────────────────

/** Normalise a stored `used_tiles` jsonb value into a Set of 1..40. */
export function usedTileSet(usedTiles) {
  const set = new Set();
  if (!Array.isArray(usedTiles)) return set;
  for (const raw of usedTiles) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= KENO_POOL_SIZE) set.add(n);
  }
  return set;
}

/** Board numbers not yet drawn this match (ascending). */
export function remainingTiles(usedTiles) {
  const used = usedTileSet(usedTiles);
  const out = [];
  for (let n = 1; n <= KENO_POOL_SIZE; n += 1) if (!used.has(n)) out.push(n);
  return out;
}

/**
 * The next live tile: a deterministic pick from the numbers this match
 * has not drawn yet, keyed on the match seed + the tile index. Returns
 * null when the board is exhausted (the caller settles the match).
 */
export function pickLiveTile({ seed = "", index = 0, used = [] } = {}) {
  const remaining = remainingTiles(used);
  if (remaining.length === 0) return null;
  const h = hash32(`${seed}:tile:${Math.trunc(Number(index) || 0)}`);
  return remaining[h % remaining.length];
}

// ── Claim grading ─────────────────────────────────────────────────────

/**
 * True when a claim arriving at `atMs` was made while the tile was lit —
 * i.e. inside [startedMs, deadlineMs + grace]. The grace is the hidden
 * network cushion (TAP_GRACE_MS): a tap sent while the tile was visibly
 * glowing still counts, so a slow connection never turns a winning tap
 * into a both-miss. Taps earlier than `startedMs` (a race with the
 * previous tile's resolution) and taps past the grace are rejected.
 */
export function isClaimInWindow({
  atMs,
  startedMs,
  deadlineMs,
  graceMs = TAP_GRACE_MS,
}) {
  const at = Number(atMs);
  const started = Number(startedMs);
  const deadline = Number(deadlineMs);
  const grace = Number.isFinite(Number(graceMs)) ? Number(graceMs) : TAP_GRACE_MS;
  if (!Number.isFinite(at) || !Number.isFinite(started) || !Number.isFinite(deadline)) {
    return false;
  }
  return at >= started && at <= deadline + grace;
}

// ── Outcome resolution ────────────────────────────────────────────────

/**
 * Lives after a resolved tile: every player who MISSED it loses one.
 *
 * A miss is personal — it means that player never tapped the tile while
 * its window was open. Tapping it, even a fraction after the opponent
 * did, is not a miss and costs nothing. So the two flags move
 * independently and the three possible outcomes fall out of them:
 *
 *   both tapped   → nobody loses a life
 *   one tapped    → only the other loses one
 *   neither tapped → both lose one
 */
export function applyMissesToLives({ p1Lives, p2Lives, p1Missed, p2Missed }) {
  const p1 = lifeOr(p1Lives);
  const p2 = lifeOr(p2Lives);
  return {
    p1Lives: p1Missed ? Math.max(0, p1 - 1) : p1,
    p2Lives: p2Missed ? Math.max(0, p2 - 1) : p2,
  };
}

/** Lives after a both-miss: neither player tapped, so both lose one. */
export function applyBothMissToLives({ p1Lives, p2Lives }) {
  return applyMissesToLives({ p1Lives, p2Lives, p1Missed: true, p2Missed: true });
}

/**
 * The match result from the survival state, or null when the match is
 * still live.
 *
 *   * A player at 0 lives is eliminated; the other side wins.
 *   * Both at 0 (a both-miss that takes the last life from each) → DRAW.
 *   * `exhausted` (the 1..40 board has no tile left to draw) → the
 *     higher life count wins; equal lives fall through to tiles claimed;
 *     still equal → DRAW.
 */
export function decideSurvivalResult({
  p1Lives,
  p2Lives,
  p1Tiles = 0,
  p2Tiles = 0,
  exhausted = false,
} = {}) {
  const l1 = lifeOr(p1Lives);
  const l2 = lifeOr(p2Lives);
  if (l1 <= 0 && l2 <= 0) return RESULT.DRAW;
  if (l2 <= 0) return RESULT.PLAYER1;
  if (l1 <= 0) return RESULT.PLAYER2;
  if (!exhausted) return null;
  // Lives first (they ARE the score), then the tiles each player claimed.
  if (l1 > l2) return RESULT.PLAYER1;
  if (l2 > l1) return RESULT.PLAYER2;
  const t1 = Math.max(0, Math.trunc(Number(p1Tiles) || 0));
  const t2 = Math.max(0, Math.trunc(Number(p2Tiles) || 0));
  if (t1 > t2) return RESULT.PLAYER1;
  if (t2 > t1) return RESULT.PLAYER2;
  return RESULT.DRAW;
}

// ── Public tile log ───────────────────────────────────────────────────
//
// One entry per resolved tile, in order. Public to both players: a tile
// that has been resolved is finished information (both players watched
// it happen), so it powers the match feed and the board's claimed/missed
// states. Entries are small and the log is capped at the board size.

export const TILE_OUTCOME = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  // Both players tapped in time: the faster one is credited the tile (and
  // `outcome` names them), but NEITHER loses a life.
  BOTH_CLAIM: "both_claim",
  BOTH_MISS: "both_miss",
});

/**
 * Build one log entry. `p1Lives`/`p2Lives` are the post-resolution pair, so
 * a client replaying the log never has to recompute the rules.
 *
 * `p1Claimed`/`p2Claimed` record who tapped, which is what the board and
 * the feed paint from — with two players able to claim the same tile, the
 * single `outcome` string is not enough on its own. `reactionMs` stays as
 * the credited claimant's reaction; the per-player reactions carry both.
 */
export function tileLogEntry({
  tile,
  index,
  outcome,
  at,
  p1Lives,
  p2Lives,
  windowMs,
  reactionMs = null,
  p1Claimed = null,
  p2Claimed = null,
  p1ReactionMs = null,
  p2ReactionMs = null,
}) {
  const msOrNull = (value) =>
    value == null || !Number.isFinite(Number(value))
      ? null
      : Math.max(0, Math.trunc(Number(value)));

  // Entries written before the own-miss rules carry no per-player flags.
  // Derive them from the legacy outcome so replaying an old match still
  // paints each board identically.
  const claimedFromOutcome = (seat) => {
    if (outcome === TILE_OUTCOME.BOTH_MISS) return false;
    if (outcome === TILE_OUTCOME.BOTH_CLAIM) return true;
    return outcome === seat;
  };

  return {
    tile: Number(tile),
    index: Math.max(0, Math.trunc(Number(index) || 0)),
    outcome,
    at: new Date(at ?? Date.now()).toISOString(),
    p1Lives: Math.max(0, Math.trunc(Number(p1Lives) || 0)),
    p2Lives: Math.max(0, Math.trunc(Number(p2Lives) || 0)),
    windowMs: Math.max(0, Math.trunc(Number(windowMs) || 0)),
    reactionMs: msOrNull(reactionMs),
    p1Claimed: p1Claimed == null ? claimedFromOutcome("player1") : Boolean(p1Claimed),
    p2Claimed: p2Claimed == null ? claimedFromOutcome("player2") : Boolean(p2Claimed),
    p1ReactionMs: msOrNull(p1ReactionMs),
    p2ReactionMs: msOrNull(p2ReactionMs),
  };
}

/** Keep only the newest `limit` entries (defensive cap). */
export function capTileLog(log, limit = KENO_POOL_SIZE) {
  const list = Array.isArray(log) ? log.filter((e) => e && Number.isInteger(Number(e.tile))) : [];
  const max = Math.max(1, Math.trunc(Number(limit) || KENO_POOL_SIZE));
  return list.length > max ? list.slice(list.length - max) : list;
}

// ── Server AI plan ────────────────────────────────────────────────────
//
// The bot plays the same race as a human and is graded by the same server
// clock: for each tile it either decides to go for it (with a reaction
// delay drawn deterministically from the match seed) or not. A reaction
// slower than the current window is a physical miss — the bot simply
// cannot tap in time — which is what makes late tiles winnable.

// Share of tiles the bot goes for. Under the own-miss rules this IS the
// bot's survival leak: skipping a tile is a miss, and a miss costs it a
// life, so the 45% skip rate it used to run would have eliminated it on
// the seventh tile. At 90% it drops about one life per ten tiles — enough
// to lose a long match to a player who never misses, without ever being a
// pushover.
const AI_CLAIM_RATE = 0.9;

// Reaction band, in ms. This decides who is CREDITED each tile the bot
// goes for, not who loses a life — the bot either taps inside the window
// or it does not. The ceiling stays under the 0.5s floor window, so late
// tiles are a fair race rather than a coin flip.
const AI_MIN_REACTION_MS = 200;
const AI_REACTION_JITTER_MS = 220;

/**
 * The bot's plan for one live tile:
 *   { claims, reactionMs, dueAtMs | null }
 * `claims` false = the bot does not tap this tile at all (both-miss).
 * `dueAtMs` is an absolute server timestamp, so the store only has to
 * compare it against the clock.
 */
export function chooseAiClaim({
  seed = "",
  index = 0,
  tile,
  windowMs,
  startedMs = 0,
} = {}) {
  const n = Math.trunc(Number(index) || 0);
  // `Number(null)`/`Number("")` are 0 and finite, so a missing tile would
  // otherwise sail past the numeric guard and produce a plan for tile 0.
  // Reject a raw null/undefined/empty tile or window up front.
  if (tile == null || tile === "" || windowMs == null || windowMs === "") {
    return { claims: false, reactionMs: null, dueAtMs: null };
  }
  const tileNumber = Number(tile);
  const window = Number(windowMs);
  if (!Number.isFinite(tileNumber) || !Number.isFinite(window) || window <= 0) {
    return { claims: false, reactionMs: null, dueAtMs: null };
  }

  const roll = (hash32(`${seed}:${n}:${tileNumber}:go`) % 1000) / 1000;
  if (roll >= AI_CLAIM_RATE) {
    return { claims: false, reactionMs: null, dueAtMs: null };
  }

  const reactionMs =
    AI_MIN_REACTION_MS + (hash32(`${seed}:${n}:${tileNumber}:reaction`) % AI_REACTION_JITTER_MS);
  if (reactionMs > window) {
    // The window is shorter than the bot can physically react — the tile
    // goes unclaimed by the bot (the human can still take it, or it
    // both-misses).
    return { claims: false, reactionMs, dueAtMs: null };
  }

  const started = Number(startedMs);
  return {
    claims: true,
    reactionMs,
    dueAtMs: Number.isFinite(started) ? started + reactionMs : null,
  };
}

export { MIN_WINDOW_MS, START_WINDOW_MS, WINDOW_STEP_MS };
