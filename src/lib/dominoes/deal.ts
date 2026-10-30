/**
 * Dominoes — the DEAL: a shuffled double-six set, seven tiles each and fourteen
 * face down.
 *
 * This is the only module in the game that touches randomness, and it is kept
 * apart from `./rules` for exactly that reason: the rules engine is a pure
 * function of its state, while a deal is a one-off event that has to be
 * unpredictable on a server and reproducible in a test.
 *
 * RANDOMNESS POLICY
 *
 *   * The default source is `globalThis.crypto.getRandomValues` (Web Crypto),
 *     which Node has had since v15 and every browser and worker has. It is NOT
 *     `Math.random`, and there is no silent fallback: a runtime without Web
 *     Crypto throws instead of quietly dealing from a predictable sequence, and
 *     the caller's remedy is to inject its own RNG.
 *   * The RNG is a `() => number` returning a uniform value in [0, 1), so tests
 *     can pass a seeded generator and get an exact, repeatable deal. Every
 *     consumer takes it as an optional argument.
 *   * Fisher–Yates walks from the back, so each tile is swapped exactly once and
 *     the shuffle is uniform. The 2^-32 granularity of a `Uint32Array` draw
 *     leaves a bias of about 7e-9 at 28 items, which is not a strategy.
 *
 * DETERMINISM OF A DEALT MATCH
 *
 *   Hands are stored in CANONICAL tile order (`TILE_IDS`), so the same shuffled
 *   order always produces the same state object — a replay or a test can compare
 *   it byte for byte. The DRAW PILE keeps the shuffled order, because which tile
 *   comes off it next is the part that must stay secret and stable: the pile is
 *   the record of the shuffle, and a draw takes its front tile.
 */

import {
  DRAW_PILE_SIZE,
  HAND_SIZE,
  REJECTION,
  STARTING_RULES,
  TILE_COUNT,
  TILE_IDS,
} from "./constants";
import {
  DominoesRuleError,
  createInitialState,
  isTileId,
  tileOrder,
} from "./rules";
import type { Deal, DominoesState, Seat, StartingRule, TileId } from "./types";

/** Canonical tile order — the stable order every dealt hand is stored in. */
function byCanonicalOrder(a: TileId, b: TileId): number {
  return tileOrder(a) - tileOrder(b);
}

/**
 * A uniform value in [0, 1) from Web Crypto.
 *
 * Throws when the runtime has no `crypto.getRandomValues` — a predictable deal
 * is a rigged game, so the failure is loud rather than a fallback to
 * `Math.random`. Callers that cannot guarantee Web Crypto must inject `random`.
 */
export function secureUnitInterval(): number {
  const cryptoObject = (
    globalThis as {
      crypto?: { getRandomValues?: (array: Uint32Array) => Uint32Array };
    }
  ).crypto;
  if (!cryptoObject || typeof cryptoObject.getRandomValues !== "function") {
    throw new DominoesRuleError(
      REJECTION.INVALID_DEAL,
      "Web Crypto is unavailable — pass an explicit RNG to deal tiles",
    );
  }
  const buffer = new Uint32Array(1);
  cryptoObject.getRandomValues(buffer);
  return buffer[0] / 0x1_0000_0000;
}

/**
 * Shuffle the whole set and return the resulting order.
 *
 * `random` defaults to Web Crypto. A seeded `() => number` makes the shuffle
 * exactly reproducible, which is what the tests use; a non-finite draw is
 * rejected rather than turned into an out-of-range index.
 */
export function shuffleTiles(
  random: () => number = secureUnitInterval,
): TileId[] {
  const tiles = [...TILE_IDS];
  for (let index = tiles.length - 1; index > 0; index -= 1) {
    const draw = random();
    if (typeof draw !== "number" || !Number.isFinite(draw)) {
      throw new DominoesRuleError(
        REJECTION.INVALID_DEAL,
        "the shuffle RNG returned a non-finite value",
      );
    }
    // Clamped so a sloppy RNG that returns exactly 1 cannot index past the end.
    const bounded = Math.min(Math.max(draw, 0), 0.9999999999);
    const swapWith = Math.floor(bounded * (index + 1));
    const held = tiles[index];
    tiles[index] = tiles[swapWith];
    tiles[swapWith] = held;
  }
  return tiles;
}

/**
 * Slice an explicit 28-tile order into a deal: first seven to player1, next
 * seven to player2, the remaining fourteen to the pile.
 *
 * The order is validated (length, known canonical ids, no duplicates) because it
 * is the one input a caller supplies directly — a replay, a stored deal or a
 * test fixture. Hands are sorted canonically; the pile is not, because its order
 * IS the draw order.
 */
export function dealFromOrder(order: readonly TileId[]): Deal {
  if (!Array.isArray(order) || order.length !== TILE_COUNT) {
    throw new DominoesRuleError(
      REJECTION.INVALID_DEAL,
      `a deal needs all ${TILE_COUNT} tiles in order`,
    );
  }
  const seen = new Set<TileId>();
  for (const tile of order) {
    if (!isTileId(tile)) {
      throw new DominoesRuleError(
        REJECTION.INVALID_DEAL,
        `"${String(tile)}" is not a tile of a double-six set`,
      );
    }
    if (seen.has(tile)) {
      throw new DominoesRuleError(
        REJECTION.INVALID_DEAL,
        `tile ${tile} appears more than once`,
      );
    }
    seen.add(tile);
  }

  const player1 = order.slice(0, HAND_SIZE).sort(byCanonicalOrder);
  const player2 = order.slice(HAND_SIZE, HAND_SIZE * 2).sort(byCanonicalOrder);
  const drawPile = order.slice(HAND_SIZE * 2);

  if (drawPile.length !== DRAW_PILE_SIZE) {
    // Unreachable once the length is 28, kept so the sizes cannot drift apart.
    throw new DominoesRuleError(
      REJECTION.INVALID_DEAL,
      `the draw pile must hold exactly ${DRAW_PILE_SIZE} tiles`,
    );
  }

  return Object.freeze({
    hands: Object.freeze({
      player1: Object.freeze(player1),
      player2: Object.freeze(player2),
    }),
    drawPile: Object.freeze(drawPile),
  });
}

/** Shuffle and deal. The one call an online match needs to open a round. */
export function dealTiles(random: () => number = secureUnitInterval): Deal {
  return dealFromOrder(shuffleTiles(random));
}

/**
 * Shuffle, deal and build the initial state — the starting seat, the tile that
 * decided it and the opening double that is placed on the board are all derived
 * by `createInitialState`, never passed in.
 */
export function dealMatch(
  random: () => number = secureUnitInterval,
): DominoesState {
  return createInitialState(dealTiles(random));
}

/**
 * Deal the NEXT round of a match that already has a starting seat.
 *
 * Round 1's opener is decided BY THE DEAL (highest double, else highest total);
 * every later round inherits it from the round before — that round's WINNER, or,
 * after a level round, the seat that did not start it — so `startingSeat` is
 * imposed here and `rule` only records why.
 *
 * The set itself is dealt exactly like the first round (a fresh 28-tile shuffle,
 * 7 / 7 / 14). What this does NOT do is place an opening tile: the bid belongs to
 * `startingSeat`, which opens the fresh chain BY HAND with any tile it likes (no
 * double required). The returned state's chain is therefore empty and the turn
 * is the starter's.
 */
export function dealNextRound({
  startingSeat,
  rule = STARTING_RULES.PREVIOUS_WINNER,
  random = secureUnitInterval,
}: {
  startingSeat: Seat;
  rule?: StartingRule;
  random?: () => number;
}): DominoesState {
  return createInitialState(dealTiles(random), { seat: startingSeat, rule });
}
