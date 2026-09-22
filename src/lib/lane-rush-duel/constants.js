// src/lib/lane-rush-duel/constants.js
//
// Shared constants + provably-fair bridge generation + outcome
// resolution for the "Lane Rush Duel" match system. Built as a
// parallel to \`src/lib/mines-pvp/constants.js\` so the lobby + match
// flow shares the same shape (stake presets / status enum /
// advisory-lock namespace / RESULT enum) while the game logic is
// lane-rush-specific.
//
// ── Game rules (the SHARED GLASS BRIDGE) ─────────────────────────────
// Both players cross the SAME provably-fair bridge, alternating turns:
//   • ONE bridge per match: exactly BRIDGE_ROWS (10) rows, with EXACTLY
//     one bad tile per row. It never regenerates mid-match.
//   • On your turn you SELECT a tile on the row you are standing on.
//     SAFE → you cross that row and KEEP the turn (the choice window
//     resets). BAD → the tile stays BROKEN for the rest of the match,
//     your attempt ends (back to Row 1) and the turn switches.
//   • Crossing row BRIDGE_ROWS wins the match immediately.
//   • MEMORY FLAGS — BRIDGE_FLAGS_PER_PLAYER per player, placeable only
//     on a tile you personally landed on safely, public to both
//     players, append-only, and never consuming the turn.
//   • The BRIDGE_TILE_CHOICE_SECONDS window is server-authoritative:
//     letting it expire ends the attempt exactly like a bad tile (it
//     simply breaks no tile).
//
// There are NO points, NO banking, NO multipliers, NO risk paths and NO
// peek. See the SHARED BRIDGE section at the bottom of this file.
//
// Payout (90/10 split, mirrors mines-pvp / roulette-pvp):
//   Winner: own stake back + 90% of loser's stake (1.9× net)
//   Loser:   loses entire stake
//   House:   10% rake on loser's stake only
//   Draw:    both refunded, no rake

import crypto from "crypto";
import { LANE_RUNNER_DIFFICULTIES } from "../laneRunner";

// ── Re-export the difficulty table (the lobby + match UI render these
// values). The difficulty decides the tile WIDTH of every bridge row.
export const DIFFICULTIES = LANE_RUNNER_DIFFICULTIES;

// ── Practice bot seat ────────────────────────────────────────────────
// The reserved clerkId for the practice opponent, plus the two predicates
// the match flow keys off. Bot matches are zero-stake: no escrow, no payout,
// no leaderboard stats — pure practice.
export const BOT_USER_ID = "AI_BOT";

export function isBotUser(userId) {
  return userId === BOT_USER_ID;
}

// Is this match a Test vs Bot practice match? True when the second
// seat is the reserved bot id.
export function isBotMatch(match) {
  return Boolean(match && isBotUser(match.player2Id));
}

// ── Status state machine ─────────────────────────────────────────
// Identical shape to mines-pvp: host creates (waiting), player2 joins
// (ready → 3s banner → active), the seat that owns the turn selects a
// tile (→ it keeps the turn, hands it over, or the match finishes).
// `cancelled` is reachable when the host leaves before player2 joins.
// `p1_turn` / `p2_turn` are LEGACY turn states from the pre-bridge
// engine: no new match uses them, but they stay tolerated so an
// in-flight older row is still playable (the turn is seeded on read).
export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  ACTIVE: "active",
  P1_TURN: "p1_turn",
  P2_TURN: "p2_turn",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match is still in progress (not yet terminal).
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.ACTIVE,
  MATCH_STATUS.P1_TURN,
  MATCH_STATUS.P2_TURN,
]);

// States where a pick/hold action is accepted. `READY` is excluded
// (the brief auto-transition window after both players join).
export const PICKABLE_STATES = new Set([
  MATCH_STATUS.ACTIVE,
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

// Minimum gap between two practice-bot actions (the client wakes the bot
// through /ai-turn; this throttle keeps a polling loop from stacking moves).
export const BOT_ACTION_INTERVAL_MS = 1500;

// ── Stake matchmaking constants ───────────────────────────────────
export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MIN_STAKE = 1;
// Must match GLOBAL_MAX_BET in src/lib/games/economy.ts.
export const MAX_STAKE = 100000;

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

// Has this client-generated action id already been recorded? A blank
// / missing id (legacy clients, AFK picks, the bot) is never a
// duplicate — it just skips the guard.
export function hasResolvedActionId(actions, actionId) {
  const id = actionId == null ? "" : String(actionId);
  if (!id) return false;
  if (!Array.isArray(actions)) return false;
  return actions.some(
    (a) => a && a.actionId != null && String(a.actionId) === id,
  );
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

// ── Helpers ───────────────────────────────────────────────────────
export function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
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

// ══════════════════════════════════════════════════════════════════════════
// SHARED BRIDGE — memory + deduction glass bridge (ADDITIVE)
// ══════════════════════════════════════════════════════════════════════════
//
// The redesigned game plays on ONE shared bridge for the whole match:
//
//   • exactly BRIDGE_ROWS (10) rows;
//   • each row has exactly ONE bad tile — every other tile is safe;
//   • ONE bridge per MATCH, used by BOTH seats. There is deliberately no
//     per-player input anywhere below: a single committed
//     (serverSeed, clientSeed, nonce, difficulty) tuple yields the same rows
//     for player 1 and player 2, so there is no way to build a per-seat
//     bridge;
//   • it is NEVER regenerated. The layout is a pure function of the match's
//     committed seeds, so re-deriving it at any later point (a fail, a fall
//     back to row 1, a turn change, any number of picks) returns the exact
//     same rows. Callers build it once per match and persist it;
//   • the hidden safe/bad solution stays SERVER-SIDE: `buildSharedBridge()`
//     is never serialized to a client — `bridgeClientView()` is the only
//     client-safe shape and it carries nothing but the row geometry plus the
//     tiles that are already public (broken tiles / flag-revealed rows).
//
// Provably fair: each row's bad tile is the first 32 bits of
//   sha256(`${serverSeed}:${clientSeed}:${nonce}:bridge:${row}:${prevBadTile}`)
// reduced modulo the difficulty's tile count. The previous row's bad tile is
// part of the digest input and the deterministic SAME-ROW-CHAIN RULE below is
// applied before the value is used, so anyone can re-derive and audit the
// whole bridge after the match. Difficulty keeps the game's EXISTING
// difficulty-based tile count (easy 4 / medium 3 / hard 2 —
// LANE_RUNNER_DIFFICULTIES[d].width); nothing new is invented here.

/** How many rows the shared bridge has (rules: exactly 10). */
export const BRIDGE_ROWS = 10;

/** Memory flags each player gets per match (flags are a later step). */
export const BRIDGE_FLAGS_PER_PLAYER = 2;

/** Per-tile choice window in seconds (the match loop owns the timer). */
export const BRIDGE_TILE_CHOICE_SECONDS = 15;

/**
 * Tiles per row at `difficulty` — the pre-existing Lane Runner difficulty
 * widths (easy 4, medium 3, hard 2), so the bridge preserves the game's
 * established difficulty-based tile count. Unknown values fall back to easy.
 *
 * @param {string} [difficulty] "easy" | "medium" | "hard"
 * @returns {number}
 */
export function bridgeTileCountFor(difficulty = "easy") {
  const config =
    LANE_RUNNER_DIFFICULTIES[difficulty] ?? LANE_RUNNER_DIFFICULTIES.easy;
  const width = Number(config?.width);
  return Number.isInteger(width) && width > 1
    ? width
    : LANE_RUNNER_DIFFICULTIES.easy.width;
}

/**
 * Build THE shared bridge for a match. Call once per match (and persist it /
 * its commitment); every later call with the SAME committed seeds re-derives
 * the identical layout, which is what makes the bridge immutable for the
 * match.
 *
 * @param {object} opts
 * @param {string} opts.serverSeed server seed committed before the match
 * @param {string} opts.clientSeed the match's shared client seed
 * @param {number|string} opts.nonce match id / nonce
 * @param {string} [opts.difficulty] "easy" | "medium" | "hard"
 * @returns {{
 *   rows: number, tiles: number, difficulty: string,
 *   badTiles: number[], commitment: string
 * }}
 *   `badTiles[row]` = the single bad tile index of that row.
 *   SERVER-SIDE ONLY — never serialize this object to a client; hand
 *   `bridgeClientView()` out instead.
 */
export function buildSharedBridge({
  serverSeed,
  clientSeed,
  nonce,
  difficulty = "easy",
}) {
  const diff = LANE_RUNNER_DIFFICULTIES[difficulty] ? difficulty : "easy";
  const tiles = bridgeTileCountFor(diff);
  const badTiles = [];
  let prevBad = -1;

  for (let row = 0; row < BRIDGE_ROWS; row += 1) {
    const digest = crypto
      .createHash("sha256")
      .update(`${serverSeed}:${clientSeed}:${nonce}:bridge:${row}:${prevBad}`)
      .digest("hex");
    let badTile = Number.parseInt(digest.slice(0, 8), 16) % tiles;
    // Deterministic same-row-chain rule: a row's bad tile never repeats the
    // previous row's position. It removes exactly one candidate from the
    // next row (the rest stay hidden) and is auditable by re-derivation.
    if (badTile === prevBad && tiles > 1) {
      badTile = (badTile + 1) % tiles;
    }
    prevBad = badTile;
    badTiles.push(badTile);
  }

  return {
    rows: BRIDGE_ROWS,
    tiles,
    difficulty: diff,
    badTiles,
    // Commitment over the seeds + the resulting layout: publishable before
    // the match and verifiable against the revealed bridge afterwards.
    commitment: crypto
      .createHash("sha256")
      .update(
        `${serverSeed}:${clientSeed}:${nonce}:${diff}:${badTiles.join(",")}`,
      )
      .digest("hex"),
  };
}

/**
 * The row's bad tile index, or null when the row / bridge is invalid.
 *
 * @param {object} bridge result of buildSharedBridge()
 * @param {number} row 0-based row index (0..BRIDGE_ROWS-1)
 * @returns {number|null}
 */
export function badTileIndex(bridge, row) {
  const r = Number(row);
  if (!bridge || !Array.isArray(bridge.badTiles)) return null;
  if (!Number.isInteger(r) || r < 0 || r >= bridge.badTiles.length) return null;
  const idx = Number(bridge.badTiles[r]);
  return Number.isInteger(idx) ? idx : null;
}

/**
 * Whether `tile` on `row` is that row's one bad tile (server-side check).
 *
 * @param {object} bridge result of buildSharedBridge()
 * @param {number} row 0-based row index
 * @param {number} tile 0-based tile index
 * @returns {boolean}
 */
export function isBridgeTileBad(bridge, row, tile) {
  const idx = badTileIndex(bridge, row);
  return idx != null && idx === Number(tile);
}

// ── Bridge match state + rules (the new game) ────────────────────────
//
// MATCH STATE (persisted on the match row, all additive):
//   bridge      — the shared layout (see buildSharedBridge)
//   p1Row/p2Row — how many rows the seat has crossed; 0 = standing at the
//                 start, BRIDGE_ROWS = crossed the whole bridge (win)
//   broken      — every bad tile that has been stepped on, public + forever
//   p1Flags/p2Flags — the seat's memory flags, visible to both players
//   currentTurnUserId + roundDeadline — whose tile choice is live and when
//                 their 15s window closes
//
// TURN RULES:
//   • players alternate turns; a SAFE jump keeps the turn and resets the
//     15s window, a fall (bad tile) hands the turn to the opponent;
//   • a bad tile ends that attempt and sends the player back to row 1
//     (row 0 = "not crossed anything yet"); the broken tile stays broken
//     for the rest of the match;
//   • SAFE tiles are never permanently revealed — only broken tiles and
//     flags become public;
//   • first player to cross row BRIDGE_ROWS (10) wins. No points, no
//     banking, no multipliers, no peek.

/**
 * The actions in the redesigned game. `JUMP` (a tile choice) and `FLAG` are
 * PLAYER actions; `TIMEOUT` is server-only — it is what an expired 15s choice
 * window records in the history (it is never accepted from a client).
 */
export const BRIDGE_ACTIONS = Object.freeze({
  JUMP: "jump",
  FLAG: "flag",
  TIMEOUT: "timeout",
});

/** Clamp a row value into the bridge's legal range (0..BRIDGE_ROWS). */
export function clampRow(row) {
  const n = Number(row);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(BRIDGE_ROWS, Math.floor(n)));
}

/** How many rows a seat has crossed (0..BRIDGE_ROWS). */
export function seatRow(match, seat) {
  const field = seat === "player1" ? "p1Row" : "p2Row";
  return clampRow(match?.[field] ?? 0);
}

/** The seat's memory flags: [{ row, tile }, …] (visible to both players). */
export function flagsOf(match, seat) {
  const field = seat === "player1" ? "p1Flags" : "p2Flags";
  const list = match?.[field];
  return Array.isArray(list) ? list : [];
}

/** How many memory flags the seat has spent this match. */
export function bridgeFlagsUsedBySeat(match, seat) {
  return flagsOf(match, seat).length;
}

/** Flags the seat still has (never negative). */
export function flagsLeftForSeat(match, seat) {
  return Math.max(0, BRIDGE_FLAGS_PER_PLAYER - bridgeFlagsUsedBySeat(match, seat));
}

/** Every broken bad tile on the shared bridge: [{ row, tile }, …]. */
export function brokenTilesOf(match) {
  const list = match?.broken;
  return Array.isArray(list) ? list : [];
}

/** Whether a specific tile is already broken (public knowledge). */
export function isTileBroken(broken, row, tile) {
  const r = Number(row);
  const t = Number(tile);
  if (!Array.isArray(broken)) return false;
  return broken.some((b) => Number(b?.row) === r && Number(b?.tile) === t);
}

/**
 * Resolve a JUMP: pick a tile on the row the seat is standing before.
 *
 *   • safe tile → cross it (`to = from + 1`); reaching BRIDGE_ROWS wins;
 *   • the row's bad tile → the tile breaks (publicly, permanently) and the
 *     seat falls back to the start (`to = 0`).
 *
 * Pure: returns the next values, the caller persists them.
 *
 * @param {object} opts
 * @param {object} opts.bridge result of buildSharedBridge()
 * @param {Array<{row:number,tile:number}>} [opts.broken] already-broken tiles
 * @param {number} opts.row the row the seat is on (0-based)
 * @param {number} opts.tile the tile index chosen
 * @returns {{
 *   outcome: "safe"|"fell"|"won", from: number, to: number, tile: number,
 *   brokeTile: {row:number,tile:number}|null, broken: Array<{row:number,tile:number}>,
 *   error?: string
 * }}
 */
export function resolveJump({ bridge, broken = [], row, tile }) {
  const from = clampRow(row);
  const tiles = Number(bridge?.tiles) || bridgeTileCountFor(bridge?.difficulty);
  const t = Number(tile);
  const base = {
    from,
    to: from,
    tile: t,
    brokeTile: null,
    broken: Array.isArray(broken) ? [...broken] : [],
  };

  if (!Number.isInteger(t) || t < 0 || t >= tiles) {
    return { ...base, outcome: "fell", error: "Invalid tile index" };
  }
  if (from >= BRIDGE_ROWS) {
    return { ...base, outcome: "won", to: BRIDGE_ROWS, error: "Already crossed" };
  }

  // Removing pending flags on this tile is the caller's job (flags are a
  // separate public list); the jump itself only owns rows + broken tiles.
  if (isBridgeTileBad(bridge, from, t)) {
    const alreadyBroken = isTileBroken(base.broken, from, t);
    const brokeTile = { row: from, tile: t };
    return {
      ...base,
      outcome: "fell",
      to: 0,
      brokeTile,
      broken: alreadyBroken ? base.broken : [...base.broken, brokeTile],
    };
  }

  const to = from + 1;
  return to >= BRIDGE_ROWS
    ? { ...base, outcome: "won", to: BRIDGE_ROWS }
    : { ...base, outcome: "safe", to };
}

/**
 * The row/turn consequence of a resolved jump — the ONE place the redesigned
 * turn rules live, so the server transition and the tests cannot drift:
 *
 *   • safe tile → the seat crosses one row and KEEPS the turn (it may choose
 *     again immediately);
 *   • bad tile  → that seat's attempt ends, its progress resets to row 1
 *     (row 0 = "crossed nothing"), and the OPPONENT is up;
 *   • choice window expired ("timed_out") → the attempt ends the same way as a
 *     bad tile (reset + hand over) WITHOUT touching any tile;
 *   • row BRIDGE_ROWS crossed → the seat wins and the match ends (no turn).
 *
 * Pure: returns the next values, the caller persists them in the same write.
 *
 * @param {object} opts
 * @param {object} opts.match match row (player1Id/player2Id + currentTurnUserId)
 * @param {string} opts.seat the seat that jumped ("player1" | "player2")
 * @param {object} opts.outcome result of resolveJump(), or
 *   `{ outcome: "timed_out", to: 0 }` for an expired 15s choice window
 * @returns {{
 *   ended: boolean, rowField: "p1Row"|"p2Row", row: number,
 *   turnUserId: string|null, seatStillUp: boolean
 * }}
 */
export function bridgeTurnAfterJump({ match, seat, outcome }) {
  const isP1 = seat === "player1";
  const seatUserId = isP1 ? match?.player1Id : match?.player2Id;
  const opponentUserId = isP1 ? match?.player2Id : match?.player1Id;
  const rowField = isP1 ? "p1Row" : "p2Row";
  const won = outcome?.outcome === "won";
  // A bad tile and an expired choice window both END the attempt: the seat
  // goes back to the start and the turn passes to the opponent. (Only the
  // bad tile additionally breaks the tile it hit.)
  const lostAttempt =
    outcome?.outcome === "fell" || outcome?.outcome === "timed_out";

  return {
    ended: won,
    rowField,
    // A lost attempt resets to the start; a safe choice advances exactly one
    // row; a win lands on the far side of the last row.
    row: won ? BRIDGE_ROWS : lostAttempt ? 0 : clampRow(outcome?.to),
    // Only a lost attempt hands the turn over, and a finished match has no turn.
    turnUserId: won
      ? null
      : lostAttempt
        ? (opponentUserId ?? null)
        : (seatUserId ?? null),
    seatStillUp: !won && !lostAttempt,
  };
}

/**
 * Whether a seat PERSONALLY landed safely on a specific tile — i.e. the
 * authoritative history contains that seat's own jump at (row, tile) which
 * crossed the row. This is the flag gate: a flag may only ever mark a tile its
 * owner really stepped on, so a flag can never assert safety the server has
 * not already witnessed, and it can never mark a bad tile.
 *
 * Derived from match state only (never from the client), and it survives a
 * fall: an attempt that was reset does not un-happen the landings it made
 * before it fell.
 *
 * @param {object} match match row (its `actions` are the history)
 * @param {string} seat "player1" | "player2"
 * @param {number} row
 * @param {number} tile
 * @returns {boolean}
 */
export function landedSafelyOn(match, seat, row, tile) {
  const r = Number(row);
  const t = Number(tile);
  if (!Number.isInteger(r) || !Number.isInteger(t)) return false;
  const actions = Array.isArray(match?.actions) ? match.actions : [];
  return actions.some(
    (a) =>
      a &&
      a.seat === seat &&
      a.action === BRIDGE_ACTIONS.JUMP &&
      // "safe" and "won" both mean the tile was crossed without breaking.
      (a.outcome === "safe" || a.outcome === "won") &&
      Number(a.row) === r &&
      Number(a.tile) === t,
  );
}

/**
 * Whether a seat may place a memory flag at (row, tile):
 *
 *   • max BRIDGE_FLAGS_PER_PLAYER flags per match (never more), and
 *   • the tile must be one the seat PERSONALLY landed on safely (see
 *     landedSafelyOn — validated against the server's own history, so the
 *     client cannot propose a tile it never stood on).
 *
 * A flag is append-only: the same tile cannot be flagged twice, and nothing
 * here can move or remove an existing flag. Flagging never consumes the turn.
 *
 * @param {object} opts
 * @param {object} opts.match match row (p1Row/p2Row + p1Flags/p2Flags)
 * @param {string} opts.seat "player1" | "player2"
 * @param {number} opts.row row to flag
 * @param {number} opts.tile tile to flag
 * @param {object} opts.bridge result of buildSharedBridge()
 * @returns {{ ok: boolean, error?: string }}
 */
export function canPlaceFlag({ match, seat, row, tile, bridge }) {
  if (flagsLeftForSeat(match, seat) <= 0) {
    return { ok: false, error: "No flags left this match" };
  }
  const r = Number(row);
  const t = Number(tile);
  const tiles =
    Number(bridge?.tiles) || bridgeTileCountFor(bridge?.difficulty);
  if (!Number.isInteger(r) || r < 0 || r >= BRIDGE_ROWS) {
    return { ok: false, error: "Invalid row" };
  }
  if (!Number.isInteger(t) || t < 0 || t >= tiles) {
    return { ok: false, error: "Invalid tile index" };
  }
  // "A player can flag ONLY a tile they personally landed on safely" — the
  // server validates its OWN record of that landing, never the request.
  if (!landedSafelyOn(match, seat, r, t)) {
    return { ok: false, error: "Flag a tile you landed on safely" };
  }
  if (flagsOf(match, seat).some((f) => Number(f?.row) === r && Number(f?.tile) === t)) {
    return { ok: false, error: "That tile is already flagged" };
  }
  return { ok: true };
}

/**
 * The seat's flags AFTER placing one at (row, tile) — append-only, so existing
 * flags keep their exact position and order (a flag can never be moved or
 * removed). Pure: the caller persists the returned list.
 *
 * @param {object} opts
 * @param {object} opts.match match row (p1Flags/p2Flags)
 * @param {string} opts.seat "player1" | "player2"
 * @param {number} opts.row
 * @param {number} opts.tile
 * @param {string} [opts.at] ISO timestamp
 * @returns {{ field: "p1Flags"|"p2Flags", flags: Array<object> }}
 */
export function flagPlacement({ match, seat, row, tile, at }) {
  const field = seat === "player1" ? "p1Flags" : "p2Flags";
  const flags = [
    ...flagsOf(match, seat),
    {
      row: Number(row),
      tile: Number(tile),
      seat,
      at: at ?? new Date().toISOString(),
    },
  ];
  return { field, flags };
}

/**
 * The bot's next move on the shared bridge: it picks a tile on the row it is
 * standing before, avoiding tiles it has already seen break (except on easy,
 * which sometimes repeats a known-broken tile), and spends a memory flag on a
 * row it has crossed when it has budget left. Difficulty keeps its meaning:
 * easy is careless, medium is careful, hard is careful AND uses its flags.
 *
 * @param {object} opts
 * @param {object} opts.match match row
 * @param {string} opts.seat the bot's seat ("player2" on practice tables)
 * @param {object} opts.bridge result of buildSharedBridge()
 * @param {function} [opts.random]
 * @returns {{
 *   action: "jump"|"flag", row: number, tile: number,
 *   broken?: Array<{row:number,tile:number}>
 * }|null}
 *
 * `allowFlags: false` restricts the bot to TILE SELECTION (the flag action is
 * wired separately), so a caller that has not enabled flags yet still gets a
 * legal jump every time.
 */
export function decideBridgeBotAction({
  match,
  seat = "player2",
  bridge,
  random = Math.random,
  allowFlags = true,
}) {
  const row = seatRow(match, seat);
  if (row >= BRIDGE_ROWS) return null;
  const tiles =
    Number(bridge?.tiles) || bridgeTileCountFor(bridge?.difficulty);
  const difficulty = String(bridge?.difficulty || "easy");
  const broken = brokenTilesOf(match);

  // Flag first (never consumes the turn): mark one of the tiles the bot
  // ITSELF landed on safely and has not flagged yet — the only candidates the
  // server will accept (see canPlaceFlag).
  const wantsFlag =
    allowFlags &&
    flagsLeftForSeat(match, seat) > 0 &&
    (difficulty === "hard" ? random() < 0.5 : difficulty === "medium" ? random() < 0.25 : random() < 0.1);
  if (wantsFlag) {
    const flagged = (r, t) =>
      flagsOf(match, seat).some(
        (f) => Number(f?.row) === r && Number(f?.tile) === t,
      );
    const candidates = [];
    for (let r = 0; r < BRIDGE_ROWS; r += 1) {
      for (let t = 0; t < tiles; t += 1) {
        if (flagged(r, t)) continue;
        if (!landedSafelyOn(match, seat, r, t)) continue;
        candidates.push({ row: r, tile: t });
      }
    }
    if (candidates.length > 0) {
      const pick = candidates[Math.floor(random() * candidates.length)];
      return { action: BRIDGE_ACTIONS.FLAG, row: pick.row, tile: pick.tile, broken };
    }
  }

  // A jump: prefer tiles the bot has not watched break. Easy ignores its own
  // observations roughly a third of the time (that is its difficulty).
  const safeCandidates = [];
  const all = [];
  for (let t = 0; t < tiles; t += 1) {
    all.push(t);
    if (!isTileBroken(broken, row, t)) safeCandidates.push(t);
  }
  const pool =
    difficulty === "easy" && safeCandidates.length > 0 && random() < 0.33
      ? all
      : safeCandidates.length > 0
        ? safeCandidates
        : all;
  const tile = pool[Math.floor(random() * pool.length)];
  return { action: BRIDGE_ACTIONS.JUMP, row, tile, broken };
}

/**
 * The ONLY bridge shape a client may receive. It carries the row geometry
 * plus the tiles that are already public knowledge:
 *
 *   • broken tiles — a tile someone fell through stays broken for the rest of
 *     the match (and a correct flag claims/reveals its row), and
 *   • `revealedRows` — the rows those public tiles belong to.
 *
 * Untouched rows/tiles leak NOTHING: an entry is honored only when the pair
 * really is that row's single bad tile (a caller cannot reveal or grief an
 * arbitrary tile), the output never contains `badTiles`, and rows with no
 * public knowledge carry no information at all — not even a count.
 *
 * @param {object} bridge result of buildSharedBridge()
 * @param {object} [opts]
 * @param {Array<{row:number,tile:number}|[number,number]>} [opts.broken]
 *   tiles already broken / revealed (order-independent, deduped)
 * @returns {{
 *   rows: number, tiles: number, difficulty: string, commitment: string,
 *   broken: Array<{row:number,tile:number}>, revealedRows: number[]
 * }}
 */
export function bridgeClientView(bridge, { broken = [] } = {}) {
  const publicBroken = [];
  const revealed = new Set();

  for (const entry of Array.isArray(broken) ? broken : []) {
    const row = Array.isArray(entry) ? Number(entry[0]) : Number(entry?.row);
    const tile = Array.isArray(entry) ? Number(entry[1]) : Number(entry?.tile);
    const idx = badTileIndex(bridge, row);
    if (idx == null || idx !== tile) continue;
    if (revealed.has(row)) continue;
    revealed.add(row);
    publicBroken.push({ row, tile: idx });
  }

  publicBroken.sort((a, b) => a.row - b.row);

  return {
    rows: Number(bridge?.rows ?? BRIDGE_ROWS),
    tiles: Number(bridge?.tiles ?? bridgeTileCountFor("easy")),
    difficulty: bridge?.difficulty ?? "easy",
    commitment: bridge?.commitment ?? null,
    broken: publicBroken,
    revealedRows: publicBroken.map((b) => b.row),
  };
}
