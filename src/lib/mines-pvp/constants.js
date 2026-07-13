// src/lib/mines-pvp/constants.js
//
// Shared constants + board-gen + outcome resolution for the Mines PvP
// ("Mines Duel") match system. Built as a parallel to
// `src/lib/blackjack-pvp/constants.js` so the lobby + match flow
// shares the same shape (stake presets / round timer / status enum
// / advisory-lock namespace / RESULT enum) while the game logic is
// mines-specific (5×5 board gen, mine-hit detection, 2-pick
// outcome table, 90/10 payout split).
//
// The board-gen helper is intentionally kept INDEPENDENT from the
// solo-mines `generateBoard` in `src/app/api/mines/start/route.js`
// so we don't accidentally couple the PvP state machine to the
// single-player signed-session code path. The PvP board is
// server-authoritative and persisted on the match row in the
// `board` jsonb column (scrubbed from /status responses until
// status='finished').
//
// Resolution rules (per user spec):
//   P1 mine + P2 mine → P2 loses (P1 mined first)
//   P1 mine + P2 safe → P1 loses
//   P1 safe + P2 mine → P2 loses
//   P1 safe + P2 safe → DRAW (full refund, no house fee)
//
// Payout:
//   Winner: own stake back + 90% of loser's stake
//   Loser:   loses entire stake
//   House:   10% rake on loser's stake only
//   Draw:    both refunded, no rake

// ── Board geometry ────────────────────────────────────────────────────
// 5×5 grid, row-major indexing (cell 0 = top-left, cell 24 =
// bottom-right). Matches the solo-mines page's
// `Array(GRID_SIZE ** 2)` convention so the existing tileset
// styling/animation can be reused in the PvP client without any
// re-indexing of `cellType[cellIndex]`.
export const GRID_SIZE = 5;
export const GRID_CELLS = GRID_SIZE * GRID_SIZE; // 25
export const MIN_MINES = 1;
export const MAX_MINES = GRID_CELLS - 1; // 24 — never allow 25 (instant loss)

// ── Odds turn-pattern (minutesPvP "rounds continue until mine" flow) ──
// Per user spec the turn order after the server-randomised `firstPlayer`
// is taken into account is:
//
//   turn 1: firstPlayer      (FP leads)
//   turn 2: secondPlayer
//   turn 3: secondPlayer     (SP leads this pair)
//   turn 4: firstPlayer
//   turn 5: firstPlayer      (FP leads again — the pair-leader pattern flips)
//   turn 6: secondPlayer
//   turn 7: secondPlayer
//   turn 8: firstPlayer
//   ...
//
// Both players pick in alternation but in pairs of two — the LEAD
// player of each pair swaps every pair, so the pattern repeats
// every four turns.
//
// Closed form: for turn N (1-indexed),
//   N % 4 == 1 or N % 4 == 0  →  firstPlayer
//   N % 4 == 2 or N % 4 == 3  →  secondPlayer
//
// Encoded below as `seatForPickNumber` so the server store and the
// tests can both call it without re-deriving the rule. The pure
// return shape is the SEAT LABEL ("player1" | "player2"), not the
// clerkId — the call site maps seat → clerkId via the match row.
export function seatForPickNumber(pickNumber, firstPlayerSeat) {
  // Reject non-number inputs up front (`"1"`, `null`, `1.5`, `-1`,
  // `0` etc. all return null). Without the explicit `typeof` guard,
  // `Number("1")` coerces to the valid number 1 and the formula
  // would happily accept a string lookalike. `null` is a special
  // case: `Number(null) === 0` so the early `n < 1` rule does catch
  // it, but we keep the typeof guard for clarity.
  if (
    typeof pickNumber !== "number" ||
    !Number.isInteger(pickNumber) ||
    pickNumber < 1
  ) {
    return null;
  }
  const mod = ((pickNumber % 4) + 4) % 4; // safe for off-by-one / negative
  // mod == 1 (first turn) or mod == 0 (4th turn) → firstPlayer
  if (mod === 1 || mod === 0) return firstPlayerSeat;
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
export const MAX_STAKE = 1000000;

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
// Six states. The host creates a match (waiting → joins from
// lobby), player2 joins (ready → 3s banner → p1_turn), player1
// picks (→ p2_turn), player2 picks (→ finished). `cancelled` is
// reachable from any non-terminal state when a player disconnects
// past the grace period (or the host leaves before player2 joins).
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
// Mirrors blackjack-pvp / roulette-pvp convention.
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

// ── Mine lookup helper ────────────────────────────────────────────────
// Server-only check: returns true if `cellIndex` is a mine on
// `board`. `cellIndex` is a 0..GRID_CELLS-1 row-major index.
// Returns false for unknown cells (defence-in-depth so a
// tampered request can never trigger a crash).
export function isMine(board, cellIndex) {
  if (!board || !Array.isArray(board.mines)) return false;
  const idx = Number(cellIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_CELLS) return false;
  return board.mines.includes(idx);
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

// ── Payout calculator ─────────────────────────────────────────────────
// Returns the per-side settlement numbers for a resolved match:
//
//   { stake, winnerNet, loserNet, houseFee, prizePaid }
//
// Rules (per user spec):
//   DRAW:       both refunded. winnerNet = loserNet = null,
//               houseFee = 0, prizePaid = 0.
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
// either side has already locked in (so the auto-pick never
// re-uses the opponent's cell, which would be a no-op visual
// pick and trigger the resolution as "both picked at the same
// cell").
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

// ── Re-exports so the lobby + match UI can mirror the same
// constants without re-declaring them in the client.
export { GRID_SIZE as MINES_PVP_GRID_SIZE };
