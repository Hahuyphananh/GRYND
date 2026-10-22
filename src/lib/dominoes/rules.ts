/**
 * Dominoes — the PURE rules engine. No React, no HTTP, no DB, no browser APIs
 * and no randomness: the same input state always produces the same output,
 * which is what lets the board UI, the tests and (later) the server store all
 * share it.
 *
 * This module is the ONLY place the rules exist. The store will validate human
 * turns through `validateAction`, offer the seat's options from `legalActions`,
 * and persist whatever `applyAction` returns — nothing re-derives a legal tile,
 * an open end or a winner anywhere else. `./deal` owns the only source of
 * randomness (the shuffle), and it calls INTO this module, never the reverse.
 *
 * THE RULES, IN ONE PLACE (the long form is the header of `./constants`):
 *
 *   1. A double-six set is 28 unique tiles; a tile is named canonically
 *      (`"6-3"`, never `"3-6"`) so a duplicate cannot be expressed.
 *   2. Seven tiles each, fourteen face down. Drawing takes the FRONT of the
 *      pile, which is the shuffled order — never a fresh random index.
 *   3. The highest double starts; with no doubles, the highest pip total starts,
 *      and the canonical tile order breaks the tie. Both are total orders over
 *      two disjoint hands, so the same deal always yields the same first seat.
 *   4. One shared chain with two open values. A tile is legal on an end when one
 *      of its halves equals that end's open value; the engine orients the tile
 *      and the other half becomes the new open value.
 *   5. A tile can only be played by the seat on turn, from its own hand, in a
 *      live match. A playable tile can never be skipped.
 *   6. With nothing playable, a seat draws one tile at a time and KEEPS the
 *      turn; a drawn tile may be played at once, and an unplayable one means
 *      drawing again.
 *   7. With the pile empty and nothing playable, the seat passes.
 *   8. An empty hand wins immediately. With the pile empty and NEITHER seat able
 *      to play, fewer remaining pips wins and equal pips draw — checked after
 *      every accepted action.
 *   9. A finished match accepts nothing at all.
 *
 * WHAT IS NOT HERE: the 15-second turn clock, its timeout action, forfeits,
 * matchmaking and persistence all belong to the server store's policy. The
 * engine's job is to say what a turn MAY be, which is exactly what a timeout
 * resolver has to choose between.
 */

import {
  ACTION_TYPES,
  CHAIN_ENDS,
  DRAW_PILE_SIZE,
  END_REASONS,
  HAND_SIZE,
  MATCH_STATUS,
  REJECTION,
  SEATS,
  STARTING_RULES,
  TILE_COUNT,
  TILE_IDS,
} from "./constants";
import type {
  ActionRecord,
  ActionValidation,
  ChainEnd,
  ChainTile,
  Deal,
  DominoesAction,
  DominoesOutcome,
  DominoesState,
  DrawAction,
  EndReason,
  LegalAction,
  LegalPlayAction,
  PassAction,
  Pip,
  PlayAction,
  RejectionCode,
  Seat,
  StartingChoice,
  TileId,
} from "./types";

/** id → its two halves, major first. Built once from the canonical set. */
const TILE_VALUES: ReadonlyMap<TileId, readonly [Pip, Pip]> = new Map(
  TILE_IDS.map((id) => {
    const [high, low] = id.split("-");
    return [
      id,
      Object.freeze([Number(high), Number(low)]) as readonly [Pip, Pip],
    ] as const;
  }),
);

/** id → its position in the canonical order (the stable sort/tie-break key). */
const TILE_INDEX: ReadonlyMap<TileId, number> = new Map(
  TILE_IDS.map((id, index) => [id, index] as const),
);

/* -------------------------------------------------------------------------- *
 * Seats
 * -------------------------------------------------------------------------- */

/** `true` when `value` is one of the two seats. */
export function isSeat(value: unknown): value is Seat {
  return value === SEATS[0] || value === SEATS[1];
}

/** The other player. */
export function otherSeat(seat: Seat): Seat {
  return seat === SEATS[0] ? SEATS[1] : SEATS[0];
}

/* -------------------------------------------------------------------------- *
 * Tiles
 * -------------------------------------------------------------------------- */

/**
 * `true` for a tile of a double-six set, in canonical form.
 *
 * `"3-6"` is the same physical tile as `"6-3"` and is NOT accepted: the
 * canonical id is the identity, so a reversed id is a client bug rather than a
 * second tile. `"7-1"`, `"6"`, `""`, null and objects are all rejected.
 */
export function isTileId(value: unknown): value is TileId {
  return typeof value === "string" && TILE_VALUES.has(value as TileId);
}

/** `true` when `value` is a legal chain end. */
export function isChainEnd(value: unknown): value is ChainEnd {
  return value === CHAIN_ENDS[0] || value === CHAIN_ENDS[1];
}

/** The two halves of a tile, major first. Throws for a non-tile id. */
export function tileValues(id: TileId): readonly [Pip, Pip] {
  const values = TILE_VALUES.get(id);
  if (!values) {
    throw new DominoesRuleError(REJECTION.INVALID_TILE, `"${String(id)}" is not a dominoes tile`);
  }
  return values;
}

/** Total pips on one tile (a double counts its half twice). */
export function tilePips(id: TileId): number {
  const [high, low] = tileValues(id);
  return high + low;
}

/** `true` for a double — equal halves, displayed crosswise by the UI. */
export function isDoubleTile(id: TileId): boolean {
  const [high, low] = tileValues(id);
  return high === low;
}

/** Position of a tile in the canonical order (0 = `"6-6"`, 27 = `"0-0"`). */
export function tileOrder(id: TileId): number {
  const index = TILE_INDEX.get(id);
  if (index === undefined) {
    throw new DominoesRuleError(REJECTION.INVALID_TILE, `"${String(id)}" is not a dominoes tile`);
  }
  return index;
}

/** Total pips left in a hand — the blocked-round tie-break. */
export function pipsInHand(hand: readonly TileId[] | null | undefined): number {
  let total = 0;
  for (const tile of hand ?? []) total += tilePips(tile);
  return total;
}

/* -------------------------------------------------------------------------- *
 * The chain
 * -------------------------------------------------------------------------- */

/** The two open values of a chain: the first tile's left and the last one's right. */
export function openEndsOf(
  chain: readonly ChainTile[],
): Readonly<Record<ChainEnd, number | null>> {
  if (!chain || chain.length === 0) {
    return Object.freeze({ left: null, right: null });
  }
  return Object.freeze({
    left: chain[0].left,
    right: chain[chain.length - 1].right,
  });
}

/**
 * Structural audit of a chain: every tile is a real tile, its `left`/`right` are
 * its own two halves (in some order), `isDouble` agrees with them, and each tile
 * joins the previous one on the shared value.
 *
 * Used by the tests and by the store's integrity checks; the engine never needs
 * it, because it builds chains through `applyAction`.
 */
export function isChainConsistent(chain: readonly ChainTile[]): boolean {
  if (!Array.isArray(chain)) return false;
  for (let index = 0; index < chain.length; index += 1) {
    const tile = chain[index];
    if (!tile || !isTileId(tile.id)) return false;
    const [high, low] = tileValues(tile.id);
    const matchesOwnValues =
      (tile.left === high && tile.right === low) ||
      (tile.left === low && tile.right === high);
    if (!matchesOwnValues) return false;
    if (tile.isDouble !== (high === low)) return false;
    if (index > 0 && chain[index - 1].right !== tile.left) return false;
  }
  return true;
}

/**
 * How a tile sits at `end` when `open` is that end's value, or `null` when it
 * does not fit there.
 *
 * The matching half always faces the chain; the other half becomes the new open
 * value. A double has the same value on both halves, so both branches agree.
 */
function orientationFor(
  tile: TileId,
  end: ChainEnd,
  open: number,
): { left: number; right: number } | null {
  const [high, low] = tileValues(tile);
  if (end === CHAIN_ENDS[0]) {
    // Attaching on the left: the matching half must be the tile's RIGHT half.
    if (low === open) return { left: high, right: low };
    if (high === open) return { left: low, right: high };
    return null;
  }
  // Attaching on the right: the matching half must be the tile's LEFT half.
  if (high === open) return { left: high, right: low };
  if (low === open) return { left: low, right: high };
  return null;
}

/* -------------------------------------------------------------------------- *
 * The starting seat
 * -------------------------------------------------------------------------- */

/**
 * Who opens the round, and which tile decided it.
 *
 *   1. The highest double in either hand (6-6 down to 0-0).
 *   2. Otherwise the highest pip TOTAL, so a 5-5 (10) beats a 6-3 (9).
 *
 * Ties: two hands are disjoint, so equal totals are always DIFFERENT tiles. The
 * canonical order (`TILE_IDS`: descending high half, then descending low half)
 * breaks it, which makes the choice a total function of the deal — the same
 * deal always opens with the same seat.
 *
 * The opening tile is reported for the UI and the audit trail; it is NOT forced
 * as the first play. An empty chain accepts any tile from the starting hand, so
 * the seat on turn is free to open with whatever it likes.
 *
 * Throws `INVALID_DEAL` when there is no tile to choose from at all.
 */
export function chooseStartingSeat(
  hands: Readonly<Record<Seat, readonly TileId[]>>,
): StartingChoice {
  const owner = new Map<TileId, Seat>();
  for (const seat of SEATS) {
    for (const tile of hands?.[seat] ?? []) {
      // First seat wins a (malformed) hand that holds a tile twice or shares one
      // with the other hand; `createInitialState` rejects such a deal outright.
      if (!owner.has(tile)) owner.set(tile, seat);
    }
  }

  for (const tile of TILE_IDS) {
    if (!isDoubleTile(tile)) continue;
    const seat = owner.get(tile);
    if (seat) {
      return Object.freeze({
        seat,
        tile,
        rule: STARTING_RULES.HIGHEST_DOUBLE,
      });
    }
  }

  let bestTile: TileId | null = null;
  let bestSeat: Seat | null = null;
  for (const tile of TILE_IDS) {
    const seat = owner.get(tile);
    if (!seat) continue;
    // `TILE_IDS` is canonical order, so a strictly-greater test keeps the FIRST
    // tile of the maximum total — that is the documented tie-break.
    if (bestTile === null || tilePips(tile) > tilePips(bestTile)) {
      bestTile = tile;
      bestSeat = seat;
    }
  }
  if (!bestTile || !bestSeat) {
    throw new DominoesRuleError(
      REJECTION.INVALID_DEAL,
      "there are no tiles to choose a starting seat from",
    );
  }
  return Object.freeze({
    seat: bestSeat,
    tile: bestTile,
    rule: STARTING_RULES.HIGHEST_TOTAL,
  });
}

/* -------------------------------------------------------------------------- *
 * Construction
 * -------------------------------------------------------------------------- */

/**
 * A dealt start: 7 / 7 / 14, each of the 28 tiles exactly once.
 *
 * The deal is validated here rather than trusted, because a deal is the one
 * input that arrives from outside the engine (the store, a replay, a test). A
 * malformed deal must not silently become a match that can lose or duplicate a
 * tile.
 */
function assertDeal(deal: Deal): void {
  const candidate = deal as
    | { hands?: { player1?: unknown; player2?: unknown }; drawPile?: unknown }
    | null
    | undefined;
  if (!candidate || typeof candidate !== "object" || !candidate.hands) {
    throw new DominoesRuleError(REJECTION.INVALID_DEAL, "a deal needs two hands and a draw pile");
  }
  const hands = candidate.hands;
  const player1 = hands.player1;
  const player2 = hands.player2;
  const drawPile = candidate.drawPile;
  if (!Array.isArray(player1) || !Array.isArray(player2)) {
    throw new DominoesRuleError(REJECTION.INVALID_DEAL, "each hand must be an array of tiles");
  }
  if (!Array.isArray(drawPile)) {
    throw new DominoesRuleError(REJECTION.INVALID_DEAL, "the draw pile must be an array of tiles");
  }
  if (player1.length !== HAND_SIZE || player2.length !== HAND_SIZE) {
    throw new DominoesRuleError(
      REJECTION.INVALID_DEAL,
      `each hand must hold exactly ${HAND_SIZE} tiles`,
    );
  }
  if (drawPile.length !== DRAW_PILE_SIZE) {
    throw new DominoesRuleError(
      REJECTION.INVALID_DEAL,
      `the draw pile must hold exactly ${DRAW_PILE_SIZE} tiles`,
    );
  }

  const seen = new Set<TileId>();
  const all = [...player1, ...player2, ...drawPile];
  for (const tile of all) {
    if (!isTileId(tile)) {
      throw new DominoesRuleError(
        REJECTION.INVALID_DEAL,
        `"${String(tile)}" is not a tile of a double-six set`,
      );
    }
    if (seen.has(tile)) {
      throw new DominoesRuleError(REJECTION.INVALID_DEAL, `tile ${tile} appears more than once`);
    }
    seen.add(tile);
  }
  if (seen.size !== TILE_COUNT) {
    throw new DominoesRuleError(
      REJECTION.INVALID_DEAL,
      `a deal must use all ${TILE_COUNT} tiles, got ${seen.size}`,
    );
  }
}

/**
 * A fresh, ready-to-play match from a deal.
 *
 * Everything else is derived, never supplied: the starting seat and the tile
 * that decided it come from `chooseStartingSeat`, the chain starts empty and
 * both open ends start `null`. That is what makes a persisted deal replay to
 * exactly one state.
 */
export function createInitialState(deal: Deal): DominoesState {
  assertDeal(deal);
  const hands = Object.freeze({
    player1: Object.freeze([...deal.hands.player1]),
    player2: Object.freeze([...deal.hands.player2]),
  });
  const choice = chooseStartingSeat(hands);
  return freezeState({
    status: MATCH_STATUS.PLAYING,
    turn: choice.seat,
    ply: 0,
    hands,
    drawPile: Object.freeze([...deal.drawPile]),
    chain: Object.freeze([]),
    openEnds: openEndsOf([]),
    startingSeat: choice.seat,
    startingTile: choice.tile,
    winner: null,
    outcome: null,
    lastAction: null,
  });
}

/** An independent frozen copy of a state (never aliases the caller's arrays). */
export function cloneState(state: DominoesState): DominoesState {
  return freezeState(state);
}

function freezeState(state: DominoesState): DominoesState {
  return Object.freeze({
    ...state,
    hands: Object.freeze({
      player1: Object.freeze([...state.hands.player1]),
      player2: Object.freeze([...state.hands.player2]),
    }),
    drawPile: Object.freeze([...state.drawPile]),
    chain: Object.freeze([...state.chain]),
    openEnds: Object.freeze({
      left: state.openEnds.left,
      right: state.openEnds.right,
    }),
    outcome: state.outcome
      ? Object.freeze({
          winner: state.outcome.winner,
          reason: state.outcome.reason,
          pips: Object.freeze({
            player1: state.outcome.pips.player1,
            player2: state.outcome.pips.player2,
          }),
        })
      : null,
    lastAction: state.lastAction
      ? Object.freeze({
          seat: state.lastAction.seat,
          action: Object.freeze({ ...state.lastAction.action }) as LegalAction,
        })
      : null,
  });
}

/* -------------------------------------------------------------------------- *
 * Legal-action detection (no application)
 * -------------------------------------------------------------------------- */

/** Has the match stopped accepting actions? */
export function isMatchFinished(state: DominoesState): boolean {
  return !state || state.status !== MATCH_STATUS.PLAYING;
}

/**
 * Can `seat` play anything at all right now?
 *
 * This is the switch every draw/pass decision hangs on, so it is computed from
 * the hand and the two open values only — never from whose turn it is.
 */
export function hasLegalPlay(state: DominoesState, seat: Seat = state.turn): boolean {
  if (!state || state.status !== MATCH_STATUS.PLAYING) return false;
  const hand = state.hands?.[seat] ?? [];
  if (hand.length === 0) return false;
  // An open chain accepts any tile at all.
  if (state.chain.length === 0) return true;
  for (const tile of hand) {
    const [high, low] = tileValues(tile);
    for (const end of CHAIN_ENDS) {
      const open = state.openEnds[end];
      if (open === null || open === undefined) continue;
      if (high === open || low === open) return true;
    }
  }
  return false;
}

/**
 * Every legal play for `seat`, in hand order, then left end before right end.
 *
 * A tile that fits BOTH ends appears twice — choosing the end is a real choice
 * (it decides the tile's orientation and therefore the two new open values), so
 * the menu must offer it twice.
 *
 * On an empty chain every tile is legal and the action carries `end: "left"`,
 * the engine's canonical record for "this tile opened the chain".
 */
export function legalPlays(
  state: DominoesState,
  seat: Seat = state.turn,
): LegalPlayAction[] {
  if (!state || state.status !== MATCH_STATUS.PLAYING) return [];
  const hand = state.hands?.[seat] ?? [];
  const actions: LegalPlayAction[] = [];
  if (state.chain.length === 0) {
    for (const tile of hand) {
      actions.push(
        Object.freeze({ type: ACTION_TYPES.PLAY, tile, end: CHAIN_ENDS[0] }),
      );
    }
    return actions;
  }
  for (const tile of hand) {
    for (const end of CHAIN_ENDS) {
      const open = state.openEnds[end];
      if (open === null || open === undefined) continue;
      if (!orientationFor(tile, end, open)) continue;
      actions.push(Object.freeze({ type: ACTION_TYPES.PLAY, tile, end }));
    }
  }
  return actions;
}

/** The draw action, or `null` when a play exists, the pile is empty or the match is over. */
export function legalDraw(
  state: DominoesState,
  seat: Seat = state.turn,
): DrawAction | null {
  if (!state || state.status !== MATCH_STATUS.PLAYING) return null;
  if (hasLegalPlay(state, seat)) return null;
  if (state.drawPile.length === 0) return null;
  return Object.freeze({ type: ACTION_TYPES.DRAW });
}

/** The pass action, or `null` unless the seat is stuck with an empty pile. */
export function legalPass(
  state: DominoesState,
  seat: Seat = state.turn,
): PassAction | null {
  if (!state || state.status !== MATCH_STATUS.PLAYING) return null;
  if (hasLegalPlay(state, seat)) return null;
  if (state.drawPile.length > 0) return null;
  return Object.freeze({ type: ACTION_TYPES.PASS });
}

/**
 * Everything the seat on turn may do right now: its plays if it has any,
 * otherwise the single draw (pile not empty) or the single pass (pile empty).
 * An empty list means the match is over.
 *
 * The three cases are mutually exclusive BY CONSTRUCTION — a playable tile can
 * never be skipped and a draw can never be replaced by a pass — so a caller
 * cannot pick a menu that disagrees with `validateAction`.
 */
export function legalActions(state: DominoesState): LegalAction[] {
  if (!state || state.status !== MATCH_STATUS.PLAYING) return [];
  const plays = legalPlays(state);
  if (plays.length > 0) return plays;
  const draw = legalDraw(state);
  if (draw) return [draw];
  const pass = legalPass(state);
  if (pass) return [pass];
  return [];
}

/* -------------------------------------------------------------------------- *
 * Validation and application
 * -------------------------------------------------------------------------- */

/**
 * Can `seat` do `action` right now? Rejections are returned, not thrown, so the
 * API route can map `code` straight onto a 400 body.
 *
 * Order matters and is part of the contract: the SHAPE of the action is checked
 * first (a malformed turn is nonsense whichever match it targets), then the
 * lifecycle (a finished match accepts nothing), then turn ownership — checked
 * before any rule so a seat can never probe the board out of turn — and only
 * then the rule itself.
 */
export function validateAction(
  state: DominoesState,
  seat: Seat,
  action: DominoesAction,
): ActionValidation {
  // The action arrives from a client or a socket, so it is inspected as loose
  // data first: the declared types only describe what a good caller sends.
  const candidate = action as
    | { type?: unknown; tile?: unknown; end?: unknown }
    | null
    | undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {
      ok: false,
      code: REJECTION.INVALID_ACTION,
      message: "an action is a play, a draw or a pass",
    };
  }
  if (!isSeat(seat)) {
    return { ok: false, code: REJECTION.INVALID_SEAT, message: "unknown seat" };
  }
  if (
    candidate.type !== ACTION_TYPES.PLAY &&
    candidate.type !== ACTION_TYPES.DRAW &&
    candidate.type !== ACTION_TYPES.PASS
  ) {
    return {
      ok: false,
      code: REJECTION.INVALID_ACTION,
      message: 'an action is of type "play", "draw" or "pass"',
    };
  }
  if (candidate.type === ACTION_TYPES.PLAY) {
    if (!isTileId(candidate.tile)) {
      return {
        ok: false,
        code: REJECTION.INVALID_TILE,
        message: `"${String(candidate.tile)}" is not a tile of a double-six set`,
      };
    }
    // `end` may be omitted only while the chain is still empty; a bogus value is
    // rejected here rather than ignored.
    if (candidate.end !== undefined && candidate.end !== null && !isChainEnd(candidate.end)) {
      return {
        ok: false,
        code: REJECTION.INVALID_END,
        message: 'a chain end is either "left" or "right"',
      };
    }
  }

  if (!state || state.status !== MATCH_STATUS.PLAYING) {
    return {
      ok: false,
      code: REJECTION.MATCH_NOT_PLAYING,
      message: "the match is over — no further actions are accepted",
    };
  }
  if (seat !== state.turn) {
    return { ok: false, code: REJECTION.NOT_YOUR_TURN, message: "it is not your turn" };
  }

  if (candidate.type === ACTION_TYPES.PLAY) {
    const tile = candidate.tile as TileId;
    if (!state.hands[seat].includes(tile)) {
      return {
        ok: false,
        code: REJECTION.TILE_NOT_IN_HAND,
        message: `tile ${tile} is not in your hand`,
      };
    }
    // An open chain accepts the tile anywhere; the end it names is advisory and
    // normalised to "left" when it is applied.
    if (state.chain.length === 0) return { ok: true, kind: ACTION_TYPES.PLAY };

    if (candidate.end === undefined || candidate.end === null) {
      return {
        ok: false,
        code: REJECTION.INVALID_END,
        message: "choose which open end the tile goes on",
      };
    }
    const end = candidate.end as ChainEnd;
    const open = state.openEnds[end];
    if (open === null || open === undefined) {
      return {
        ok: false,
        code: REJECTION.INVALID_END,
        message: `the ${end} end of the chain is not open`,
      };
    }
    if (!orientationFor(tile, end, open)) {
      return {
        ok: false,
        code: REJECTION.TILE_MISMATCH,
        message: `tile ${tile} does not match the ${end} end (${open})`,
      };
    }
    return { ok: true, kind: ACTION_TYPES.PLAY };
  }

  if (candidate.type === ACTION_TYPES.DRAW) {
    if (hasLegalPlay(state, seat)) {
      return {
        ok: false,
        code: REJECTION.MUST_PLAY_TILE,
        message: "you have a playable tile and must play it",
      };
    }
    if (state.drawPile.length === 0) {
      return {
        ok: false,
        code: REJECTION.DRAW_PILE_EMPTY,
        message: "the draw pile is empty",
      };
    }
    return { ok: true, kind: ACTION_TYPES.DRAW };
  }

  if (hasLegalPlay(state, seat)) {
    return {
      ok: false,
      code: REJECTION.MUST_PLAY_TILE,
      message: "you have a playable tile and must play it",
    };
  }
  if (state.drawPile.length > 0) {
    return {
      ok: false,
      code: REJECTION.DRAW_PILE_NOT_EMPTY,
      message: "the draw pile still has tiles — draw before passing",
    };
  }
  return { ok: true, kind: ACTION_TYPES.PASS };
}

/** Thrown by `applyAction` for any action the rules reject. */
export class DominoesRuleError extends Error {
  readonly code: RejectionCode;
  readonly seat: Seat | null;
  readonly action: DominoesAction | null;

  constructor(
    code: RejectionCode,
    message: string,
    details: { seat?: Seat; action?: DominoesAction } = {},
  ) {
    super(message);
    this.name = "DominoesRuleError";
    this.code = code;
    this.seat = details.seat ?? null;
    this.action = details.action ?? null;
  }
}

/** Narrow a caught error back to a rule rejection (for route handlers). */
export function isDominoesRuleError(value: unknown): value is DominoesRuleError {
  return value instanceof DominoesRuleError;
}

/**
 * Is the round over by BLOCKAGE — pile empty and neither seat able to play?
 *
 * This is a property of the position, not of whose turn it is, so it is checked
 * after every accepted action. A live match always has an action available.
 */
export function isBlocked(state: DominoesState): boolean {
  if (!state || state.status !== MATCH_STATUS.PLAYING) return false;
  if (state.drawPile.length > 0) return false;
  return !hasLegalPlay(state, SEATS[0]) && !hasLegalPlay(state, SEATS[1]);
}

function pipsBySeat(state: DominoesState): Record<Seat, number> {
  return {
    player1: pipsInHand(state.hands.player1),
    player2: pipsInHand(state.hands.player2),
  };
}

/** Close the round with the given winner (`null` = drawn on pips). */
function finishWith(
  state: DominoesState,
  reason: EndReason,
  winner: Seat | null,
): DominoesState {
  const pips = Object.freeze(pipsBySeat(state));
  const outcome: DominoesOutcome = Object.freeze({ winner, reason, pips });
  return freezeState({
    ...state,
    status: MATCH_STATUS.FINISHED,
    winner,
    outcome,
  });
}

/** Finish on blockage when the position has become blocked; otherwise pass through. */
function finishIfBlocked(state: DominoesState): DominoesState {
  if (!isBlocked(state)) return state;
  const pips = pipsBySeat(state);
  const winner =
    pips.player1 < pips.player2
      ? SEATS[0]
      : pips.player2 < pips.player1
        ? SEATS[1]
        : null;
  return finishWith(state, END_REASONS.BLOCKED_PIPS, winner);
}

/** A hand without `tile`. The engine validated membership before calling this. */
function withoutTile(hand: readonly TileId[], tile: TileId, seat: Seat): TileId[] {
  const index = hand.indexOf(tile);
  if (index < 0) {
    throw new DominoesRuleError(REJECTION.TILE_NOT_IN_HAND, `tile ${tile} is not in your hand`, {
      seat,
    });
  }
  return [...hand.slice(0, index), ...hand.slice(index + 1)];
}

/** The chain tile `seat`'s play creates, with the engine's resolved orientation. */
function chainTileFor(
  state: DominoesState,
  seat: Seat,
  action: PlayAction,
): ChainTile {
  const [high, low] = tileValues(action.tile);
  const isDouble = high === low;

  if (state.chain.length === 0) {
    return Object.freeze({
      id: action.tile,
      end: CHAIN_ENDS[0],
      left: high,
      right: low,
      isDouble,
      seat,
    });
  }

  const end = action.end as ChainEnd;
  const open = state.openEnds[end];
  const orientation =
    open === null || open === undefined ? null : orientationFor(action.tile, end, open);
  if (!orientation) {
    throw new DominoesRuleError(
      REJECTION.TILE_MISMATCH,
      `tile ${action.tile} does not match the ${end} end`,
      { seat, action },
    );
  }
  return Object.freeze({
    id: action.tile,
    end,
    left: orientation.left,
    right: orientation.right,
    isDouble,
    seat,
  });
}

/**
 * Apply `action` for `seat` and return the NEXT state. The input state is never
 * touched — neither when the action is accepted (a new frozen object is
 * returned, the old one still reads exactly as before) nor when it is rejected
 * (a `DominoesRuleError` carrying `code` is thrown, and nothing was written).
 *
 * A finishing action ends the round inside the same call: `status` becomes
 * `"finished"`, `winner`/`outcome` record the result, and `legalActions` is
 * empty from then on.
 */
export function applyAction(
  state: DominoesState,
  seat: Seat,
  action: DominoesAction,
): DominoesState {
  const validation = validateAction(state, seat, action);
  if (validation.ok === false) {
    throw new DominoesRuleError(validation.code, validation.message, { seat, action });
  }

  if (action.type === ACTION_TYPES.PLAY) {
    const hand = withoutTile(state.hands[seat], action.tile, seat);
    const chainTile = chainTileFor(state, seat, action);
    // The chain array IS left-to-right order, so a tile attached on the LEFT is
    // prepended. Appending everything would leave `openEndsOf` reading the old
    // first tile as the left end.
    const chain =
      state.chain.length === 0
        ? [chainTile]
        : chainTile.end === CHAIN_ENDS[0]
          ? [chainTile, ...state.chain]
          : [...state.chain, chainTile];
    const chainEnd: ChainEnd = state.chain.length === 0 ? CHAIN_ENDS[0] : (action.end as ChainEnd);
    const record: ActionRecord = Object.freeze({
      seat,
      action: Object.freeze({
        type: ACTION_TYPES.PLAY,
        tile: action.tile,
        end: chainEnd,
      }) as LegalPlayAction,
    });

    // Frozen BEFORE the terminal checks: a live state is returned as-is, so it
    // has to be frozen by construction, not only when the round ends.
    const played = freezeState({
      ...state,
      ply: state.ply + 1,
      turn: otherSeat(seat),
      hands: { ...state.hands, [seat]: hand },
      chain,
      openEnds: openEndsOf(chain),
      lastAction: record,
    });

    // Rule 8: emptying a hand wins immediately, before any blockage check.
    if (hand.length === 0) {
      return finishWith(played, END_REASONS.EMPTIED_HAND, seat);
    }
    return finishIfBlocked(played);
  }

  if (action.type === ACTION_TYPES.DRAW) {
    return drawNextTile(state, seat);
  }

  return passTurn(state, seat);
}

/**
 * Take the front tile off the pile (rule 6). The seat keeps the turn.
 *
 * The pile is non-empty at every call site (the validator and `applyTimeout`
 * both guarantee it), and its ORDER is the shuffled order, so taking the front
 * is the deterministic replay of a persisted deal.
 *
 * One implementation, two callers: a player's draw and the clock's draw, so a
 * timeout can never resolve differently from a voluntary draw.
 */
function drawNextTile(state: DominoesState, seat: Seat): DominoesState {
  const [drawn, ...rest] = state.drawPile;
  const record: ActionRecord = Object.freeze({
    seat,
    action: Object.freeze({ type: ACTION_TYPES.DRAW }) as DrawAction,
  });
  const drawnState = freezeState({
    ...state,
    ply: state.ply + 1,
    // A draw does NOT pass the turn: the seat keeps drawing until it can play.
    turn: seat,
    drawPile: rest,
    hands: { ...state.hands, [seat]: [...state.hands[seat], drawn] },
    lastAction: record,
  });
  // The last draw can empty the pile while neither seat can play.
  return finishIfBlocked(drawnState);
}

/**
 * Give up the turn (rule 7). Only the clock's pass can happen while a tile is
 * playable — a player's pass is refused by `validateAction` long before here.
 */
function passTurn(state: DominoesState, seat: Seat): DominoesState {
  const record: ActionRecord = Object.freeze({
    seat,
    action: Object.freeze({ type: ACTION_TYPES.PASS }) as PassAction,
  });
  return finishIfBlocked(
    freezeState({
      ...state,
      ply: state.ply + 1,
      turn: otherSeat(seat),
      lastAction: record,
    }),
  );
}

/**
 * THE CLOCK'S ACTION — resolve an expired turn for the seat on turn.
 *
 * The policy is the store's (15 seconds per turn) and it is stated once here so
 * the server never invents a second set of rules under time pressure:
 *
 *   * pile not empty → draw ONE tile, exactly as a voluntary draw does (the
 *     seat keeps the turn, and the store stamps a fresh deadline);
 *   * pile empty     → pass, handing the turn over.
 *
 * Both branches run the SAME helpers a player's action runs, so a timeout can
 * never produce a position a player could not have produced, and the terminal
 * check (empty hand / blockage) is identical.
 *
 * DELIBERATE DIFFERENCE FROM `applyAction`: this action does not require the
 * seat to be stuck. Rule 6 governs a player's VOLUNTARY draw; the clock is not
 * a player, and a stalling seat must not be able to freeze the round by holding
 * a playable tile. Nothing a client sends can reach this function — the routes
 * map a body action to `validateAction`/`applyAction` only, and this is called
 * by the store's deadline resolver after it has read the row's own deadline.
 */
export function applyTimeout(
  state: DominoesState,
  seat: Seat = state ? state.turn : SEATS[0],
): DominoesState {
  if (!state || state.status !== MATCH_STATUS.PLAYING) {
    throw new DominoesRuleError(
      REJECTION.MATCH_NOT_PLAYING,
      "the match is over — the clock has nothing to resolve",
    );
  }
  if (!isSeat(seat)) {
    throw new DominoesRuleError(REJECTION.INVALID_SEAT, "unknown seat", { seat });
  }
  if (seat !== state.turn) {
    throw new DominoesRuleError(
      REJECTION.NOT_YOUR_TURN,
      "only the seat on turn can time out",
      { seat },
    );
  }
  return state.drawPile.length > 0 ? drawNextTile(state, seat) : passTurn(state, seat);
}

/**
 * Convenience for callers that would rather branch on a boolean than catch:
 * applies the action or returns null. Used by the tests and (later) by the
 * store's timeout resolver.
 */
export function tryApplyAction(
  state: DominoesState,
  seat: Seat,
  action: DominoesAction,
): DominoesState | null {
  try {
    return applyAction(state, seat, action);
  } catch (error) {
    if (isDominoesRuleError(error)) return null;
    throw error;
  }
}
