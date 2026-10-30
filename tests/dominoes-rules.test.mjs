/**
 * dominoes-rules.test.mjs
 *
 * The PURE Dominoes rules engine, pinned exhaustively.
 *
 * Dominoes is the two-player block game on a double-six set: 28 unique tiles,
 * seven each and fourteen face down; the highest double starts AND opens — the
 * deal places that double on the board, leaving its holder six tiles and the
 * other seat to play; a tile may only be played on an open end it matches; a
 * seat with nothing playable draws one tile at a time (keeping the turn) until
 * it can play, and passes only when the pile is empty; an empty hand wins at
 * once, and with the pile empty and neither seat able to play the fewer
 * remaining pips win (equal pips draw).
 *
 * This suite is the referee: the set, the deal, the starting-seat rule and its
 * opening placement, the ends a tile may be placed on, chain orientation at both
 * ends, drawing, passing, blockage, victory, every rejection code, and the
 * anti-cheat property — a rejected action leaves the authoritative state byte
 * for byte untouched, a successful one never mutates its input, and the engine's
 * own generated actions are always accepted by its own validator (asserted by a
 * deterministic self-play fuzz, not by hope).
 *
 * Run:  node --import tsx --test tests/dominoes-rules.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_TYPES,
  CHAIN_ENDS,
  DRAW_PILE_SIZE,
  END_REASONS,
  HAND_SIZE,
  MATCH_STATUS,
  MATCH_TARGET_POINTS,
  MAX_PIP,
  REJECTION,
  SEATS,
  STARTING_RULES,
  TILE_COUNT,
  TILE_IDS,
} from "../src/lib/dominoes/constants.ts";
import {
  DominoesRuleError,
  applyAction,
  chooseStartingSeat,
  cloneState,
  createInitialState,
  hasLegalPlay,
  isBlocked,
  isChainConsistent,
  isChainEnd,
  isDominoesRuleError,
  isDoubleTile,
  isMatchFinished,
  isTileId,
  legalActions,
  legalDraw,
  legalPass,
  legalPlays,
  openEndsOf,
  otherSeat,
  pipsInHand,
  roundPoints,
  tileOrder,
  tilePips,
  tileValues,
  tryApplyAction,
  validateAction,
} from "../src/lib/dominoes/rules.ts";
import {
  dealFromOrder,
  dealMatch,
  dealTiles,
  secureUnitInterval,
  shuffleTiles,
} from "../src/lib/dominoes/deal.ts";

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

/** A deterministic [0,1) generator (LCG) — the same seed, the same game. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Deep snapshot for "nothing changed" assertions. */
function snapshot(state) {
  return JSON.stringify(state);
}

/**
 * A crafted position.
 *
 * `createInitialState` is the only way a real match starts; these objects exist
 * so a test can describe a mid-game position in one line. `openEnds` is derived
 * from the chain, so a deliberately inconsistent `openEnds` cannot be created.
 */
function position({
  p1 = [],
  p2 = [],
  pile = [],
  chain = [],
  turn = "player1",
  status = MATCH_STATUS.PLAYING,
  ply = 0,
} = {}) {
  return {
    status,
    turn,
    ply,
    hands: { player1: p1, player2: p2 },
    drawPile: pile,
    chain,
    openEnds: openEndsOf(chain),
    startingSeat: SEATS[0],
    startingTile: p1[0] ?? p2[0] ?? "0-0",
    winner: null,
    outcome: null,
    lastAction: null,
  };
}

/**
 * A position whose chain was built by the REAL engine (player1 opened with
 * `opening`), then re-seated with the hands and pile the test cares about.
 * Building it through `applyAction` is what makes the orientations authentic.
 */
function afterOpening({
  opening = "6-3",
  p1 = [],
  p2 = [],
  pile = [],
  turn = SEATS[1],
} = {}) {
  const played = applyAction(
    position({ p1: [opening], p2: [] }),
    SEATS[0],
    { type: ACTION_TYPES.PLAY, tile: opening },
  );
  return position({ p1, p2, pile, chain: played.chain, turn });
}

/** Every tile a state holds, wherever it is. */
function heldTiles(state) {
  return [
    ...state.hands.player1,
    ...state.hands.player2,
    ...state.chain.map((tile) => tile.id),
    ...state.drawPile,
  ];
}

/** The rejection code a validation/apply attempt produces, or null if accepted. */
function rejectionFor(state, seat, action) {
  const validation = validateAction(state, seat, action);
  if (validation.ok) return null;
  assert.equal(tryApplyAction(state, seat, action), null, "a rejected action must not apply");
  return validation.code;
}

/* -------------------------------------------------------------------------- *
 * The set
 * -------------------------------------------------------------------------- */

test("the set is exactly 28 unique double-six tiles", () => {
  assert.equal(MAX_PIP, 6);
  assert.equal(TILE_COUNT, 28);
  assert.equal(TILE_IDS.length, 28);
  assert.equal(new Set(TILE_IDS).size, 28, "no tile may appear twice");

  // Every unordered pair of values 0..6, and nothing else.
  const expected = new Set();
  for (let high = 0; high <= 6; high += 1) {
    for (let low = 0; low <= high; low += 1) expected.add(`${high}-${low}`);
  }
  assert.deepEqual(new Set(TILE_IDS), expected);
  assert.ok(Object.isFrozen(TILE_IDS), "the set itself is immutable");
});

test("tile identity is canonical, and a reversed id is not a tile", () => {
  for (const id of TILE_IDS) {
    const [high, low] = tileValues(id);
    assert.equal(id, `${high}-${low}`, `${id} must be written major half first`);
    assert.ok(high >= low);
    assert.ok(high <= 6 && low <= 6);
  }
  assert.ok(isTileId("6-3"));
  assert.ok(isTileId("0-0"));
  assert.equal(isTileId("3-6"), false, "3-6 is the same physical tile as 6-3");
  assert.equal(isTileId("7-1"), false);
  assert.equal(isTileId("6"), false);
  assert.equal(isTileId(""), false);
  assert.equal(isTileId(null), false);
  assert.equal(isTileId({ id: "6-3" }), false);
  assert.equal(isChainEnd("left"), true);
  assert.equal(isChainEnd("right"), true);
  assert.equal(isChainEnd("middle"), false);
});

test("pip totals, doubles and the canonical order", () => {
  assert.equal(tilePips("6-6"), 12);
  assert.equal(tilePips("6-0"), 6);
  assert.equal(tilePips("0-0"), 0);
  assert.equal(pipsInHand(["6-6", "6-0", "0-0"]), 18);

  assert.equal(isDoubleTile("6-6"), true);
  assert.equal(isDoubleTile("6-5"), false);
  assert.equal(TILE_IDS.filter(isDoubleTile).length, 7);

  // Canonical order: descending high half, then descending low half.
  assert.equal(TILE_IDS[0], "6-6");
  assert.equal(TILE_IDS[1], "6-5");
  assert.equal(TILE_IDS[TILE_IDS.length - 1], "0-0");
  assert.equal(tileOrder("6-6"), 0);
  assert.equal(tileOrder("0-0"), 27);
  assert.ok(tileOrder("6-3") < tileOrder("5-4"), "6-3 precedes 5-4");
});

test("nothing in the engine mutates the shared set", () => {
  const before = [...TILE_IDS];
  shuffleTiles(seeded(7));
  assert.deepEqual([...TILE_IDS], before);
});

/* -------------------------------------------------------------------------- *
 * The deal
 * -------------------------------------------------------------------------- */

test("a deal gives seven tiles each and fourteen face down, using all 28", () => {
  const deal = dealTiles(seeded(1));
  assert.equal(deal.hands.player1.length, HAND_SIZE);
  assert.equal(deal.hands.player2.length, HAND_SIZE);
  assert.equal(deal.drawPile.length, DRAW_PILE_SIZE);
  assert.equal(HAND_SIZE * 2 + DRAW_PILE_SIZE, TILE_COUNT);

  const all = [...deal.hands.player1, ...deal.hands.player2, ...deal.drawPile];
  assert.equal(all.length, 28);
  assert.equal(new Set(all).size, 28, "every tile is dealt exactly once");
  assert.deepEqual(new Set(all), new Set(TILE_IDS));

  // Hands are stored in canonical order so a state compares byte for byte.
  for (const hand of [deal.hands.player1, deal.hands.player2]) {
    const orders = hand.map(tileOrder);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  }
  assert.ok(Object.isFrozen(deal.hands.player1));
  assert.ok(Object.isFrozen(deal.drawPile));
});

test("the shuffle is a permutation, and a seeded RNG is reproducible", () => {
  const order = shuffleTiles(seeded(42));
  assert.deepEqual([...order].sort(), [...TILE_IDS].sort());
  assert.equal(new Set(order).size, TILE_COUNT);

  const a = dealTiles(seeded(99));
  const b = dealTiles(seeded(99));
  assert.deepEqual(a, b, "the same seed deals the same match");

  const deals = [1, 2, 3, 4].map((seed) => dealTiles(seeded(seed)));
  const distinct = new Set(deals.map((deal) => JSON.stringify(deal)));
  assert.ok(distinct.size > 1, "different seeds should deal differently");
});

test("a non-finite draw from the shuffle RNG is refused", () => {
  assert.throws(
    () => shuffleTiles(() => Number.NaN),
    (error) => isDominoesRuleError(error) && error.code === REJECTION.INVALID_DEAL,
  );
});

test("dealFromOrder validates the order it is handed", () => {
  const deal = dealFromOrder(TILE_IDS);
  assert.deepEqual(deal.hands.player1, [...TILE_IDS.slice(0, 7)].sort((a, b) => tileOrder(a) - tileOrder(b)));
  assert.deepEqual(deal.hands.player2, [...TILE_IDS.slice(7, 14)].sort((a, b) => tileOrder(a) - tileOrder(b)));
  assert.deepEqual(deal.drawPile, TILE_IDS.slice(14));

  assert.throws(
    () => dealFromOrder(TILE_IDS.slice(0, 27)),
    (error) => isDominoesRuleError(error) && error.code === REJECTION.INVALID_DEAL,
  );
  const duplicated = [...TILE_IDS];
  duplicated[27] = duplicated[0];
  assert.throws(
    () => dealFromOrder(duplicated),
    (error) => isDominoesRuleError(error) && error.code === REJECTION.INVALID_DEAL,
  );
  const reversed = [...TILE_IDS];
  reversed[0] = "3-6";
  assert.throws(
    () => dealFromOrder(reversed),
    (error) => isDominoesRuleError(error) && error.code === REJECTION.INVALID_DEAL,
  );
});

test("createInitialState rejects a deal that is not a double-six deal", () => {
  const good = dealFromOrder(TILE_IDS);
  const bad = (mutate) => {
    const deal = {
      hands: { player1: [...good.hands.player1], player2: [...good.hands.player2] },
      drawPile: [...good.drawPile],
    };
    mutate(deal);
    return deal;
  };

  assert.throws(() => createInitialState(bad((d) => d.hands.player1.pop())), {
    code: REJECTION.INVALID_DEAL,
  });
  assert.throws(() => createInitialState(bad((d) => d.drawPile.pop())), {
    code: REJECTION.INVALID_DEAL,
  });
  assert.throws(
    () => createInitialState(bad((d) => d.hands.player2.push(d.hands.player1[0]))),
    { code: REJECTION.INVALID_DEAL },
  );
  assert.throws(() => createInitialState(bad((d) => (d.drawPile[0] = "3-6"))), {
    code: REJECTION.INVALID_DEAL,
  });
  assert.throws(() => createInitialState({}), { code: REJECTION.INVALID_DEAL });
});

test("the highest double is PLAYED by the deal: one tile down, its holder left with six", () => {
  const state = dealMatch(seeded(5));
  assert.equal(state.status, MATCH_STATUS.PLAYING);

  // The deal's own choice — and player2 holds the (seed's) double six.
  assert.equal(state.startingSeat, SEATS[1]);
  assert.equal(state.startingTile, "6-6");
  assert.ok(isDoubleTile(state.startingTile));

  // …and that double is already the chain's only tile.
  assert.deepEqual(state.chain, [
    { id: "6-6", end: CHAIN_ENDS[0], left: 6, right: 6, isDouble: true, seat: SEATS[1] },
  ]);
  assert.deepEqual(state.openEnds, { left: 6, right: 6 });
  assert.ok(isChainConsistent(state.chain));

  // The holder is a tile lighter and the OTHER seat is the one to play.
  assert.equal(state.hands.player2.length, HAND_SIZE - 1);
  assert.equal(state.hands.player1.length, HAND_SIZE);
  assert.equal(state.turn, otherSeat(state.startingSeat));
  assert.equal(state.ply, 1, "the opening placement is the round's first action");
  assert.deepEqual(state.lastAction, {
    seat: SEATS[1],
    action: { type: ACTION_TYPES.PLAY, tile: "6-6", end: CHAIN_ENDS[0] },
  });
  assert.equal(
    state.hands[state.startingSeat].includes(state.startingTile),
    false,
    "the opener no longer holds the tile that is on the board",
  );

  // No tile was lost on the way: all 28 are on the table, once each.
  assert.equal(state.drawPile.length, DRAW_PILE_SIZE);
  assert.equal(heldTiles(state).length, TILE_COUNT);
  assert.equal(new Set(heldTiles(state)).size, TILE_COUNT);
  assert.equal(state.winner, null);
  assert.equal(state.outcome, null);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.hands.player1));
  assert.ok(SEATS.includes(state.turn));
});

test("a deal with no double is the one start left to the opener", () => {
  // Every double (0-0 … 6-6) sits in the pile, so neither hand has one.
  const doubles = TILE_IDS.filter(isDoubleTile);
  const order = [...TILE_IDS.filter((tile) => !isDoubleTile(tile)), ...doubles];
  const deal = dealFromOrder(order);
  const choice = chooseStartingSeat(deal.hands);
  assert.equal(choice.rule, STARTING_RULES.HIGHEST_TOTAL);
  assert.equal(isDoubleTile(choice.tile), false);

  const state = createInitialState(deal);
  // Nothing is placed: seven tiles each, an empty chain, and the winning seat
  // opens with any tile it likes (which is still a legal chain play).
  assert.deepEqual(state.chain, []);
  assert.deepEqual(state.openEnds, { left: null, right: null });
  assert.equal(state.ply, 0);
  assert.equal(state.lastAction, null);
  assert.equal(state.turn, choice.seat);
  assert.equal(state.startingSeat, choice.seat);
  assert.equal(state.startingTile, choice.tile);
  assert.equal(state.hands.player1.length, HAND_SIZE);
  assert.equal(state.hands.player2.length, HAND_SIZE);
  assert.equal(legalPlays(state).length, HAND_SIZE, "any tile may open an empty chain");
  assert.equal(heldTiles(state).length, TILE_COUNT);
  assert.equal(new Set(heldTiles(state)).size, TILE_COUNT);
});

test("after the opening double, a tile is placed on whichever end the player picks", () => {
  // A deliberate deal: player1 holds all seven doubles, so 6-6 opens the round,
  // and player2 holds six 6-x tiles — each of which meets BOTH open ends — plus
  // 5-4, which meets neither.
  const order = [
    "6-6", "5-5", "4-4", "3-3", "2-2", "1-1", "0-0",
    "6-5", "6-4", "6-3", "6-2", "6-1", "6-0", "5-4",
    "5-3", "5-2", "5-1", "5-0", "4-3", "4-2", "4-1", "4-0",
    "3-2", "3-1", "3-0", "2-1", "2-0", "1-0",
  ];
  assert.equal(new Set(order).size, TILE_COUNT, "the fixture must be a real deal");
  const state = createInitialState(dealFromOrder(order));
  assert.equal(state.startingTile, "6-6");
  assert.equal(state.turn, SEATS[1]);
  assert.deepEqual(state.openEnds, { left: 6, right: 6 });

  // Both ends are offered for every tile that fits both, and nothing else is.
  const plays = legalPlays(state, SEATS[1]);
  assert.equal(plays.length, 12, "six matching tiles, each end available");
  assert.deepEqual(
    plays.filter((action) => action.tile === "6-5").map((action) => action.end),
    [CHAIN_ENDS[0], CHAIN_ENDS[1]],
  );
  assert.equal(plays.some((action) => action.tile === "5-4"), false);
  assert.equal(
    rejectionFor(state, SEATS[1], {
      type: ACTION_TYPES.PLAY,
      tile: "5-4",
      end: CHAIN_ENDS[0],
    }),
    REJECTION.TILE_MISMATCH,
  );

  // The end is a REAL choice: the same tile, two different chains.
  const onLeft = applyAction(state, SEATS[1], {
    type: ACTION_TYPES.PLAY,
    tile: "6-5",
    end: CHAIN_ENDS[0],
  });
  assert.deepEqual(
    onLeft.chain.map((tile) => [tile.left, tile.right]),
    [[5, 6], [6, 6]],
  );
  assert.deepEqual(onLeft.openEnds, { left: 5, right: 6 });

  const onRight = applyAction(state, SEATS[1], {
    type: ACTION_TYPES.PLAY,
    tile: "6-5",
    end: CHAIN_ENDS[1],
  });
  assert.deepEqual(
    onRight.chain.map((tile) => [tile.left, tile.right]),
    [[6, 6], [6, 5]],
  );
  assert.deepEqual(onRight.openEnds, { left: 6, right: 5 });
  assert.ok(isChainConsistent(onLeft.chain));
  assert.ok(isChainConsistent(onRight.chain));
});

test("the default RNG is Web Crypto, and it deals a valid match", () => {
  assert.ok(Number.isFinite(secureUnitInterval()));
  const a = secureUnitInterval();
  assert.ok(a >= 0 && a < 1);
  const state = dealMatch();
  assert.equal(state.status, MATCH_STATUS.PLAYING);
  assert.equal(new Set(heldTiles(state)).size, TILE_COUNT);
});

/* -------------------------------------------------------------------------- *
 * The starting seat
 * -------------------------------------------------------------------------- */

test("the highest double starts, across both hands", () => {
  const choice = chooseStartingSeat({ player1: ["6-6", "1-1"], player2: ["5-5"] });
  assert.deepEqual(choice, {
    seat: SEATS[0],
    tile: "6-6",
    rule: STARTING_RULES.HIGHEST_DOUBLE,
  });

  const other = chooseStartingSeat({ player1: ["6-3"], player2: ["4-4"] });
  assert.deepEqual(other, {
    seat: SEATS[1],
    tile: "4-4",
    rule: STARTING_RULES.HIGHEST_DOUBLE,
  });
});

test("a double outranks a bigger pip total", () => {
  // player1 holds 6-5 (11 pips), player2 only 1-1 (2) — but 1-1 is the double.
  const choice = chooseStartingSeat({ player1: ["6-5"], player2: ["1-1"] });
  assert.equal(choice.seat, SEATS[1]);
  assert.equal(choice.tile, "1-1");
  assert.equal(choice.rule, STARTING_RULES.HIGHEST_DOUBLE);
});

test("with no doubles the highest pip total starts", () => {
  const higher = chooseStartingSeat({ player1: ["6-3"], player2: ["4-3"] });
  assert.deepEqual(higher, {
    seat: SEATS[0],
    tile: "6-3",
    rule: STARTING_RULES.HIGHEST_TOTAL,
  });

  const other = chooseStartingSeat({ player1: ["4-1"], player2: ["5-4"] });
  assert.deepEqual(other, {
    seat: SEATS[1],
    tile: "5-4",
    rule: STARTING_RULES.HIGHEST_TOTAL,
  });
});

test("equal totals are broken by the canonical tile order, not by seat", () => {
  // 6-3 and 5-4 are both 9 pips; 6-3 is earlier in canonical order, so its
  // holder starts — whichever seat that is.
  const first = chooseStartingSeat({ player1: ["6-3"], player2: ["5-4"] });
  assert.deepEqual(first, {
    seat: SEATS[0],
    tile: "6-3",
    rule: STARTING_RULES.HIGHEST_TOTAL,
  });

  const swapped = chooseStartingSeat({ player1: ["5-4"], player2: ["6-3"] });
  assert.deepEqual(swapped, {
    seat: SEATS[1],
    tile: "6-3",
    rule: STARTING_RULES.HIGHEST_TOTAL,
  });
});

test("the starting choice is a pure function of the deal", () => {
  const hands = { player1: ["6-1", "2-2"], player2: ["5-5", "3-0"] };
  assert.deepEqual(chooseStartingSeat(hands), chooseStartingSeat(hands));

  // The choice is read off the DEALT hands, and the opening placement is applied
  // afterwards — so `startingSeat`/`startingTile` stay the deal's own verdict
  // even though the winning tile has already left its holder's hand.
  const deal = dealTiles(seeded(11));
  const choice = chooseStartingSeat(deal.hands);
  const state = createInitialState(deal);
  assert.equal(state.startingSeat, choice.seat);
  assert.equal(state.startingTile, choice.tile);
  assert.equal(state.hands[choice.seat].includes(choice.tile), false);
  assert.equal(
    state.turn,
    choice.rule === STARTING_RULES.HIGHEST_DOUBLE ? otherSeat(choice.seat) : choice.seat,
    "a placed double hands the turn over; an empty chain leaves it with the opener",
  );

  assert.throws(
    () => chooseStartingSeat({ player1: [], player2: [] }),
    (error) => isDominoesRuleError(error) && error.code === REJECTION.INVALID_DEAL,
  );
});

/* -------------------------------------------------------------------------- *
 * The chain
 * -------------------------------------------------------------------------- */

test("the opening tile sets both open ends", () => {
  const state = applyAction(
    position({ p1: ["6-3", "1-1"], p2: ["0-0"] }),
    SEATS[0],
    { type: ACTION_TYPES.PLAY, tile: "6-3" },
  );
  assert.deepEqual(state.chain, [
    { id: "6-3", end: CHAIN_ENDS[0], left: 6, right: 3, isDouble: false, seat: SEATS[0] },
  ]);
  assert.deepEqual(state.openEnds, { left: 6, right: 3 });
  assert.equal(state.turn, SEATS[1]);
  assert.equal(state.ply, 1);
  assert.ok(isChainConsistent(state.chain));
});

test("any tile may open the chain, without naming an end", () => {
  const state = position({ p1: ["4-0", "1-1"], p2: ["0-0"], pile: [] });
  assert.deepEqual(legalPlays(state, SEATS[0]), [
    { type: ACTION_TYPES.PLAY, tile: "4-0", end: CHAIN_ENDS[0] },
    { type: ACTION_TYPES.PLAY, tile: "1-1", end: CHAIN_ENDS[0] },
  ]);
  // Naming an end is harmless while the chain is empty, and the engine records
  // the opening as "left".
  const opened = applyAction(state, SEATS[0], {
    type: ACTION_TYPES.PLAY,
    tile: "4-0",
    end: CHAIN_ENDS[1],
  });
  assert.equal(opened.chain[0].end, CHAIN_ENDS[0]);
  assert.deepEqual(opened.openEnds, { left: 4, right: 0 });
});

test("tiles attach at either end with the matching half inward", () => {
  // player1 opens 6-3 → [6|3]
  // Filler tiles keep both hands non-empty through the sequence (a play that
  // empties a hand wins at once, which would end this geometry test early).
  let state = applyAction(
    position({
      p1: ["6-3", "6-4", "4-0", "0-0"],
      p2: ["5-3", "5-5", "1-1"],
    }),
    SEATS[0],
    {
      type: ACTION_TYPES.PLAY,
      tile: "6-3",
    },
  );

  // player2 attaches 5-3 on the RIGHT: the 3 touches, so 5 becomes the new
  // right end.
  state = applyAction(state, SEATS[1], {
    type: ACTION_TYPES.PLAY,
    tile: "5-3",
    end: CHAIN_ENDS[1],
  });
  assert.deepEqual(
    state.chain.map((tile) => [tile.left, tile.right]),
    [[6, 3], [3, 5]],
  );
  assert.deepEqual(state.openEnds, { left: 6, right: 5 });

  // player1 attaches 6-4 on the LEFT: the 6 touches, so the tile reads 4|6.
  state = applyAction(state, SEATS[0], {
    type: ACTION_TYPES.PLAY,
    tile: "6-4",
    end: CHAIN_ENDS[0],
  });
  assert.deepEqual(
    state.chain.map((tile) => [tile.left, tile.right]),
    [[4, 6], [6, 3], [3, 5]],
  );
  assert.deepEqual(state.openEnds, { left: 4, right: 5 });
  assert.ok(isChainConsistent(state.chain));

  // A double goes on the right and exposes its single value at both ends.
  state = applyAction(state, SEATS[1], {
    type: ACTION_TYPES.PLAY,
    tile: "5-5",
    end: CHAIN_ENDS[1],
  });
  const double = state.chain[state.chain.length - 1];
  assert.deepEqual(double, {
    id: "5-5",
    end: CHAIN_ENDS[1],
    left: 5,
    right: 5,
    isDouble: true,
    seat: SEATS[1],
  });
  assert.deepEqual(state.openEnds, { left: 4, right: 5 });

  // And 4-0 closes the left side: 4 touches, 0 becomes the new left end.
  state = applyAction(state, SEATS[0], {
    type: ACTION_TYPES.PLAY,
    tile: "4-0",
    end: CHAIN_ENDS[0],
  });
  assert.deepEqual(
    state.chain.map((tile) => [tile.left, tile.right]),
    [[0, 4], [4, 6], [6, 3], [3, 5], [5, 5]],
  );
  assert.deepEqual(state.openEnds, { left: 0, right: 5 });
  assert.ok(isChainConsistent(state.chain));
});

test("a tile matching both ends is a real choice: the end decides the orientation", () => {
  // Chain is 6-5: ends are 6 and 5. The same 6-5 tile fits either side.
  const base = afterOpening({ opening: "6-5", p1: ["6-5"], p2: ["0-0"], turn: SEATS[0] });
  assert.deepEqual(base.openEnds, { left: 6, right: 5 });

  const plays = legalPlays(base, SEATS[0]);
  assert.deepEqual(
    plays.map((action) => action.end),
    [CHAIN_ENDS[0], CHAIN_ENDS[1]],
  );

  const onLeft = applyAction(base, SEATS[0], {
    type: ACTION_TYPES.PLAY,
    tile: "6-5",
    end: CHAIN_ENDS[0],
  });
  assert.deepEqual(onLeft.openEnds, { left: 5, right: 5 });

  const onRight = applyAction(base, SEATS[0], {
    type: ACTION_TYPES.PLAY,
    tile: "6-5",
    end: CHAIN_ENDS[1],
  });
  assert.deepEqual(onRight.openEnds, { left: 6, right: 6 });

  // Both are consistent, and both consumed the tile.
  assert.ok(isChainConsistent(onLeft.chain));
  assert.ok(isChainConsistent(onRight.chain));
  assert.deepEqual(onLeft.hands.player1, []);
  assert.deepEqual(onRight.hands.player1, []);
});

test("a tile that matches nothing is refused, and a titled end does not help", () => {
  const state = afterOpening({
    opening: "6-3",
    p1: ["4-4", "6-4"],
    p2: ["0-0"],
    turn: SEATS[0],
  });
  const noMatch = rejectionFor(state, SEATS[0], {
    type: ACTION_TYPES.PLAY,
    tile: "4-4",
    end: CHAIN_ENDS[0],
  });
  assert.equal(noMatch, REJECTION.TILE_MISMATCH);

  // 6-4 matches the LEFT end (6) but not the right one (3).
  assert.equal(
    rejectionFor(state, SEATS[0], {
      type: ACTION_TYPES.PLAY,
      tile: "6-4",
      end: CHAIN_ENDS[1],
    }),
    REJECTION.TILE_MISMATCH,
  );
  assert.equal(
    validateAction(state, SEATS[0], {
      type: ACTION_TYPES.PLAY,
      tile: "6-4",
      end: CHAIN_ENDS[0],
    }).ok,
    true,
  );
});

test("a chain play must name an end, and a real one", () => {
  const state = afterOpening({ opening: "6-3", p1: ["6-4"], p2: ["0-0"], turn: SEATS[0] });
  assert.equal(
    rejectionFor(state, SEATS[0], { type: ACTION_TYPES.PLAY, tile: "6-4" }),
    REJECTION.INVALID_END,
  );
  assert.equal(
    rejectionFor(state, SEATS[0], {
      type: ACTION_TYPES.PLAY,
      tile: "6-4",
      end: "middle",
    }),
    REJECTION.INVALID_END,
  );
});

test("isChainConsistent catches a hand-built chain that does not join", () => {
  const tile = (left, right, seat = SEATS[0], end = CHAIN_ENDS[0]) => ({
    id: left <= right ? `${right}-${left}` : `${left}-${right}`,
    end,
    left,
    right,
    isDouble: left === right,
    seat,
  });
  assert.equal(isChainConsistent([tile(6, 3), tile(3, 5, SEATS[1], CHAIN_ENDS[1])]), true);
  assert.equal(isChainConsistent([tile(6, 3), tile(4, 5, SEATS[1], CHAIN_ENDS[1])]), false);
  // A tile whose recorded halves are not its own values is corrupt.
  const corrupt = { ...tile(6, 3), left: 1 };
  assert.equal(isChainConsistent([corrupt]), false);
  // A mislabelled double is corrupt too.
  assert.equal(isChainConsistent([{ ...tile(6, 3), isDouble: true }]), false);
  assert.equal(isChainConsistent([]), true);
});

/* -------------------------------------------------------------------------- *
 * Drawing
 * -------------------------------------------------------------------------- */

test("with nothing playable, a draw takes exactly one tile and keeps the turn", () => {
  const state = afterOpening({
    opening: "6-3",
    p1: ["0-0", "1-1"],
    p2: ["2-2"],
    pile: ["4-4", "5-1"],
    turn: SEATS[0],
  });
  assert.equal(hasLegalPlay(state, SEATS[0]), false);
  assert.deepEqual(legalActions(state), [{ type: ACTION_TYPES.DRAW }]);
  assert.deepEqual(legalDraw(state), { type: ACTION_TYPES.DRAW });

  const drawn = applyAction(state, SEATS[0], { type: ACTION_TYPES.DRAW });
  assert.deepEqual(drawn.hands.player1, ["0-0", "1-1", "4-4"]);
  assert.deepEqual(drawn.drawPile, ["5-1"]);
  assert.equal(drawn.turn, SEATS[0], "drawing does not pass the turn");
  assert.equal(drawn.ply, state.ply + 1);
  assert.equal(drawn.lastAction.action.type, ACTION_TYPES.DRAW);

  // Still stuck (4-4 matches neither 6 nor 3) → draw again.
  assert.deepEqual(legalActions(drawn), [{ type: ACTION_TYPES.DRAW }]);
  const twice = applyAction(drawn, SEATS[0], { type: ACTION_TYPES.DRAW });
  assert.deepEqual(twice.hands.player1, ["0-0", "1-1", "4-4", "5-1"]);
  assert.deepEqual(twice.drawPile, []);
  assert.equal(twice.turn, SEATS[0]);
  assert.equal(twice.ply, state.ply + 2);
});

test("a drawn tile that fits may be played at once", () => {
  const state = afterOpening({
    opening: "6-3",
    p1: ["0-0"],
    p2: ["2-2"],
    pile: ["6-6", "4-4"],
    turn: SEATS[0],
  });
  const drawn = applyAction(state, SEATS[0], { type: ACTION_TYPES.DRAW });
  assert.deepEqual(drawn.hands.player1, ["0-0", "6-6"]);
  assert.deepEqual(legalPlays(drawn, SEATS[0]), [
    { type: ACTION_TYPES.PLAY, tile: "6-6", end: CHAIN_ENDS[0] },
  ]);
  // A playable tile can no longer be skipped.
  assert.equal(
    rejectionFor(drawn, SEATS[0], { type: ACTION_TYPES.DRAW }),
    REJECTION.MUST_PLAY_TILE,
  );
  const played = applyAction(drawn, SEATS[0], {
    type: ACTION_TYPES.PLAY,
    tile: "6-6",
    end: CHAIN_ENDS[0],
  });
  assert.deepEqual(played.openEnds, { left: 6, right: 3 });
  assert.deepEqual(played.hands.player1, ["0-0"]);
});

test("an empty pile forbids drawing", () => {
  const state = afterOpening({ opening: "6-3", p1: ["0-0"], p2: ["2-2"], pile: [], turn: SEATS[0] });
  assert.equal(rejectionFor(state, SEATS[0], { type: ACTION_TYPES.DRAW }), REJECTION.DRAW_PILE_EMPTY);
  assert.equal(legalDraw(state), null);
});

test("a playable tile blocks drawing AND passing", () => {
  const withPile = afterOpening({
    opening: "6-3",
    p1: ["6-6"],
    p2: ["2-2"],
    pile: ["0-0"],
    turn: SEATS[0],
  });
  assert.equal(rejectionFor(withPile, SEATS[0], { type: ACTION_TYPES.DRAW }), REJECTION.MUST_PLAY_TILE);
  assert.equal(rejectionFor(withPile, SEATS[0], { type: ACTION_TYPES.PASS }), REJECTION.MUST_PLAY_TILE);

  const withoutPile = afterOpening({
    opening: "6-3",
    p1: ["6-6"],
    p2: ["2-2"],
    pile: [],
    turn: SEATS[0],
  });
  assert.equal(
    rejectionFor(withoutPile, SEATS[0], { type: ACTION_TYPES.PASS }),
    REJECTION.MUST_PLAY_TILE,
  );
});

/* -------------------------------------------------------------------------- *
 * Passing
 * -------------------------------------------------------------------------- */

test("with an empty pile a stuck seat passes, and the turn moves on", () => {
  const state = afterOpening({
    opening: "6-3",
    p1: ["0-0"],
    p2: ["6-6"],
    pile: [],
    turn: SEATS[0],
  });
  assert.equal(hasLegalPlay(state, SEATS[0]), false);
  assert.deepEqual(legalPass(state), { type: ACTION_TYPES.PASS });
  assert.deepEqual(legalActions(state), [{ type: ACTION_TYPES.PASS }]);

  const passed = applyAction(state, SEATS[0], { type: ACTION_TYPES.PASS });
  assert.equal(passed.turn, SEATS[1]);
  assert.equal(passed.ply, state.ply + 1);
  assert.equal(passed.status, MATCH_STATUS.PLAYING, "the opponent can still play");
  assert.deepEqual(legalPlays(passed, SEATS[1]), [
    { type: ACTION_TYPES.PLAY, tile: "6-6", end: CHAIN_ENDS[0] },
  ]);
});

test("a pass is refused while the pile still holds tiles", () => {
  const state = afterOpening({
    opening: "6-3",
    p1: ["0-0"],
    p2: ["2-2"],
    pile: ["1-1"],
    turn: SEATS[0],
  });
  assert.equal(rejectionFor(state, SEATS[0], { type: ACTION_TYPES.PASS }), REJECTION.DRAW_PILE_NOT_EMPTY);
  assert.equal(legalPass(state), null);
});

/* -------------------------------------------------------------------------- *
 * Blockage
 * -------------------------------------------------------------------------- */

test("both seats stuck with an empty pile: both score the other's pips", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["4-4"],
    p2: ["1-0"],
    pile: [],
    turn: SEATS[0],
  });
  assert.equal(isBlocked(state), true);
  assert.equal(pipsInHand(state.hands.player1), 8);
  assert.equal(pipsInHand(state.hands.player2), 1);

  const finished = applyAction(state, SEATS[0], { type: ACTION_TYPES.PASS });
  assert.equal(finished.status, MATCH_STATUS.FINISHED);
  assert.equal(finished.winner, SEATS[1]);
  assert.equal(finished.outcome.reason, END_REASONS.BLOCKED_PIPS);
  assert.deepEqual(finished.outcome.pips, { player1: 8, player2: 1 });
  // The NEW rule: player2 scores player1's 8 pips, player1 scores player2's 1.
  // Both seats are awarded points — there is no "only the lighter hand scores".
  assert.deepEqual(finished.outcome.points, { player1: 1, player2: 8 });
  assert.deepEqual(legalActions(finished), []);
  assert.equal(isMatchFinished(finished), true);
});

test("blocked the other way round: the first seat can win on pips", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["1-0"],
    p2: ["4-4"],
    pile: [],
    turn: SEATS[0],
  });
  const finished = applyAction(state, SEATS[0], { type: ACTION_TYPES.PASS });
  assert.equal(finished.winner, SEATS[0]);
  assert.deepEqual(finished.outcome.pips, { player1: 1, player2: 8 });
  assert.deepEqual(finished.outcome.points, { player1: 8, player2: 1 });
});

test("equal pips on a blockage is a draw", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["2-2"],
    p2: ["3-1"],
    pile: [],
    turn: SEATS[0],
  });
  assert.equal(pipsInHand(state.hands.player1), pipsInHand(state.hands.player2));
  const finished = applyAction(state, SEATS[0], { type: ACTION_TYPES.PASS });
  assert.equal(finished.status, MATCH_STATUS.FINISHED);
  assert.equal(finished.winner, null);
  assert.equal(finished.outcome.reason, END_REASONS.BLOCKED_PIPS);
  assert.deepEqual(finished.outcome.pips, { player1: 4, player2: 4 });
  // Level hands score level points in BOTH directions: neither seat is penalised
  // for the tie, and the round has no winner because the points are equal.
  assert.deepEqual(finished.outcome.points, { player1: 4, player2: 4 });
});

test("a pile with a tile left is not a blockage", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["4-4"],
    p2: ["1-0"],
    pile: ["0-0"],
    turn: SEATS[0],
  });
  assert.equal(isBlocked(state), false);
  assert.deepEqual(legalActions(state), [{ type: ACTION_TYPES.DRAW }]);
});

test("one seat able to play keeps the round alive", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["4-4"],
    p2: ["6-0"],
    pile: [],
    turn: SEATS[0],
  });
  assert.equal(isBlocked(state), false);
  const passed = applyAction(state, SEATS[0], { type: ACTION_TYPES.PASS });
  assert.equal(passed.status, MATCH_STATUS.PLAYING);
  assert.equal(passed.turn, SEATS[1]);
  assert.equal(legalPlays(passed, SEATS[1]).length, 1);
});

test("the draw that empties the pile can end the round on its own", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["0-0"],
    p2: ["1-1"],
    pile: ["4-4"],
    turn: SEATS[0],
  });
  const drawn = applyAction(state, SEATS[0], { type: ACTION_TYPES.DRAW });
  assert.deepEqual(drawn.drawPile, []);
  assert.equal(drawn.status, MATCH_STATUS.FINISHED, "no ceremonial pass is required");
  assert.equal(drawn.outcome.reason, END_REASONS.BLOCKED_PIPS);
  assert.equal(drawn.winner, SEATS[1]);
  assert.deepEqual(drawn.outcome.pips, { player1: 8, player2: 2 });
  assert.deepEqual(drawn.outcome.points, { player1: 2, player2: 8 });
  assert.equal(drawn.lastAction.action.type, ACTION_TYPES.DRAW);
});

test("the draw that empties the pile does not end the round if the drawn tile plays", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["0-0"],
    p2: ["1-1"],
    pile: ["6-6"],
    turn: SEATS[0],
  });
  const drawn = applyAction(state, SEATS[0], { type: ACTION_TYPES.DRAW });
  assert.equal(drawn.status, MATCH_STATUS.PLAYING);
  assert.equal(drawn.turn, SEATS[0]);
  assert.deepEqual(legalPlays(drawn, SEATS[0]), [
    { type: ACTION_TYPES.PLAY, tile: "6-6", end: CHAIN_ENDS[0] },
  ]);
});

/* -------------------------------------------------------------------------- *
 * Victory
 * -------------------------------------------------------------------------- */

test("emptying a hand wins immediately, before any pip count", () => {
  const state = position({ p1: ["6-3"], p2: ["1-1"], pile: [] });
  const finished = applyAction(state, SEATS[0], {
    type: ACTION_TYPES.PLAY,
    tile: "6-3",
  });
  assert.equal(finished.status, MATCH_STATUS.FINISHED);
  assert.equal(finished.winner, SEATS[0]);
  assert.equal(finished.outcome.reason, END_REASONS.EMPTIED_HAND);
  assert.deepEqual(finished.outcome.pips, { player1: 0, player2: 2 });
  // The emptied seat scores the opponent's remaining pips; the opponent scores 0.
  assert.deepEqual(finished.outcome.points, { player1: 2, player2: 0 });
  assert.deepEqual(finished.hands.player1, []);
  assert.deepEqual(legalActions(finished), []);
});

test("every tile of the doubling set is a legal opening", () => {
  for (const tile of TILE_IDS.filter(isDoubleTile)) {
    const state = position({ p1: [tile], p2: [], pile: [] });
    const opened = applyAction(state, SEATS[0], { type: ACTION_TYPES.PLAY, tile });
    assert.deepEqual(opened.openEnds, {
      left: tileValues(tile)[0],
      right: tileValues(tile)[0],
    });
  }
});

/* -------------------------------------------------------------------------- *
 * Rejections and immutability
 * -------------------------------------------------------------------------- */

test("every rejection code is produced, and a rejected action changes nothing", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["6-3", "0-0"],
    p2: ["1-1"],
    pile: ["2-2"],
    turn: SEATS[0],
  });

  const cases = [
    {
      name: "malformed action",
      seat: SEATS[0],
      action: null,
      code: REJECTION.INVALID_ACTION,
    },
    {
      name: "string action",
      seat: SEATS[0],
      action: "play",
      code: REJECTION.INVALID_ACTION,
    },
    {
      name: "unknown action type",
      seat: SEATS[0],
      action: { type: "cheat" },
      code: REJECTION.INVALID_ACTION,
    },
    {
      name: "unknown seat",
      seat: "player3",
      action: { type: ACTION_TYPES.PLAY, tile: "6-3", end: CHAIN_ENDS[0] },
      code: REJECTION.INVALID_SEAT,
    },
    {
      name: "not your turn",
      seat: SEATS[1],
      action: { type: ACTION_TYPES.PLAY, tile: "1-1", end: CHAIN_ENDS[1] },
      code: REJECTION.NOT_YOUR_TURN,
    },
    {
      name: "tile off the set",
      seat: SEATS[0],
      action: { type: ACTION_TYPES.PLAY, tile: "7-1", end: CHAIN_ENDS[0] },
      code: REJECTION.INVALID_TILE,
    },
    {
      name: "reversed tile id",
      seat: SEATS[0],
      action: { type: ACTION_TYPES.PLAY, tile: "3-6", end: CHAIN_ENDS[0] },
      code: REJECTION.INVALID_TILE,
    },
    {
      name: "tile in the other hand",
      seat: SEATS[0],
      action: { type: ACTION_TYPES.PLAY, tile: "1-1", end: CHAIN_ENDS[1] },
      code: REJECTION.TILE_NOT_IN_HAND,
    },
    {
      name: "no end named",
      seat: SEATS[0],
      action: { type: ACTION_TYPES.PLAY, tile: "6-3" },
      code: REJECTION.INVALID_END,
    },
    {
      name: "bogus end",
      seat: SEATS[0],
      action: { type: ACTION_TYPES.PLAY, tile: "6-3", end: "middle" },
      code: REJECTION.INVALID_END,
    },
    {
      name: "wrong end for the tile",
      seat: SEATS[0],
      action: { type: ACTION_TYPES.PLAY, tile: "6-3", end: CHAIN_ENDS[1] },
      code: REJECTION.TILE_MISMATCH,
    },
    {
      name: "draw while holding a play",
      seat: SEATS[0],
      action: { type: ACTION_TYPES.DRAW },
      code: REJECTION.MUST_PLAY_TILE,
    },
    {
      name: "pass while holding a play",
      seat: SEATS[0],
      action: { type: ACTION_TYPES.PASS },
      code: REJECTION.MUST_PLAY_TILE,
    },
  ];

  for (const entry of cases) {
    const before = snapshot(state);
    assert.equal(
      rejectionFor(state, entry.seat, entry.action),
      entry.code,
      `${entry.name}: expected ${entry.code}`,
    );
    assert.equal(snapshot(state), before, `${entry.name}: the state must not change`);
  }
});

test("a finished match accepts nothing at all", () => {
  const finished = applyAction(position({ p1: ["6-3"], p2: ["1-1"], pile: [] }), SEATS[0], {
    type: ACTION_TYPES.PLAY,
    tile: "6-3",
  });
  const before = snapshot(finished);
  for (const action of [
    { type: ACTION_TYPES.PLAY, tile: "1-1", end: CHAIN_ENDS[0] },
    { type: ACTION_TYPES.DRAW },
    { type: ACTION_TYPES.PASS },
  ]) {
    assert.equal(
      rejectionFor(finished, SEATS[1], action),
      REJECTION.MATCH_NOT_PLAYING,
    );
  }
  assert.throws(
    () => applyAction(finished, SEATS[1], { type: ACTION_TYPES.DRAW }),
    (error) => isDominoesRuleError(error) && error.code === REJECTION.MATCH_NOT_PLAYING,
  );
  assert.equal(snapshot(finished), before);
});

test("an accepted action never mutates its input and returns frozen data", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["6-3", "4-4"],
    p2: ["1-1"],
    pile: ["2-2"],
    turn: SEATS[0],
  });
  const before = snapshot(state);
  const next = applyAction(state, SEATS[0], {
    type: ACTION_TYPES.PLAY,
    tile: "6-3",
    end: CHAIN_ENDS[0],
  });

  assert.equal(snapshot(state), before, "the previous state is untouched");
  assert.notEqual(next, state);
  assert.ok(Object.isFrozen(next));
  assert.ok(Object.isFrozen(next.chain));
  assert.ok(Object.isFrozen(next.chain[0]));
  assert.ok(Object.isFrozen(next.hands.player1));
  assert.ok(Object.isFrozen(next.hands));
  assert.ok(Object.isFrozen(next.openEnds));
  assert.ok(Object.isFrozen(next.drawPile));
  assert.ok(Object.isFrozen(next.lastAction));
  // The old state still reads exactly as it did.
  assert.deepEqual(state.hands.player1, ["6-3", "4-4"]);
  assert.deepEqual(state.chain, [{ id: "6-5", end: "left", left: 6, right: 5, isDouble: false, seat: SEATS[0] }]);

  // `cloneState` is an independent copy, not an alias.
  const clone = cloneState(next);
  assert.deepEqual(clone, next);
  assert.notEqual(clone.hands.player1, next.hands.player1);
});

test("tryApplyAction reports a rejection as null and an acceptance as the next state", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["6-3"],
    p2: ["1-1"],
    pile: [],
    turn: SEATS[0],
  });
  assert.equal(tryApplyAction(state, SEATS[0], { type: ACTION_TYPES.PLAY, tile: "0-0" }), null);
  assert.notEqual(
    tryApplyAction(state, SEATS[0], {
      type: ACTION_TYPES.PLAY,
      tile: "6-3",
      end: CHAIN_ENDS[0],
    }),
    null,
  );
});

test("DominoesRuleError carries its code, seat and action", () => {
  const state = position({ p1: ["0-0"], p2: ["1-1"], pile: [] });
  try {
    applyAction(state, SEATS[0], { type: ACTION_TYPES.PLAY, tile: "5-5" });
    assert.fail("expected a rejection");
  } catch (error) {
    assert.ok(error instanceof DominoesRuleError);
    assert.equal(error.name, "DominoesRuleError");
    assert.equal(error.code, REJECTION.TILE_NOT_IN_HAND);
    assert.equal(error.seat, SEATS[0]);
    assert.equal(error.action.tile, "5-5");
    assert.ok(isDominoesRuleError(error));
  }
  assert.equal(isDominoesRuleError(new Error("nope")), false);
});

test("otherSeat flips and is its own inverse", () => {
  assert.equal(otherSeat(SEATS[0]), SEATS[1]);
  assert.equal(otherSeat(SEATS[1]), SEATS[0]);
  assert.equal(otherSeat(otherSeat(SEATS[0])), SEATS[0]);
});

test("a state survives a JSON round trip and keeps playing identically", () => {
  // The state is meant for a `jsonb` column, so persistence must be lossless.
  const dealt = dealMatch(seeded(17));
  const opener = legalPlays(dealt, dealt.turn)[0];
  const state = applyAction(dealt, dealt.turn, opener);

  const parsed = JSON.parse(JSON.stringify(state));
  assert.deepEqual(parsed, state);

  const action = legalActions(state)[0];
  assert.ok(action, "the round must still have an action after one play");
  assert.deepEqual(
    applyAction(parsed, parsed.turn, action),
    applyAction(state, state.turn, action),
  );
});

/* -------------------------------------------------------------------------- *
 * Deterministic self-play: the invariants a real game cannot break
 * -------------------------------------------------------------------------- */

test("randomised self-play preserves every invariant, for 40 seeds", () => {
  let emptiedHand = 0;
  let blockedPips = 0;
  let totalActions = 0;

  for (let seed = 1; seed <= 40; seed += 1) {
    const random = seeded(seed);
    let state = dealMatch(random);

    assert.equal(new Set(heldTiles(state)).size, TILE_COUNT);
    assert.deepEqual(state.openEnds, openEndsOf(state.chain));

    let actions = 0;
    while (!isMatchFinished(state)) {
      actions += 1;
      assert.ok(actions < 500, `seed ${seed} did not finish in 500 actions`);

      // A live position always has something to do, and is never blocked.
      const menu = legalActions(state);
      assert.ok(menu.length > 0, `seed ${seed}: a live state must offer an action`);
      assert.equal(isBlocked(state), false, `seed ${seed}: a live state is never blocked`);

      // The menu is exclusive: plays, OR a single draw, OR a single pass.
      const hasPlay = menu.some((action) => action.type === ACTION_TYPES.PLAY);
      if (hasPlay) {
        assert.ok(menu.every((action) => action.type === ACTION_TYPES.PLAY));
        for (const action of menu) {
          assert.ok(action.end === CHAIN_ENDS[0] || action.end === CHAIN_ENDS[1]);
        }
      } else {
        assert.equal(menu.length, 1);
        assert.notEqual(menu[0].type, ACTION_TYPES.PLAY);
      }

      // Every generated action is accepted by the validator, and nothing else.
      for (const action of menu) {
        assert.equal(
          validateAction(state, state.turn, action).ok,
          true,
          `seed ${seed}: the engine refused its own ${action.type}`,
        );
      }

      const action = menu[Math.floor(random() * menu.length)];
      const next = applyAction(state, state.turn, action);

      // Ply advances by exactly one per accepted action.
      assert.equal(next.ply, state.ply + 1, `seed ${seed}: ply must advance by one`);
      // No tile is ever duplicated, lost or invented.
      const held = heldTiles(next);
      assert.equal(held.length, TILE_COUNT, `seed ${seed}: tile count drifted`);
      assert.equal(new Set(held).size, TILE_COUNT, `seed ${seed}: a tile was duplicated`);
      // The chain always joins, and the stored open ends match the derived ones.
      assert.ok(isChainConsistent(next.chain), `seed ${seed}: chain does not join`);
      assert.deepEqual(next.openEnds, openEndsOf(next.chain));
      if (next.chain.length > 0) {
        assert.equal(next.openEnds.left, next.chain[0].left);
        assert.equal(next.openEnds.right, next.chain[next.chain.length - 1].right);
      }
      // A draw keeps the turn; a play or a pass hands it over.
      if (action.type === ACTION_TYPES.DRAW) {
        assert.equal(next.turn, state.turn);
      } else {
        assert.equal(next.turn, otherSeat(state.turn));
      }
      state = next;
    }

    totalActions += actions;

    // Termination is a decided round with a recorded outcome.
    assert.equal(state.status, MATCH_STATUS.FINISHED);
    assert.deepEqual(legalActions(state), []);
    assert.ok(state.outcome, `seed ${seed}: finished without an outcome`);
    assert.deepEqual(state.outcome.pips, {
      player1: pipsInHand(state.hands.player1),
      player2: pipsInHand(state.hands.player2),
    });
    // The round's points are always the swap of the remaining pips — derived by
    // the engine from the hands it owns, never read from anywhere else.
    assert.deepEqual(
      state.outcome.points,
      roundPoints(state.outcome.pips),
      `seed ${seed}: points are not the opponent's pips`,
    );

    if (state.outcome.reason === END_REASONS.EMPTIED_HAND) {
      emptiedHand += 1;
      assert.ok(state.winner, "an emptied hand produces a winner");
      assert.deepEqual(state.hands[state.winner], []);
      assert.equal(state.outcome.pips[state.winner], 0);
      assert.equal(
        state.outcome.points[state.winner],
        state.outcome.pips[otherSeat(state.winner)],
        `seed ${seed}: the emptied hand must score the opponent's pips`,
      );
      assert.equal(
        state.outcome.points[otherSeat(state.winner)],
        0,
        `seed ${seed}: the opponent of an emptied hand must score 0`,
      );
    } else {
      assert.equal(state.outcome.reason, END_REASONS.BLOCKED_PIPS);
      blockedPips += 1;
      const { player1, player2 } = state.outcome.points;
      // A blocked round awards points to BOTH seats: each total is the OTHER
      // seat's remaining pips, never 0-by-default for one of them.
      assert.equal(player1, state.outcome.pips.player2);
      assert.equal(player2, state.outcome.pips.player1);
      assert.ok(player1 >= 0 && player2 >= 0);
      if (player1 === player2) {
        assert.equal(state.winner, null, "equal points draw the round");
        assert.ok(state.hands.player1.length > 0 && state.hands.player2.length > 0);
      } else {
        assert.equal(state.winner, player1 > player2 ? SEATS[0] : SEATS[1]);
      }
    }
  }

  assert.equal(emptiedHand + blockedPips, 40);
  assert.ok(emptiedHand > 0, "some rounds are won by emptying a hand");
  assert.ok(blockedPips > 0, "some rounds are decided on pips");
  assert.ok(totalActions > 40, "a round takes more than one action");
});

/* -------------------------------------------------------------------------- *
 * Round scoring — the 50-point match rules
 *
 * Every seat scores the pips LEFT IN THE OTHER SEAT'S HAND. An emptied hand
 * scores the opponent's pips for the seat that emptied it and 0 for the
 * opponent; a blocked round scores BOTH seats; equal (or empty) hands score
 * equal (or zero) points. `outcome.points` is that record; `state.winner` is the
 * ROUND's winner, never a match victory.
 * -------------------------------------------------------------------------- */

test("a match is won at 50 cumulative points", () => {
  assert.equal(MATCH_TARGET_POINTS, 50);
  // A single round is scored, not aggregated: the engine never sums rounds.
  const state = position({ p1: ["6-5"], p2: ["4-4"], pile: [] });
  const round = applyAction(state, SEATS[0], { type: ACTION_TYPES.PLAY, tile: "6-5" });
  assert.ok(round.outcome.points.player1 < MATCH_TARGET_POINTS);
  assert.equal("score" in round, false, "the engine holds no match-level score");
});

test("roundPoints is the pure scoring rule: each seat gets the other's pips", () => {
  assert.deepEqual(roundPoints({ player1: 0, player2: 13 }), { player1: 13, player2: 0 });
  assert.deepEqual(roundPoints({ player1: 8, player2: 1 }), { player1: 1, player2: 8 });
  assert.deepEqual(roundPoints({ player1: 4, player2: 4 }), { player1: 4, player2: 4 });
  assert.deepEqual(roundPoints({ player1: 0, player2: 0 }), { player1: 0, player2: 0 });
});

test("player 1 empties their hand: scores everything left in player 2's hand", () => {
  const state = position({ p1: ["6-5"], p2: ["4-4", "3-2"], pile: [] });
  assert.equal(pipsInHand(state.hands.player2), 13);
  const finished = applyAction(state, SEATS[0], { type: ACTION_TYPES.PLAY, tile: "6-5" });

  assert.equal(finished.status, MATCH_STATUS.FINISHED);
  assert.equal(finished.outcome.reason, END_REASONS.EMPTIED_HAND);
  assert.equal(finished.winner, SEATS[0]);
  assert.deepEqual(finished.outcome.pips, { player1: 0, player2: 13 });
  assert.deepEqual(finished.outcome.points, { player1: 13, player2: 0 });
});

test("player 2 empties their hand: scores everything left in player 1's hand", () => {
  const state = position({
    p1: ["2-1", "3-0"],
    p2: ["6-0"],
    pile: [],
    turn: SEATS[1],
  });
  assert.equal(pipsInHand(state.hands.player1), 6);
  const finished = applyAction(state, SEATS[1], { type: ACTION_TYPES.PLAY, tile: "6-0" });

  assert.equal(finished.outcome.reason, END_REASONS.EMPTIED_HAND);
  assert.equal(finished.winner, SEATS[1]);
  assert.deepEqual(finished.outcome.pips, { player1: 6, player2: 0 });
  assert.deepEqual(finished.outcome.points, { player1: 0, player2: 6 });
});

test("an emptied hand's score does not depend on who was on turn or on plys", () => {
  // Same two hands, emptied by seat 2 instead: the points follow the pips, not
  // the seat order or the history of the round.
  const state = position({ p1: ["3-3"], p2: ["6-4"], pile: [] });
  const p2First = applyAction(state, SEATS[0], { type: ACTION_TYPES.PLAY, tile: "3-3" });
  assert.deepEqual(p2First.outcome.points, { player1: 10, player2: 0 });
});

test("blocked with different pip totals: BOTH seats score the other's pips", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["4-4", "0-0"],
    p2: ["3-2", "1-0"],
    pile: [],
    turn: SEATS[0],
  });
  assert.equal(isBlocked(state), true);
  const finished = applyAction(state, SEATS[0], { type: ACTION_TYPES.PASS });

  assert.equal(finished.outcome.reason, END_REASONS.BLOCKED_PIPS);
  assert.deepEqual(finished.outcome.pips, { player1: 8, player2: 6 });
  // The lighter hand still GIVES AWAY fewer points, but the heavier hand is not
  // left with 0: it scores the lighter hand's pips.
  assert.deepEqual(finished.outcome.points, { player1: 6, player2: 8 });
  assert.equal(finished.winner, SEATS[1]);
});

test("blocked with equal pip totals: both seats score, and the round is level", () => {
  const state = afterOpening({
    opening: "6-5",
    p1: ["4-4"],
    p2: ["3-3", "1-1"],
    pile: [],
    turn: SEATS[0],
  });
  assert.equal(pipsInHand(state.hands.player1), 8);
  assert.equal(pipsInHand(state.hands.player2), 8);
  const finished = applyAction(state, SEATS[0], { type: ACTION_TYPES.PASS });

  assert.deepEqual(finished.outcome.points, { player1: 8, player2: 8 });
  assert.equal(finished.winner, null);
  assert.deepEqual(legalActions(finished), []);
});

test("blocked with zero remaining pips on both sides: 0 points each", () => {
  // Defensive: a real round cannot reach this, because an empty hand ends the
  // round as `emptied-hand` before any blockage check. The rule must still be
  // total — two empty hands score 0 / 0 and name no winner.
  const state = position({ p1: [], p2: [], pile: [], turn: SEATS[0] });
  assert.equal(isBlocked(state), true);
  const finished = applyAction(state, SEATS[0], { type: ACTION_TYPES.PASS });

  assert.equal(finished.outcome.reason, END_REASONS.BLOCKED_PIPS);
  assert.deepEqual(finished.outcome.pips, { player1: 0, player2: 0 });
  assert.deepEqual(finished.outcome.points, { player1: 0, player2: 0 });
  assert.equal(finished.winner, null);
});

test("scoring is derived from the hands, never read from a supplied result", () => {
  // A client-supplied score/outcome on the state must be ignored: the engine
  // recomputes both from the hands it owns when the round closes.
  const state = {
    ...position({ p1: ["6-5"], p2: ["4-4", "3-2"], pile: [] }),
    outcome: {
      winner: SEATS[1],
      reason: END_REASONS.EMPTIED_HAND,
      pips: { player1: 999, player2: 999 },
      points: { player1: 999, player2: 999 },
    },
    score: { player1: 49, player2: 49 },
  };
  const finished = applyAction(state, SEATS[0], { type: ACTION_TYPES.PLAY, tile: "6-5" });

  assert.equal(finished.winner, SEATS[0]);
  assert.deepEqual(finished.outcome.pips, { player1: 0, player2: 13 });
  assert.deepEqual(finished.outcome.points, { player1: 13, player2: 0 });
});

test("the recorded points are frozen and copied, not aliased", () => {
  const state = position({ p1: ["6-5"], p2: ["4-4", "3-2"], pile: [] });
  const finished = applyAction(state, SEATS[0], { type: ACTION_TYPES.PLAY, tile: "6-5" });
  assert.equal(Object.isFrozen(finished.outcome.points), true);
  assert.notEqual(finished.outcome.points, finished.outcome.pips);
  const copy = cloneState(finished);
  assert.deepEqual(copy.outcome.points, finished.outcome.points);
  assert.notEqual(copy.outcome.points, finished.outcome.points);
});
