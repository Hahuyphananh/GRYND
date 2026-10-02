/**
 * solitaire-duel-rules.test.mjs
 *
 * THE AUTHORITATIVE ENGINE, exercised directly (no database, no clock, no I/O).
 *
 * What these tests are really asserting:
 *
 *   * a client may only say WHICH CARDS IT MEANT AND WHERE — a progress figure,
 *     a completion flag or a winner smuggled into a move changes nothing
 *   * illegal moves are rejected WITHOUT touching the board
 *   * the engine never mutates the state it is handed, so one seat's board can
 *     never be altered by anything but that seat's own applied move
 *   * progress, completion and the settlement ladder are all derived
 *
 * Run:  npm run test:solitaire-duel
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMove,
  compareProgress,
  foundationCount,
  initialStateFromDeal,
  isComplete,
  isWellFormedState,
  normalizeMove,
  outcomeFor,
  progressOf,
  replayMoves,
  revealedTableauCount,
  resolveRace,
  validateMove,
  viewForState,
} from "../src/lib/solitaire-duel/rules.ts";
import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { DECK_SIZE } from "../src/lib/solitaire-duel/constants.ts";

/**
 * Every card identity reachable anywhere inside a value.
 *
 * Used to prove a payload does NOT contain a card: a leak is any `suit` + `rank`
 * pair buried at any depth, so a string search would not be enough.
 */
function identitiesIn(value) {
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.suit === "string" && typeof node.rank === "number") {
      found.add(`${node.suit}-${node.rank}`);
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child);
  };
  walk(value);
  return found;
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const card = (suit, rank) => ({ suit, rank });
const up = (value) => ({ card: value, faceUp: true });
const down = (value) => ({ card: value, faceUp: false });
const columns = () => [[], [], [], [], [], [], []];
const foundations = () => ({ spades: [], hearts: [], diamonds: [], clubs: [] });

/** A structurally valid board the scenario can fill in. */
function craft({
  tableau = columns(),
  stock = [],
  waste = [],
  piles = foundations(),
  ply = 0,
  peakFoundation = 0,
} = {}) {
  return {
    variant: "klondike-1",
    variantVersion: 1,
    tableau,
    stock,
    waste,
    foundations: piles,
    ply,
    peakFoundation,
    completed: false,
    completedAtMs: null,
  };
}

/** Normalize + apply, asserting the move was accepted. */
function play(state, move) {
  const normalized = normalizeMove(move);
  assert.equal(normalized.ok, true, `move should be well-formed: ${JSON.stringify(move)}`);
  const applied = applyMove({ state, move: normalized.move });
  assert.equal(applied.ok, true, `move should be legal: ${JSON.stringify(move)}`);
  return applied;
}

/** Assert a move is refused, and that the board was NOT touched. */
function refuse(state, move, expectedCode = null) {
  const before = structuredClone(state);
  const normalized = normalizeMove(move);
  if (!normalized.ok) {
    if (expectedCode) assert.equal(normalized.code, expectedCode);
    return normalized;
  }
  const applied = applyMove({ state, move: normalized.move });
  assert.equal(applied.ok, false, `move should be illegal: ${JSON.stringify(move)}`);
  if (expectedCode) assert.equal(applied.code, expectedCode);
  assert.deepEqual(state, before, "a rejected move must not mutate the board");
  return applied;
}

// ── 1. Drawing from the stock ─────────────────────────────────────────────

test("draw: moves the stock's top card to the waste and burns a ply", () => {
  const state = craft({ stock: [card("spades", 5), card("hearts", 9)] });
  const applied = play(state, { kind: "draw" });

  assert.equal(applied.state.stock.length, 1);
  assert.deepEqual(applied.state.waste, [card("hearts", 9)]);
  assert.equal(applied.state.ply, 1);
  assert.deepEqual(applied.revealed, []);
});

test("draw: with an empty stock, recycles the waste (unlimited redeals)", () => {
  const state = craft({ waste: [card("spades", 5), card("hearts", 9)] });
  const applied = play(state, { kind: "draw" });

  // Turning the waste over puts the FIRST-drawn card on top of the new stock.
  assert.deepEqual(applied.state.waste, []);
  assert.equal(applied.state.stock.length, 2);
  assert.deepEqual(applied.state.stock[applied.state.stock.length - 1], card("spades", 5));
});

test("draw: refused when the stock and the waste are both empty", () => {
  refuse(craft(), { kind: "draw" }, "ILLEGAL_MOVE");
});

// ── 2. Waste moves ────────────────────────────────────────────────────────

test("waste→foundation: an Ace opens its foundation", () => {
  const state = craft({ waste: [card("hearts", 1)] });
  const applied = play(state, { kind: "waste-to-foundation", suit: "hearts" });
  assert.deepEqual(applied.state.foundations.hearts, [card("hearts", 1)]);
  assert.equal(applied.state.waste.length, 0);
  assert.equal(applied.state.peakFoundation, 1);
});

test("waste→foundation: refuses the wrong rank and the wrong suit", () => {
  refuse(craft({ waste: [card("hearts", 2)] }), { kind: "waste-to-foundation", suit: "hearts" }, "ILLEGAL_MOVE");
  refuse(craft({ waste: [card("hearts", 1)] }), { kind: "waste-to-foundation", suit: "spades" }, "ILLEGAL_MOVE");
  refuse(craft({ waste: [] }), { kind: "waste-to-foundation", suit: "hearts" }, "CARD_NOT_FOUND");
});

test("waste→tableau: accepts a descending alternating card, on a King for an empty column", () => {
  const tableau = columns();
  tableau[0] = [up(card("hearts", 6))];
  const applied = play(
    craft({ tableau, waste: [card("spades", 5)] }),
    { kind: "waste-to-tableau", toColumn: 0 },
  );
  assert.equal(applied.state.tableau[0].length, 2);
  assert.deepEqual(applied.state.tableau[0][1].card, card("spades", 5));
  assert.equal(applied.state.tableau[0][1].faceUp, true);

  const empty = craft({ waste: [card("diamonds", 13)] });
  const king = play(empty, { kind: "waste-to-tableau", toColumn: 3 });
  assert.equal(king.state.tableau[3].length, 1);

  refuse(craft({ waste: [card("diamonds", 12)] }), { kind: "waste-to-tableau", toColumn: 3 }, "ILLEGAL_MOVE");
});

test("waste→tableau: refuses a same-colour or non-descending placement", () => {
  const tableau = columns();
  tableau[0] = [up(card("spades", 6))];
  refuse(craft({ tableau, waste: [card("spades", 5)] }), { kind: "waste-to-tableau", toColumn: 0 }, "ILLEGAL_MOVE");
  refuse(craft({ tableau, waste: [card("spades", 4)] }), { kind: "waste-to-tableau", toColumn: 0 }, "ILLEGAL_MOVE");
});

// ── 3. Tableau moves ──────────────────────────────────────────────────────

test("tableau→foundation: only the column's TOP card may be lifted", () => {
  const tableau = columns();
  tableau[0] = [up(card("spades", 3)), up(card("spades", 2))];
  const piles = foundations();
  piles.spades = [card("spades", 1)];

  const state = craft({ tableau, piles });
  // 3♠ has a card on top of it, so it cannot be lifted out of the middle.
  refuse(state, { kind: "tableau-to-foundation", fromColumn: 0, card: card("spades", 3), suit: "spades" }, "ILLEGAL_MOVE");

  const applied = play(state, { kind: "tableau-to-foundation", fromColumn: 0, card: card("spades", 2), suit: "spades" });
  assert.deepEqual(applied.state.foundations.spades, [card("spades", 1), card("spades", 2)]);
  assert.equal(applied.state.tableau[0].length, 1);
});

test("tableau→tableau: moves a whole descending alternating run as one unit", () => {
  const tableau = columns();
  tableau[0] = [up(card("clubs", 8)), up(card("hearts", 7)), up(card("spades", 6))];
  // 7♥ is red, so its target must be a BLACK 8.
  tableau[1] = [up(card("spades", 8))];

  const applied = play(
    craft({ tableau }),
    { kind: "tableau-to-tableau", fromColumn: 0, card: card("hearts", 7), toColumn: 1 },
  );

  assert.equal(applied.state.tableau[0].length, 1);
  assert.deepEqual(applied.state.tableau[0].map((p) => p.card), [card("clubs", 8)]);
  assert.deepEqual(applied.state.tableau[1].map((p) => p.card), [
    card("spades", 8),
    card("hearts", 7),
    card("spades", 6),
  ]);
});

test("tableau→tableau: a broken run cannot be addressed", () => {
  const tableau = columns();
  // 7♣ is not a legal continuation of 8♣ (same colour), so 8♣ heads no run.
  tableau[0] = [up(card("clubs", 8)), up(card("clubs", 7))];
  tableau[1] = [up(card("spades", 8))];
  refuse(
    craft({ tableau }),
    { kind: "tableau-to-tableau", fromColumn: 0, card: card("clubs", 8), toColumn: 1 },
    "CARD_NOT_FOUND",
  );
});

test("tableau→tableau: a face-down card cannot be addressed at all", () => {
  const tableau = columns();
  tableau[0] = [down(card("spades", 10)), up(card("hearts", 9))];
  tableau[1] = [up(card("clubs", 10))];
  const result = refuse(
    craft({ tableau }),
    { kind: "tableau-to-tableau", fromColumn: 0, card: card("spades", 10), toColumn: 1 },
    "CARD_NOT_FOUND",
  );
  assert.match(result.error, /face-up run/i);
});

test("flip: exposing a face-down card turns it over, and reports it", () => {
  const tableau = columns();
  tableau[0] = [down(card("spades", 10)), up(card("hearts", 9))];
  // 9♥ needs a BLACK 10, one rank above it.
  tableau[1] = [up(card("clubs", 10))];

  const state = craft({ tableau });
  // `revealedTableau` is `28 - faceDown`, so one hidden card reads as 27 here.
  assert.equal(progressOf(state).revealedTableau, 27);

  const applied = play(
    state,
    { kind: "tableau-to-tableau", fromColumn: 0, card: card("hearts", 9), toColumn: 1 },
  );

  assert.equal(applied.state.tableau[0].length, 1);
  assert.equal(applied.state.tableau[0][0].faceUp, true);
  assert.deepEqual(applied.revealed, [card("spades", 10)]);
  assert.equal(progressOf(applied.state).revealedTableau, 28);
});

test("foundation→tableau: a card may be taken back off a foundation", () => {
  const tableau = columns();
  tableau[0] = [up(card("spades", 3))];
  const piles = foundations();
  piles.hearts = [card("hearts", 1), card("hearts", 2)];
  // 2♥ cannot go onto 3♠; use a legal target instead.
  piles.hearts = [card("hearts", 1), card("hearts", 4)];
  tableau[0] = [up(card("clubs", 5))];

  const applied = play(
    craft({ tableau, piles }),
    { kind: "foundation-to-tableau", suit: "hearts", toColumn: 0 },
  );
  assert.deepEqual(applied.state.foundations.hearts, [card("hearts", 1)]);
  assert.deepEqual(applied.state.tableau[0][1].card, card("hearts", 4));
});

test("fromColumn === toColumn: refused before it can reach the board", () => {
  const tableau = columns();
  tableau[0] = [up(card("spades", 9))];
  const result = refuse(
    craft({ tableau }),
    { kind: "tableau-to-tableau", fromColumn: 0, card: card("spades", 9), toColumn: 0 },
    "ILLEGAL_MOVE",
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /onto itself/i);
});

// ── 4. Shape checking: no coercion, no smuggled state ─────────────────────

test("shape: a move must be an object with a known kind", () => {
  for (const bad of [null, undefined, 42, "draw", [], { kind: "teleport" }, {}]) {
    const normalized = normalizeMove(bad);
    assert.equal(normalized.ok, false, `should reject ${JSON.stringify(bad)}`);
    assert.equal(normalized.code, "BAD_MOVE");
  }
});

test("shape: nothing is coerced — the string \"3\" is not a column", () => {
  for (const bad of ["3", 3.5, -1, 7, null, NaN, true, {}]) {
    const normalized = normalizeMove({ kind: "waste-to-tableau", toColumn: bad });
    assert.equal(normalized.ok, false, `toColumn ${JSON.stringify(bad)} must be rejected`);
    assert.equal(normalized.code, "BAD_MOVE");
  }
  assert.equal(normalizeMove({ kind: "waste-to-tableau", toColumn: 0 }).ok, true);
  assert.equal(normalizeMove({ kind: "waste-to-tableau", toColumn: 6 }).ok, true);
});

test("shape: a card identity is checked, never cast", () => {
  for (const bad of [
    null,
    {},
    { suit: "spades" },
    { rank: 5 },
    { suit: "stars", rank: 5 },
    { suit: "spades", rank: "13" },
    { suit: "spades", rank: 0 },
    { suit: "spades", rank: 14 },
    { suit: "spades", rank: 5.5 },
    [],
  ]) {
    const normalized = normalizeMove({ kind: "tableau-to-foundation", fromColumn: 0, card: bad, suit: "spades" });
    assert.equal(normalized.ok, false, `card ${JSON.stringify(bad)} must be rejected`);
    assert.equal(normalized.code, "BAD_MOVE");
  }
  assert.equal(
    normalizeMove({ kind: "tableau-to-foundation", fromColumn: 0, card: { suit: "hearts", rank: 12 }, suit: "hearts" }).ok,
    true,
  );
});

test("shape: a target suit must be one of the four", () => {
  for (const bad of ["stars", "", 1, null, {}, ["hearts"]]) {
    assert.equal(normalizeMove({ kind: "waste-to-foundation", suit: bad }).ok, false);
  }
  for (const suit of ["spades", "hearts", "diamonds", "clubs"]) {
    assert.equal(normalizeMove({ kind: "waste-to-foundation", suit }).ok, true);
  }
});

test("fake result: a progress/completion/winner smuggled into a move is ignored", () => {
  const state = craft({ stock: [card("spades", 5)] });

  const applied = play(state, {
    kind: "draw",
    // Every one of these is a claim the client is not allowed to make.
    progress: 52,
    foundationCards: 52,
    peakFoundation: 52,
    completed: true,
    completedAtMs: 1,
    winner: "player1",
    result: "player1",
    score: 9999,
    elo: 2400,
    trophy: 99,
  });

  // The board decided everything: one plain draw.
  assert.equal(applied.state.ply, 1);
  assert.equal(applied.state.peakFoundation, 0);
  assert.equal(foundationCount(applied.state), 0);
  assert.equal(applied.state.completed, false);
  assert.equal(applied.state.completedAtMs, null);
});

test("fake result: an entire fabricated board in the payload is never read", () => {
  const state = craft({ stock: [card("spades", 5)] });
  const applied = play(state, {
    kind: "draw",
    board: { tableau: [], stock: [], waste: [] },
    tableau: [[{ card: card("spades", 13), faceUp: true }]],
    foundations: { spades: new Array(13).fill(card("spades", 1)) },
    stock: [],
    waste: [],
  });
  assert.equal(applied.state.tableau.every((column) => column.length === 0), true);
  assert.deepEqual(applied.state.foundations, foundations());
});

// ── 5. Isolation and immutability ─────────────────────────────────────────

test("isolation: applying a move never mutates the state it was handed", () => {
  const tableau = columns();
  tableau[0] = [down(card("spades", 10)), up(card("hearts", 9))];
  tableau[1] = [up(card("clubs", 10))];
  const state = craft({ tableau, stock: [card("clubs", 4)] });
  const before = structuredClone(state);

  play(state, { kind: "tableau-to-tableau", fromColumn: 0, card: card("hearts", 9), toColumn: 1 });
  play(state, { kind: "draw" });

  assert.deepEqual(state, before, "the caller's state must be untouched");
});

test("isolation: two seats built from one deal can never share positions", () => {
  const deal = dealFromSeed(2024);
  const player1 = initialStateFromDeal(deal);
  const player2 = initialStateFromDeal(deal);

  // Seat 1 plays; seat 2's board must be byte-identical to the opening.
  const applied = play(player1, { kind: "draw" });
  assert.equal(applied.state.ply, 1);

  assert.equal(player2.ply, 0);
  assert.deepEqual(player2, initialStateFromDeal(deal));
  assert.notDeepEqual(applied.state, player2);
});

// ── 6. Progress ───────────────────────────────────────────────────────────

test("progress: a real deal starts at 7 revealed and 0 on foundations", () => {
  const state = initialStateFromDeal(dealFromSeed(919191));
  const progress = progressOf(state);
  assert.equal(progress.revealedTableau, 7, "one face-up card per column");
  assert.equal(progress.foundationCards, 0);

  // Only a genuine expose changes the number, and never downwards.
  const withFlip = structuredClone(state);
  withFlip.tableau[6][5].faceUp = true;
  assert.equal(revealedTableauCount(withFlip), 8);
});

test("progress: peakFoundation is a monotone high-water mark", () => {
  const tableau = columns();
  tableau[0] = [up(card("clubs", 5))];
  const piles = foundations();
  piles.hearts = [card("hearts", 1), card("hearts", 4)];

  const state = craft({ tableau, piles, peakFoundation: 9 });
  assert.equal(progressOf(state).foundationCards, 2);

  // Taking a card back off a foundation lowers the count but NOT the mark.
  const applied = play(state, { kind: "foundation-to-tableau", suit: "hearts", toColumn: 0 });
  assert.equal(progressOf(applied.state).foundationCards, 1);
  assert.equal(applied.state.peakFoundation, 9);
});

test("progress: the ladder prefers foundations, then revealed cards, then a draw", () => {
  const ahead = { foundationCards: 10, revealedTableau: 12 };
  const behind = { foundationCards: 9, revealedTableau: 28 };
  assert.equal(compareProgress(ahead, behind), 1, "foundations decide first");
  assert.equal(compareProgress(behind, ahead), -1);
  assert.equal(compareProgress({ foundationCards: 4, revealedTableau: 11 }, { foundationCards: 4, revealedTableau: 10 }), 1);
  assert.equal(compareProgress({ foundationCards: 4, revealedTableau: 10 }, { foundationCards: 4, revealedTableau: 10 }), 0);
});

test("progress: the percentage tracks the foundations, the metric that decides", () => {
  const piles = foundations();
  piles.hearts = Array.from({ length: 26 }, (_, index) => card("hearts", (index % 13) + 1));
  const state = craft({ piles });
  assert.equal(progressOf(state).foundationCards, 26);
  assert.equal(progressOf(state).progressPercent, 50);
});

// ── 7. Completion ─────────────────────────────────────────────────────────

test("completion: the last foundation card completes the puzzle", () => {
  const piles = foundations();
  piles.spades = Array.from({ length: 12 }, (_, index) => card("spades", index + 1));
  piles.hearts = Array.from({ length: 13 }, (_, index) => card("hearts", index + 1));
  piles.diamonds = Array.from({ length: 13 }, (_, index) => card("diamonds", index + 1));
  piles.clubs = Array.from({ length: 13 }, (_, index) => card("clubs", index + 1));

  const tableau = columns();
  tableau[0] = [up(card("spades", 13))];

  const state = craft({ tableau, piles });
  assert.equal(foundationCount(state), 51);
  assert.equal(isComplete(state), false);

  const applied = play(state, {
    kind: "tableau-to-foundation",
    fromColumn: 0,
    card: card("spades", 13),
    suit: "spades",
  });

  assert.equal(foundationCount(applied.state), DECK_SIZE);
  assert.equal(isComplete(applied.state), true);
  assert.equal(applied.state.completed, true);
  // The INSTANT is the store's job, never the engine's.
  assert.equal(applied.state.completedAtMs, null);
  assert.equal(progressOf(applied.state).progressPercent, 100);
});

test("completion: a finished board accepts no further moves", () => {
  const piles = foundations();
  for (const suit of ["spades", "hearts", "diamonds", "clubs"]) {
    piles[suit] = Array.from({ length: 13 }, (_, index) => card(suit, index + 1));
  }
  const state = { ...craft({ piles }), completed: true };
  assert.equal(validateMove({ state, move: { kind: "draw" } }).code, "ALREADY_COMPLETE");
  refuse(state, { kind: "draw" }, "ALREADY_COMPLETE");
});

// ── 8. The view projection hides everything it must ───────────────────────

test("view: face-down identities and the stock order never leave the server", () => {
  const state = initialStateFromDeal(dealFromSeed(555));
  const view = viewForState(state);

  const stateIds = identitiesIn(state);
  const viewIds = identitiesIn(view);

  // The server knows all 52 cards; the client is told the 7 already face-up
  // tableau cards and nothing else.
  assert.equal(stateIds.size, DECK_SIZE);
  assert.equal(viewIds.size, 7);

  const visible = new Set(
    state.tableau.flat().filter((pile) => pile.faceUp).map((pile) => `${pile.card.suit}-${pile.card.rank}`),
  );
  const hidden = state.tableau
    .flat()
    .filter((pile) => !pile.faceUp)
    .map((pile) => `${pile.card.suit}-${pile.card.rank}`);

  assert.equal(hidden.length, 21);
  for (const key of visible) assert.equal(viewIds.has(key), true, `${key} should be visible`);
  for (const key of hidden) {
    assert.equal(viewIds.has(key), false, `${key} is face-down and must not be in the view`);
  }
  for (const cardInStock of state.stock) {
    assert.equal(
      viewIds.has(`${cardInStock.suit}-${cardInStock.rank}`),
      false,
      "the stock is a count only",
    );
  }

  assert.equal("stock" in view, false, "the stock array must not be in the view");
  assert.equal(view.stockCount, 24);
  const hiddenSlots = view.tableau.flat().filter((slot) => !slot.faceUp);
  assert.equal(hiddenSlots.length, 21);
  for (const slot of hiddenSlots) assert.equal(slot.card, null);
});

test("view: progress is computed from the board, not from anything supplied", () => {
  const state = initialStateFromDeal(dealFromSeed(777));
  const view = viewForState({ ...state, peakFoundation: 3, ply: 12 });
  assert.equal(view.progress.foundationCards, 0);
  assert.equal(view.progress.revealedTableau, 7);
  assert.equal(view.ply, 12);
});

// ── 9. The settlement ladder ──────────────────────────────────────────────

const seat = (overrides = {}) => ({
  userId: "user",
  ply: 0,
  progress: { foundationCards: 0, revealedTableau: 7, progressPercent: 0 },
  completedAtMs: null,
  forfeited: false,
  ...overrides,
});

test("race: a live race resolves to nothing", () => {
  assert.equal(resolveRace({ player1: seat(), player2: seat() }), null);
});

test("race: a completion wins immediately", () => {
  const outcome = resolveRace({
    player1: seat({ completedAtMs: 1_000 }),
    player2: seat({ progress: { foundationCards: 40, revealedTableau: 28, progressPercent: 77 } }),
  });
  assert.deepEqual(outcome, { result: "player1", resolution: "finish" });
});

test("race: the earlier of two completions wins, unless they are a dead heat", () => {
  // Outside the tolerance: the earlier completion takes the match.
  const early = resolveRace({
    player1: seat({ completedAtMs: 5_000 }),
    player2: seat({ completedAtMs: 5_400 }),
  });
  assert.deepEqual(early, { result: "player1", resolution: "finish" });

  const reversed = resolveRace({
    player1: seat({ completedAtMs: 5_400 }),
    player2: seat({ completedAtMs: 5_000 }),
  });
  assert.deepEqual(reversed, { result: "player2", resolution: "finish" });

  // Inside the tolerance the two finishes are indistinguishable: a draw.
  const deadHeat = resolveRace({
    player1: seat({ completedAtMs: 5_000 }),
    player2: seat({ completedAtMs: 5_150 }),
  });
  assert.deepEqual(deadHeat, { result: "draw", resolution: "draw" });
});

test("race: a forfeit decides for the opponent, whatever the boards say", () => {
  const outcome = resolveRace({
    player1: seat({ forfeited: true, ply: 30, progress: { foundationCards: 51, revealedTableau: 28, progressPercent: 98 } }),
    player2: seat({ ply: 1 }),
  });
  assert.deepEqual(outcome, { result: "player2", resolution: "forfeit" });
});

test("race: two forfeits are a draw", () => {
  const outcome = resolveRace({
    player1: seat({ forfeited: true, ply: 4 }),
    player2: seat({ forfeited: true, ply: 9 }),
  });
  assert.deepEqual(outcome, { result: "draw", resolution: "draw" });
});

test("race: an untimed live race resolves to nothing however far apart the boards are", () => {
  const outcome = resolveRace({
    player1: seat({ ply: 40, progress: { foundationCards: 12, revealedTableau: 20, progressPercent: 23 } }),
    player2: seat({ ply: 40, progress: { foundationCards: 13, revealedTableau: 20, progressPercent: 25 } }),
  });
  assert.equal(outcome, null);
});

// ── 10. Replay and the viewer outcome ─────────────────────────────────────

test("replay: the move log reproduces the board it produced", () => {
  // A crafted deal, so the scripted sequence is legal BY CONSTRUCTION — the
  // point is the reconstruction, not the search for a legal move.
  const deal = {
    variant: "klondike-1",
    variantVersion: 1,
    tableau: [
      [down(card("spades", 9)), up(card("hearts", 10))],
      [up(card("spades", 12))],
      // J♠ is one rank above the 10♥, and black against its red: a legal target.
      [up(card("spades", 11))],
      [up(card("clubs", 2))],
      [up(card("clubs", 3))],
      [up(card("clubs", 4))],
      [up(card("clubs", 5))],
    ],
    stock: [card("clubs", 6), card("clubs", 7)],
  };

  let state = initialStateFromDeal(deal);
  const moves = [];
  const step = (move) => {
    const applied = play(state, move);
    moves.push({ kind: move.kind, move });
    state = applied.state;
  };

  step({ kind: "draw" });
  // 10♥ onto J♠: descending, alternating — and it exposes the 9♠ underneath.
  step({ kind: "tableau-to-tableau", fromColumn: 0, card: card("hearts", 10), toColumn: 2 });
  step({ kind: "draw" });

  assert.equal(state.tableau[0][0].faceUp, true, "the move exposed a hidden card");
  assert.equal(state.ply, 3);

  const replayed = replayMoves({ deal, moves });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.rejectedAt, null);
  assert.deepEqual(replayed.state, state);
});

test("replay: a corrupted log is reported rather than silently accepted", () => {
  const deal = dealFromSeed(123456);

  // An illegal move on the opening board (the waste is empty).
  const illegal = replayMoves({
    deal,
    moves: [{ kind: "waste-to-foundation", move: { kind: "waste-to-foundation", suit: "hearts" } }],
  });
  assert.equal(illegal.ok, false);
  assert.equal(illegal.rejectedAt, 0);

  // A log row whose recorded kind disagrees with its own payload.
  const mismatched = replayMoves({
    deal,
    moves: [{ kind: "draw", move: { kind: "waste-to-foundation", suit: "hearts" } }],
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.rejectedAt, 0);
});

test("state: a malformed board read back from storage is refused", () => {
  assert.equal(isWellFormedState(null), false);
  assert.equal(isWellFormedState({}), false);
  assert.equal(isWellFormedState({ tableau: [], stock: [], waste: [], foundations: {} }), false);
  assert.equal(isWellFormedState(initialStateFromDeal(dealFromSeed(9))), true);
});

test("outcome: the viewer's result is derived from the seat and the result", () => {
  assert.equal(outcomeFor("player1", "player1"), "win");
  assert.equal(outcomeFor("player1", "player2"), "loss");
  assert.equal(outcomeFor("player2", "player1"), "loss");
  assert.equal(outcomeFor("player2", "draw"), "draw");
  assert.equal(outcomeFor(null, "player1"), null);
  assert.equal(outcomeFor("player1", "tie"), null);
});
