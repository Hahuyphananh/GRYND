// src/lib/mines-pvp/constants.js
//
// Shared constants + board-gen + outcome resolution for the Mines PvP
// ("Mines Duel") match system. Built as a parallel to
// `src/lib/blackjack-pvp/constants.js` so the lobby + match flow
// shares the same shape (stake presets / round timer / status enum
// / advisory-lock namespace / RESULT enum) while the game logic is
// mines-specific (5×5 board gen, mine-hit / all-mines-flagged
// endings, 90/10 payout split).
//
// The board-gen helper is intentionally kept INDEPENDENT from the
// solo-mines `generateBoard` in `src/app/api/mines/start/route.js`
// so we don't accidentally couple the PvP state machine to the
// single-player signed-session code path. The PvP board is
// server-authoritative and persisted on the match row in the
// `board` jsonb column (scrubbed from /status responses until
// status='finished').
//
// Shared-board rules (ONE board, alternating server-authoritative turns):
//   • Both players reveal on the SAME board; every safe reveal and its
//     clue are PUBLIC to both seats.
//   • Revealing a mine loses IMMEDIATELY for the revealer (opponent wins,
//     winReason='mine_hit').
//   • Flags are per-player CLAIMS, never terminal — a wrong flag is NOT a
//     loss, it just costs a turn.
//   • Correctly flagging EVERY mine wins IMMEDIATELY
//     (winReason='all_mines_flagged').
//   • There is NO draw; a finished match rejects every further action.
//
// Payout (stakes currently retired / normalized to 0):
//   Winner: own stake back + 90% of loser's stake
//   Loser:   loses entire stake
//   House:   10% rake on loser's stake only

import { chooseAiOption, coerceAiDifficulty } from "../aiDifficulty";

// ── Board geometry ────────────────────────────────────────────────────
// 10×10 grid, row-major indexing (cell 0 = top-left, cell 99 =
// bottom-right). Mirrors classic Minesweeper: a wide field of small
// tiles rather than a handful of large ones.
export const GRID_SIZE = 10;
export const GRID_CELLS = GRID_SIZE * GRID_SIZE; // 100
export const MIN_MINES = 1;
export const MAX_MINES = GRID_CELLS - 1; // 99 — a board can never be all mines

// Every match is played at the SAME mine density: 1 mine per 10 tiles.
// On the 10×10 board that is exactly 10 mines, and the whole flow (lobby,
// validation, board generation) is pinned to this single value — there is
// no host-picked mine count any more.
export const MINES_PER_MATCH = 10;

// ── Turn order (strict alternation) ───────────────────────────────────
// Each turn a player makes EXACTLY ONE action — reveal a tile OR place a
// flag — and then the turn passes to the opponent. There are no double
// turns and no way to chain a reveal and a flag in the same turn.
//
//   turn 1: firstPlayer
//   turn 2: secondPlayer
//   turn 3: firstPlayer
//   turn 4: secondPlayer
//   ...
//
// Closed form: odd turns belong to the opener, even turns to the other
// seat. Encoded below as `seatForPickNumber` so the server store and the
// tests both call it without re-deriving the rule. The return shape is the
// SEAT LABEL ("player1" | "player2"); the call site maps seat → clerkId.
export function seatForPickNumber(pickNumber, firstPlayerSeat) {
  // Reject non-number inputs up front (`"1"`, `null`, `1.5`, `-1`, `0`
  // etc. all return null). Without the explicit `typeof` guard, `Number("1")`
  // coerces to the valid number 1 and the formula would accept a string
  // lookalike.
  if (
    typeof pickNumber !== "number" ||
    !Number.isInteger(pickNumber) ||
    pickNumber < 1
  ) {
    return null;
  }
  if (pickNumber % 2 === 1) return firstPlayerSeat;
  return firstPlayerSeat === "player1" ? "player2" : "player1";
}

// Compute the active picker for `match` given its current pick
// history length. Returns the SEAT LABEL ("player1" | "player2")
// of whoever's turn it is on the (picks.length + 1)-th turn. The
// caller converts to clerkId via `seat === player1 ? player1Id :
// player2Id`. Throws if `firstPlayerId` doesn't match either seat
// (defensive catch for malformed match rows from a bad migration).
export function activeSeatForMatch(match) {
  const picks = Array.isArray(match?.picks) ? match.picks : [];
  const nextN = picks.length + 1;
  const isP1First =
    match?.firstPlayerId && match?.player1Id === match.firstPlayerId;
  const firstSeat = isP1First ? "player1" : "player2";
  return seatForPickNumber(nextN, firstSeat);
}

// clerkId-shaped counterpart of `activeSeatForMatch`. Returns the
// userId that should be picking next. Margins-of-error safe —
// mismatched arguments return null instead of throwing so the
// caller can treat "no active picker" as a stop-condition (e.g.
// terminal-state fetches).
export function activePickerForMatch(match) {
  if (!match) return null;
  if (!isPickableRowShape(match)) return null;
  const seat = activeSeatForMatch(match);
  if (seat === "player1") return match.player1Id;
  if (seat === "player2") return match.player2Id;
  return null;
}

// Tiny defensive shape check — used by callers that want to
// error-out on a malformed match row rather than crash on `.p1`.
function isPickableRowShape(match) {
  return (
    typeof match.player1Id === "string" &&
    typeof match.player2Id === "string" &&
    typeof match.firstPlayerId === "string"
  );
}

// ── Per-turn window ───────────────────────────────────────────────────
// Duration (seconds) of each pick's decision window before the
// server-authoritative deadline fires and auto-picks a random
// cell. Mirrors blackjack-pvp's ROUND_TIMER_SECONDS shape.
export const ROUND_TIMER_SECONDS = 20;
export const ROUND_PICK_DEADLINE_MS = ROUND_TIMER_SECONDS * 1000;

// ── Stake matchmaking constants ───────────────────────────────────────
// STAKE_PRESETS mirrors blackjack-pvp / roulette-pvp so the lobby
// UI components render the same chip row. The actual bet is still
// free-form validated against MIN_STAKE / MAX_STAKE.
export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MIN_STAKE = 1;
// Must match GLOBAL_MAX_BET in src/lib/games/economy.ts.
export const MAX_STAKE = 100000;

// ── House fee (per user spec: 10% rake on the LOSER's stake) ──────────
// 0.10 = 10% of the loser's stake goes to the house. The winner
// takes 90% of the loser's stake. Note this is ON the loser's
// stake only — the winner always gets their own stake back, so
// the total take from the match is just the loser's stake and the
// split between winner/house is 90/10. Distinct from roulette-pvp
// (HOUSE_FEE_PCT = 0.025) and coin-flip-pvp (2%); the user
// explicitly asked for the 90/10 split for Mines Duel.
export const HOUSE_FEE_PCT = 0.10;
export const WINNER_RATIO = 0.90; // 90% of the loser's stake
export const HOUSE_RATIO = 0.10; // 10% of the loser's stake

// ── Status state machine ──────────────────────────────────────────────
// Six states. The host creates a match (waiting → joins from lobby),
// player2 joins (ready → 3s banner → p1_turn), then the players alternate
// server-authoritative turns (p1_turn ↔ p2_turn) until the match ends — a
// reveal hits a mine, a player flags every mine, or someone
// resigns/disconnects (→ finished). `cancelled` is reachable from any
// non-terminal state when a player disconnects past the grace period (or
// the host leaves before player2 joins).
export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  P1_TURN: "p1_turn",
  P2_TURN: "p2_turn",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match is still in progress (not yet terminal).
// `READY` is in this set so /status polls include it, but picks
// are NOT accepted during the brief 3-second "Get ready" banner
// (see PICKABLE_STATES below).
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.P1_TURN,
  MATCH_STATUS.P2_TURN,
]);

// States where a `pickTile` action is accepted. `READY` is
// intentionally excluded — it's the brief auto-transition window
// after both players join. `WAITING` is excluded (no opponent
// yet). `FINISHED` / `CANCELLED` are terminal.
export const PICKABLE_STATES = new Set([
  MATCH_STATUS.P1_TURN,
  MATCH_STATUS.P2_TURN,
]);

// Terminal states. Once a match reaches one of these, no further
// state transitions are allowed (the server store rejects any
// action whose match.status is in this set).
export const TERMINAL_STATES = new Set([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

// Auto-advance window between player2 joining and the first
// turn (P1_TURN) starting. Server-authoritative 3-second
// "Get ready" banner.
export const READY_WINDOW_MS = 3000;

// Auto-advance window between FINISHED and the client being
// allowed to navigate back to the lobby. Mirrors blackjack-pvp
// `BETWEEN_ROUNDS_MS` shape for symmetry.
export const FINISHED_GRACE_MS = 5000;

// ── Stake-key advisory-lock namespace for `createOrJoin` matchmaking
// Stable ASCII-pack to keep the global pg_advisory_xact_lock
// keyspace partitioned so other features can't accidentally
// collide with mines-pvp matchmaking. "MPVP" packed: M=0x4D,
// P=0x50, V=0x56, P=0x50. Bitwise-AND with 0x7FFFFFFF to keep
// the resulting 32-bit signed integer positive (Postgres
// advisory locks take a bigint but staying positive avoids
// sign-extension surprises across the codebase).
export const MINES_PVP_LOCK_NAMESPACE = 0x4d505650 & 0x7fffffff;

// ── Result string constants ───────────────────────────────────────────
// 'player1' | 'player2' | 'draw' | null. Stored in
// `mines_pvp_matches.result` and `mines_pvp_rounds.round_winner`.
// Mirrors blackjack-pvp / roulette-pvp convention; DRAW is legacy-only
// under the shared-board rules (there is no draw case).
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
});

// ── Per-pick state for replay ─────────────────────────────────────────
// Sourced into both `mines_pvp_matches.p1_pick_is_mine` /
// `p2_pick_is_mine` AND mirrored on `mines_pvp_rounds.*` for
// post-match replay.
export const PICK_KIND = Object.freeze({
  MINE: "mine",
  SAFE: "safe",
});

// ── Match-end reason (`winReason`) ────────────────────────────────────
// WHY a finished match ended. Stored on `mines_pvp_matches.win_reason`
// and mirrored onto `mines_pvp_rounds.win_reason` at resolution time so
// replays can label the ending without re-deriving it. The shared-board
// rules have two player-driven endings plus two infrastructure endings:
//   MINE_HIT          — a picker revealed a mine → that player lost
//   ALL_MINES_FLAGGED — a player flagged EVERY mine → that player won
//   RESIGN            — a player conceded
//   DISCONNECT        — a player dropped past the grace period
export const WIN_REASON = Object.freeze({
  MINE_HIT: "mine_hit",
  ALL_MINES_FLAGGED: "all_mines_flagged",
  RESIGN: "resign",
  DISCONNECT: "disconnect",
});

// ── Board generator ───────────────────────────────────────────────────
// Returns a 5×5 board jsonb of shape `{ size: 5, mines: [n1, n2,
// ...] }` where `mines.length === minesCount` and every entry is
// a unique 0-24 row-major cell index. The single player can
// re-derive whether a cell is a mine by checking
// `board.mines.includes(cellIndex)` (see `isMine`).
//
// `minesCount` is validated against MIN_MINES / MAX_MINES; an
// out-of-range value throws a RangeError so the calling API
// route returns 400 with a clear message rather than silently
// writing an invalid board.
export function generateBoard(minesCount) {
  const count = Number(minesCount);
  if (
    !Number.isInteger(count) ||
    count < MIN_MINES ||
    count > MAX_MINES
  ) {
    throw new RangeError(
      `generateBoard: minesCount must be an integer in [${MIN_MINES}, ${MAX_MINES}], got ${minesCount}`,
    );
  }
  // Fisher-Yates partial shuffle: start with all 25 cells, swap
  // the first `count` of them into random positions, then take
  // the first `count` slots as mines. O(n) and never produces
  // duplicates (every mine is a unique cell).
  const all = Array.from({ length: GRID_CELLS }, (_, i) => i);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(Math.random() * (GRID_CELLS - i));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return {
    size: GRID_SIZE,
    mines: all.slice(0, count).sort((a, b) => a - b),
  };
}

// ── First-pick mercy ───────────────────────────────────────────────────
// The opening reveal is definitionally a guess (zero information), so the
// server makes the very first reveal of a match always safe: if it lands
// on a mine, the mine is relocated to a random safe cell (see
// `relocateMine`). There is no centre-block / solvability guarantee any
// more — this is a wide 10×10 field where the distance clues do the work.

// Chebyshev (king-move) tile distance between two cell indices. Returns
// null for unknown / out-of-range inputs.
export function chebyshevDistance(a, b) {
  const ra = cellIndexToRowCol(a);
  const rb = cellIndexToRowCol(b);
  if (!ra || !rb) return null;
  return Math.max(Math.abs(ra.row - rb.row), Math.abs(ra.col - rb.col));
}

// First-pick mercy: move the mine sitting on `cellIndex` to a random
// non-mine cell so the very first pick of a match is always safe.
// Returns a NEW board (never mutates the input). No-op (returns the
// same-shaped board) when `cellIndex` is not a mine or the input is
// malformed. The mine count is preserved — a relocation, not a removal.
export function relocateMine(board, cellIndex) {
  if (!board || !Array.isArray(board.mines)) return board;
  const idx = Number(cellIndex);
  if (!isMine(board, idx)) return board;
  const nonMines = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (!board.mines.includes(i)) nonMines.push(i);
  }
  if (nonMines.length === 0) return board; // every cell is a mine — cannot happen (MAX_MINES < 25)
  const target = nonMines[Math.floor(Math.random() * nonMines.length)];
  const mines = board.mines.filter((m) => m !== idx);
  mines.push(target);
  return {
    size: board.size ?? GRID_SIZE,
    mines: mines.sort((a, b) => a - b),
  };
}

// ── Mine lookup helper ────────────────────────────────────────────────
// Server-only check: returns true if `cellIndex` is a mine on
// `board`. `cellIndex` is a 0..GRID_CELLS-1 row-major index.
// Returns false for unknown cells (defence-in-depth so a
// tampered request can never trigger a crash). Non-numeric inputs
// (e.g. a string "5" from a tampered request) are rejected outright
// rather than coerced — callers upstream (pickTile / flagTile /
// forcePick) always pass a validated number.
export function isMine(board, cellIndex) {
  if (!board || !Array.isArray(board.mines)) return false;
  if (typeof cellIndex !== "number") return false;
  const idx = cellIndex;
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) return false;
  return board.mines.includes(idx);
}

// ── Minesweeper-style proximity hints ──────────────────────────────────
// The skill mechanic: a safe pick reveals ONE number — how many tiles
// away the NEAREST mine is (Chebyshev tile distance: 1 = touching a
// mine). Computed server-side from the board, since the client can't
// see mine positions mid-match. Under the shared-board rules the number
// is PUBLIC: both players act on the same board, so every safe reveal's
// clue is visible to both of them (matchView never strips opponent
// hints).

/**
 * Chebyshev (king-move) tile distance from `cellIndex` to the nearest
 * mine: 1 = in the 8-cell neighborhood, 2 = one full tile of gap, etc.
 * A cell that IS a mine returns 0 (only reachable post-match — safe
 * picks always return >= 1). Returns null for unknown boards / cells.
 */
export function nearestMineDistance(board, cellIndex) {
  if (!board || !Array.isArray(board.mines) || board.mines.length === 0) {
    return null;
  }
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) return null;
  const rc = cellIndexToRowCol(idx);
  if (!rc) return null;
  let best = Infinity;
  for (const mine of board.mines) {
    const mr = cellIndexToRowCol(mine);
    if (!mr) continue;
    const d = Math.max(
      Math.abs(rc.row - mr.row),
      Math.abs(rc.col - mr.col),
    );
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : null;
}

// ── Player flags (shared-board "claims") ───────────────────────────────
// Under the shared-board rules a flag is a per-player CLAIM, not a pick:
// each seat owns its own flag set (the same cell may be flagged by both),
// a flag never ends the match on its own, and a wrong flag is NOT a loss.
// Flags therefore live on their own columns
// (`mines_pvp_matches.p1_flags` / `p2_flags`) and never enter the `picks`
// turn history. The helpers below are the single source of truth for how
// a flag set is normalised and how the "all mines flagged" win is
// decided — the server store will call them once the flag flow lands.

// Sanitise a flag set to unique, sorted, in-range integer cell indices so
// the stored JSONB is canonical: two orderings of the same
// claims compare equal, and tampered input (strings, floats, out-of-range
// or null entries) is dropped rather than persisted.
export function normalizeFlags(flags) {
  if (!Array.isArray(flags)) return [];
  const seen = new Set();
  for (const raw of flags) {
    // Only numbers and numeric strings are acceptable claims. Anything
    // else (null, undefined, booleans, arrays/objects) is dropped —
    // notably `null`, which `Number()` would otherwise coerce to cell 0.
    if (typeof raw !== "number" && typeof raw !== "string") continue;
    const idx = Number(raw);
    if (Number.isInteger(idx) && idx >= 0 && idx < GRID_CELLS) seen.add(idx);
  }
  return [...seen].sort((a, b) => a - b);
}

// How many of `flags` really are mines on `board`. Board-derived and
// pure, so it is only ever computed server-side (the client never has the
// hidden layout mid-match).
export function correctFlagCount(flags, board) {
  if (!board || !Array.isArray(board.mines)) return 0;
  const mines = new Set(board.mines);
  return normalizeFlags(flags).filter((c) => mines.has(c)).length;
}

// Does `flags` cover EVERY mine on `board`? This is the win condition for
// the shared-board rule "a player who correctly flags ALL mines wins
// immediately". Extra (wrong) flags do not block the win — the rule only
// requires every mine to be claimed, and a wrong flag is not a loss.
export function hasFlaggedAllMines(flags, board) {
  if (!board || !Array.isArray(board.mines) || board.mines.length === 0) {
    return false;
  }
  const flagged = new Set(normalizeFlags(flags));
  return board.mines.every((m) => flagged.has(m));
}

// Read a seat's flag claims off a match row, normalised. `p1Flags` /
// `p2Flags` are the persisted per-player sets (jsonb arrays on
// `mines_pvp_matches`); each seat owns its own field, so the same cell can
// be flagged by both without either clobbering the other. This is the
// canonical read used by match serialisation, so a client never sees a
// null / raw-legacy shape.
export function flagsForSeat(match, seat) {
  const field = seat === "player2" ? "p2Flags" : "p1Flags";
  return normalizeFlags(match?.[field]);
}

// Is this `picks` entry a FLAG claim rather than a reveal? Flags share the
// chronological `picks` array so they consume a turn and render in history,
// but they reveal nothing about the hidden board — every board-derived
// consumer (duplicate-reveal checks, safe-tile counters, the client's
// revealed-cell set) must skip them.
//
// Both discriminators are honoured: `flag: true` is the original marker
// (still written by the store) and `kind: "flag"` is the explicit typed
// marker. Reading both keeps legacy rows working.
export function isFlagEntry(entry) {
  return Boolean(entry && (entry.flag === true || entry.kind === "flag"));
}

// Every cell REVEALED so far, excluding flag claims. Backs the
// "cell has not already been revealed" validation on both `pickTile` and
// `flagTile`, the AFK auto-pick's exclusion set, and the client's revealed
// set — a cell another player merely FLAGGED is still revealable.
// Returns unique, sorted, in-range cell indices.
export function revealedCells(match) {
  const picks = Array.isArray(match?.picks) ? match.picks : [];
  const seen = new Set();
  for (const entry of picks) {
    if (isFlagEntry(entry)) continue;
    const idx = Number(entry?.cell);
    if (Number.isInteger(idx) && idx >= 0 && idx < GRID_CELLS) seen.add(idx);
  }
  return [...seen].sort((a, b) => a - b);
}

// Add `cellIndex` to a seat's OWN flag set, returning the partial row patch
// (only the touched column) rather than a merged whole-match object — the two
// seats therefore can never clobber each other's claims, and the caller can
// spread the result straight into a Drizzle `.set()`. The result is
// canonicalised (`normalizeFlags`), so the stored JSONB is always unique,
// sorted and in range.
export function withFlagForSeat(match, seat, cellIndex) {
  const field = seat === "player2" ? "p2Flags" : "p1Flags";
  const next = normalizeFlags([...flagsForSeat(match, seat), cellIndex]);
  return { [field]: next };
}

// ── Outcome resolver ──────────────────────────────────────────────────
// Given the player who just hit a mine (the loser), decide the match
// outcome. The odds-turn flow has NO draw case — the match ends the
// moment a picker hits a mine and that picker is the loser. The
// resolver is intentionally a PURE mapping — no DB, no state — so
// the match store can call it from `pickTile` (early-exit on mine
// hit) and `forcePick` (AFK auto-pick path) without side effects.
//
// Caller contract: `loserId` MUST be exactly one of `player1Id` /
// `player2Id`. The function throws on every other input so a future
// caller can't accidentally produce a DRAW-shape outcome.
export function decideOutcome({ loserId, player1Id, player2Id }) {
  if (loserId === player1Id) return RESULT.PLAYER2; // P1 mined → P2 wins
  if (loserId === player2Id) return RESULT.PLAYER1; // P2 mined → P1 wins
  throw new RangeError(
    `decideOutcome: loserId must equal player1Id or player2Id, got ${loserId}`,
  );
}

// Winner-side counterpart of `decideOutcome`. The shared-board rules have two
// player-driven endings — a mine hit (the HITTER loses) and an all-mines-flag
// win (the FLAGGER wins) — so resolving from an explicit `winnerId` makes it
// impossible for a future caller to pass the wrong side and silently reverse
// the result (which is exactly the class of bug the loser-shaped signature
// invited). Throws unless the winner is one of the two seats.
export function resultForWinner({ winnerId, player1Id, player2Id }) {
  if (winnerId === player1Id) return RESULT.PLAYER1;
  if (winnerId === player2Id) return RESULT.PLAYER2;
  throw new RangeError(
    `resultForWinner: winnerId must equal player1Id or player2Id, got ${winnerId}`,
  );
}

// ── Payout calculator ─────────────────────────────────────────────────
// Returns the per-side settlement numbers for a resolved match:
//
//   { stake, winnerNet, loserNet, houseFee, prizePaid }
//
// Rules:
//   DRAW:       legacy only — the shared-board flow never produces a draw,
//               but the refund path is kept for old rows. Both refunded:
//               winnerNet = loserNet = null, houseFee = 0, prizePaid = 0.
//   PLAYER1:    player1 wins. player1 gets (stake + 0.9 * stake) =
//               1.9x stake back; player2 loses stake. House rake
//               = 0.1 * stake. prizePaid = 1.9 * stake.
//   PLAYER2:    mirror of PLAYER1.
//
// The function returns NUMBER (rounded to 2dp via toFixed+parseFloat)
// so callers can persist directly to numeric(10, 2) columns.
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
  const winnerPrize = round2(stake * WINNER_RATIO); // 90% of loser's stake
  const houseFee = round2(stake * HOUSE_RATIO); // 10% of loser's stake
  return {
    stake: round2(stake),
    // winner is refunded their own stake + 90% of the loser's stake
    winnerNet: round2(stake + winnerPrize),
    // loser loses their entire stake (net = -stake)
    loserNet: round2(-stake),
    houseFee,
    // prizePaid = the total payout to the winner (their stake back
    // + the 90% they won from the loser). Surfaced as a column on
    // the match row for parity with roulette-pvp / blackjack-pvp.
    prizePaid: round2(stake + winnerPrize),
  };
}

// ── AFK auto-pick helper ──────────────────────────────────────────────
// When a player doesn't pick before `round_deadline`, the server
// auto-picks a random cell. The cell CAN be a mine — that's the
// punishment for going AFK in the middle of a turn. The
// `excludePicks` parameter is an array of cell indices that
// either side has already REVEALED (so the auto-pick never re-uses
// a revealed cell, which the store would reject as an invalid
// duplicate pick).
//
// Returns a 0..GRID_CELLS-1 cell index, or throws if every cell
// is already picked (which shouldn't happen — both players only
// ever pick one cell each on a 25-cell board).
export function pickRandomCell({ excludePicks = [] } = {}) {
  const exclude = new Set(
    (excludePicks || []).map((n) => Number(n)).filter(Number.isInteger),
  );
  const available = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (!exclude.has(i)) available.push(i);
  }
  if (available.length === 0) {
    throw new Error(
      "pickRandomCell: every cell is already picked (match should have resolved already)",
    );
  }
  return available[Math.floor(Math.random() * available.length)];
}

// ── Format helpers (used by the client-side result screen) ────────────
// Tiny utility to round a number to 2dp. Centralised here so the
// server store and the client UI produce identical strings
// (avoids "0.1 + 0.2 = 0.30000000000000004" surprises in the
// result modal).
export function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

// ── Cell index ↔ row/col helpers (used by the board UI) ───────────────
// Pure conversion: row-major cell index 0..24 ↔ { row, col }
// where row = floor(idx / GRID_SIZE), col = idx % GRID_SIZE.
export function cellIndexToRowCol(cellIndex) {
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) {
    return null;
  }
  return {
    row: Math.floor(idx / GRID_SIZE),
    col: idx % GRID_SIZE,
  };
}

export function rowColToCellIndex(row, col) {
  const r = Number(row);
  const c = Number(col);
  if (
    !Number.isInteger(r) ||
    !Number.isInteger(c) ||
    r < 0 ||
    r >= GRID_SIZE ||
    c < 0 ||
    c >= GRID_SIZE
  ) {
    return null;
  }
  return r * GRID_SIZE + c;
}

// Stable internal seat identity for free human-vs-AI matches. This is
// never a Clerk user and must never be used for balance/stat updates.
export const MINES_AI_PLAYER_ID = "mines_ai_bot";

export function isFreeAiMatch(match) {
  return Boolean(match?.isAi);
}

// ── AI pick pacing (legacy) ────────────────────────────────────────────
// Turn order is strict alternation now, so the bot never takes two turns
// in a row and no pacing window is required to separate its actions. This
// value still drives the client's own reveal-rhythm hold after a pick.
export const AI_PICK_DELAY_MS = 1500;

// Timestamp (ISO string or Date) of the bot's most recent pick, or
// null if it hasn't picked yet. The chronological `picks` array is
// scanned first (source of truth); the legacy `p2_picked_at` column
// is the fallback because in every free AI match the bot occupies
// player2, so it mirrors the bot's most recent pick.
export function lastAiPickAt(match) {
  if (!match) return null;
  const picks = Array.isArray(match.picks) ? match.picks : [];
  for (let i = picks.length - 1; i >= 0; i -= 1) {
    const p = picks[i];
    if (p && p.userId === MINES_AI_PLAYER_ID && p.pickedAt) {
      return p.pickedAt;
    }
  }
  return match.p2PickedAt ?? null;
}

// True when the bot is allowed to pick right now: either it has never
// picked (first pick of the match — no pacing window) or its previous
// pick happened at least AI_PICK_DELAY_MS ago. Pass `now` explicitly
// in tests.
export function aiPickDelayElapsed(match, now = Date.now()) {
  const last = lastAiPickAt(match);
  if (!last) return true;
  const ts =
    last instanceof Date ? last.getTime() : new Date(last).getTime();
  if (!Number.isFinite(ts)) return true;
  return now - ts >= AI_PICK_DELAY_MS;
}

// ── AI cell-selection strategy (reveal-only, deduction-driven) ────────
// The bot reveals one tile per turn and never flags (flags are a human
// strategy; the bot has no claim path). It reads exactly the SAME public
// information a human sees — every revealed cell and its server-stamped
// distance clue — and never peeks at the hidden board.
//
// For each unknown cell we estimate a RISK from the clues:
//   • a clue of `h` on cell r proves NO mine sits within Chebyshev
//     distance h-1 of r, so every cell strictly inside that radius is
//     risk 0 (provably safe),
//   • a cell on the h-radius frontier of a low-h clue is the most likely
//     to be the mine that clue is pointing at, so it scores highest.
// The bot then takes the lowest-risk cell. `chooseAiOption` applies the
// shared per-tier slip: `hard` always takes the best cell, `normal`
// occasionally takes a slightly worse one, and `easy` ignores deduction
// entirely and picks at random.
//
// `aiCellRisk` is exported for tests so the policy can be asserted without
// reaching into the picker.
export function aiCellRisk(cell, revealed) {
  let risk = 0;
  for (const { cell: r, hint } of revealed) {
    if (!Number.isInteger(hint) || hint < 1) continue;
    const d = chebyshevDistance(cell, r);
    if (d === null) continue;
    if (d < hint) continue; // provably safe given this clue
    // `edge` 0 means the cell sits right on the clue's mine frontier.
    const edge = d - hint;
    risk += 1 / (edge + 1) / hint;
  }
  return risk;
}

// Returns `{ cellIndex }` with a valid unpicked cell.
export function chooseAiCell(match, random = Math.random) {
  const picks = Array.isArray(match?.picks) ? match.picks : [];
  const exclude = new Set();
  const revealed = [];
  for (const p of picks) {
    const cell = Number(p?.cell);
    if (!Number.isInteger(cell) || cell < 0 || cell >= GRID_CELLS) continue;
    // A reveal clears the cell for good; a flag claim does not (it hides
    // the cell, so the board still has to be read from the clues).
    if (p?.flag) continue;
    exclude.add(cell);
    revealed.push({ cell, hint: Number(p?.hint) });
  }

  const available = [];
  for (let i = 0; i < GRID_CELLS; i += 1) {
    if (!exclude.has(i)) available.push(i);
  }
  if (available.length === 0) {
    // Every cell revealed — shouldn't happen (match should have resolved),
    // but pick cell 0 as a safe fallback.
    return { cellIndex: 0 };
  }

  // Shuffle the live cells so equal-risk ties break RANDOMLY. Without this
  // the stable sort below would hand the lowest index every tie, so the bot
  // would open cell 0 every single game.
  for (let i = available.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }

  const tier = coerceAiDifficulty(match?.aiDifficulty);

  // Easy: no deduction at all — a uniform random live cell.
  if (tier === "easy") {
    return {
      cellIndex: available[Math.floor(random() * available.length) % available.length],
    };
  }

  // Normal / hard: score by risk (lower is safer). `chooseAiOption` takes
  // the highest score, so negate the risk.
  const chosen = chooseAiOption(
    tier,
    available,
    (cell) => -aiCellRisk(cell, revealed),
    random,
  );
  return { cellIndex: chosen ?? 0 };
}

// ── Per-player mine counters ──────────────────────────────────────────
// The shared-board flag flow publishes a COUNT of confirmed mines per
// seat (never the locations). `minesFoundForSeat` derives it from the
// seat's own flag set + the server-only board, and
// `minesRemainingForSeat` is what the side-by-side "5 | 5" counter shows.
export function minesFoundForSeat(match, seat) {
  return correctFlagCount(flagsForSeat(match, seat), match?.board);
}

export function minesRemainingForSeat(match, seat) {
  const total = Number(match?.minesCount) || MINES_PER_MATCH;
  return Math.max(0, total - minesFoundForSeat(match, seat));
}

// ── Re-exports so the lobby + match UI can mirror the same
// constants without re-declaring them in the client.
export { GRID_SIZE as MINES_PVP_GRID_SIZE };
