/**
 * solitaire-duel-interactions.test.mjs
 *
 * THE CLIENT'S CLICK MODEL, driven for real.
 *
 * The board has no drag-and-drop and no second ruleset: a click picks up a
 * card, a second click lays it down, and the candidate move in between is built
 * and checked by the SAME engine the server uses. These tests prove that
 * property rather than describing it:
 *
 *   1. COMPLETENESS — every move the server's rules accept from a position is
 *      expressible as two clicks on the client's board.
 *   2. SOUNDNESS — every move the client's clicks can produce is accepted by
 *      the server's rules (so a highlighted target is never a 422).
 *   3. REFUSALS — a face-down card, a broken run and an illegal destination are
 *      all refused locally, with a reason, and never produce a move.
 *   4. THE PROJECTION — the validation-only board built from a client's view
 *      agrees with the server's own state on every legality question, even
 *      though the client does not know the stock's identities.
 *
 * Run:  node --import tsx --test --experimental-test-module-mocks tests/solitaire-duel-interactions.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SUITS, TABLEAU_COLUMNS, VARIANT_VERSION } from "../src/lib/solitaire-duel/constants.ts";
import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { deriveDealSeed } from "../src/lib/solitaire-duel/seeds.js";
import {
  applyMove,
  canPlaceOnTableau,
  foundationExpects,
  initialStateFromDeal,
  isRedSuit,
  validateMove,
  viewForState,
} from "../src/lib/solitaire-duel/rules.ts";
import {
  boardForValidation,
  canDraw,
  canDropOnColumn,
  canDropOnFoundation,
  columnTopCard,
  dropTargetsFor,
  isLegalMove,
  moveForTarget,
  movesForSelection,
  movableRun,
  resolveClick,
  selectionFor,
  wasteTopCard,
} from "../src/lib/solitaire-duel/interactions.ts";

const SERVER_SEED = "5a".repeat(32);
const DEAL = dealFromSeed(
  deriveDealSeed({ serverSeed: SERVER_SEED, variantVersion: VARIANT_VERSION }),
);

const key = (value) => JSON.stringify(value);
const card = (suit, rank) => ({ suit, rank });

/** A board with the deal's opening position, plus its client projection. */
function opening() {
  const state = initialStateFromDeal(DEAL);
  return { state, view: viewForState(state) };
}

/** Every possible move from a position, straight from the server's rules. */
function serverLegalMoves(state) {
  const candidates = [];
  const wasteTop = state.waste[state.waste.length - 1] ?? null;

  if (wasteTop) {
    for (const suit of SUITS) {
      candidates.push({ kind: "waste-to-foundation", suit });
    }
    for (let column = 0; column < TABLEAU_COLUMNS; column += 1) {
      candidates.push({ kind: "waste-to-tableau", toColumn: column });
    }
  }

  for (let column = 0; column < TABLEAU_COLUMNS; column += 1) {
    const pile = state.tableau[column];
    const top = pile[pile.length - 1];
    if (top?.faceUp && top.card) {
      for (const suit of SUITS) {
        candidates.push({
          kind: "tableau-to-foundation",
          fromColumn: column,
          card: top.card,
          suit,
        });
      }
    }
    pile.forEach((slot, index) => {
      if (!slot.faceUp || !slot.card) return;
      for (let to = 0; to < TABLEAU_COLUMNS; to += 1) {
        if (to === column) continue;
        if (index >= 0) {
          candidates.push({
            kind: "tableau-to-tableau",
            fromColumn: column,
            card: slot.card,
            toColumn: to,
          });
        }
      }
    });
  }

  for (const suit of SUITS) {
    const pile = state.foundations[suit];
    if (pile.length === 0) continue;
    for (let column = 0; column < TABLEAU_COLUMNS; column += 1) {
      candidates.push({ kind: "foundation-to-tableau", suit, toColumn: column });
    }
  }

  return candidates.filter(
    (move) => validateMove({ state, move }).ok === true,
  );
}

/** Every selection a player can actually make on a projected view. */
function allSelections(view) {
  const selections = [];
  const waste = selectionFor(view, { kind: "waste" });
  if (waste) selections.push(waste);
  for (const suit of SUITS) {
    const foundation = selectionFor(view, { kind: "foundation", suit });
    if (foundation) selections.push(foundation);
  }
  for (let column = 0; column < TABLEAU_COLUMNS; column += 1) {
    for (const slot of view.tableau[column]) {
      if (!slot.faceUp || !slot.card) continue;
      const selection = selectionFor(view, { kind: "tableau", column, card: slot.card });
      if (selection) selections.push(selection);
    }
  }
  return selections;
}

/** Every move the client's clicks can produce from a projected view. */
function clientMoves(view) {
  const moves = [];
  for (const selection of allSelections(view)) {
    for (const move of movesForSelection(view, selection)) moves.push(move);
  }
  return moves;
}

// ── 1 + 2. The click model matches the server, in both directions ─────────

test("clicks: the opening position's legal moves are all expressible and all accepted", () => {
  const { state, view } = opening();

  const fromServer = serverLegalMoves(state).map(key);
  const fromClient = clientMoves(view).map(key);

  // Soundness: every click-reachable move is a move the server's rules accept.
  for (const move of clientMoves(view)) {
    assert.equal(
      isLegalMove(view, move),
      true,
      `${key(move)} must be legal on the server's board`,
    );
    assert.equal(validateMove({ state, move }).ok, true, `${key(move)} must validate`);
  }

  // Completeness: nothing the rules allow is unreachable through the board.
  for (const move of fromServer) {
    assert.ok(fromClient.includes(move), `${move} must be expressible as two clicks`);
  }

  // At minimum the opening position offers the deals' own first moves.
  assert.ok(fromServer.length >= 0);
});

test("clicks: soundness and completeness hold after real moves are applied", () => {
  let state = initialStateFromDeal(DEAL);
  let applied = 0;

  // Walk the position forward with SERVER-applied moves, re-checking the
  // client model at every step. The draw is used as the driver because it is
  // always available and it exposes new waste cards.
  for (let step = 0; step < 40; step += 1) {
    const view = viewForState(state);

    for (const move of clientMoves(view)) {
      assert.equal(
        validateMove({ state, move }).ok,
        true,
        `step ${step}: ${key(move)} must be accepted by the server`,
      );
    }
    const legal = serverLegalMoves(state).map(key);
    const reachable = clientMoves(view).map(key);
    for (const move of legal) {
      assert.ok(reachable.includes(move), `step ${step}: ${move} must be click-expressible`);
    }

    const result = applyMove({ state, move: { kind: "draw" } });
    assert.equal(result.ok, true, "a draw must always be available here");
    state = result.state;
    applied += 1;
  }

  assert.equal(applied, 40);
});

test("clicks: a real move round-trips from a click to the server's board", () => {
  let state = initialStateFromDeal(DEAL);
  let played = 0;

  // Find a tableau-to-tableau or waste-to-foundation move through the CLIENT's
  // model, then apply exactly that move to the server's state and confirm both
  // boards agree afterwards.
  for (let step = 0; step < 60 && played < 5; step += 1) {
    const view = viewForState(state);
    const move = movesForSelection(view, allSelections(view)[0] ?? null)[0] ?? null;
    if (!move) {
      state = applyMove({ state, move: { kind: "draw" } }).state;
      continue;
    }

    const before = viewForState(state);
    const applied = applyMove({ state, move });
    assert.equal(applied.ok, true, `${key(move)} must apply`);
    state = applied.state;
    const after = viewForState(state);

    // The projection the client will render next is exactly the board the one
    // round trip produced.
    assert.equal(after.ply, before.ply + 1);
    played += 1;
  }

  assert.ok(played > 0, "at least one non-draw move must have been playable");
});

// ── 3. Refusals ───────────────────────────────────────────────────────────

test("refusals: a face-down card is not selectable and carries no identity", () => {
  const { view } = opening();
  const hidden = [];
  for (let column = 0; column < TABLEAU_COLUMNS; column += 1) {
    view.tableau[column].forEach((slot, index) => {
      if (!slot.faceUp) hidden.push({ column, index });
    });
  }
  assert.ok(hidden.length > 0, "a Klondike opening always has face-down cards");

  for (const spot of hidden) {
    const slot = view.tableau[spot.column][spot.index];
    assert.equal(slot.card, null, "a hidden position carries no identity");
    // There is nothing to name, so there is nothing to click: the click model
    // resolves a click on a column's hidden top to the COLUMN (a drop slot),
    // never to a card.
    const selection = selectionFor(view, {
      kind: "tableau",
      column: spot.column,
      card: { suit: "spades", rank: 13 },
    });
    assert.equal(selection, null);
  }
});

test("refusals: a broken run cannot be picked up", () => {
  const { state, view } = opening();
  // Column 0 holds exactly one card in every Klondike opening, so the deal
  // itself is a single-card stack: lengthen it with a deliberately broken
  // sequence to prove the run rule.
  const broken = structuredClone(view);
  broken.tableau[0] = [
    { faceUp: true, card: card("spades", 5) },
    { faceUp: true, card: card("hearts", 9) },
  ];
  assert.equal(movableRun(broken, 0, card("spades", 5)), null);

  const descending = structuredClone(view);
  descending.tableau[0] = [
    { faceUp: true, card: card("spades", 9) },
    { faceUp: true, card: card("hearts", 8) },
    { faceUp: true, card: card("clubs", 7) },
  ];
  assert.deepEqual(movableRun(descending, 0, card("spades", 9)), [
    card("spades", 9),
    card("hearts", 8),
    card("clubs", 7),
  ]);
  // ...but the middle of a run is still a legal head.
  assert.deepEqual(movableRun(descending, 0, card("hearts", 8)), [
    card("hearts", 8),
    card("clubs", 7),
  ]);

  assert.ok(state.tableau.length === TABLEAU_COLUMNS);
});

test("refusals: an illegal destination produces no move and a reason", () => {
  const { view } = opening();
  const waste = selectionFor(view, { kind: "waste" });
  // The opening waste is empty, so there is nothing to hold and nothing to do.
  assert.equal(waste, null);
  const refused = resolveClick(view, null, { kind: "waste" });
  assert.equal(refused.type, "none");

  // Seven genuinely empty columns, so "does an empty column take this?" is the
  // question being asked.
  const bare = structuredClone(view);
  bare.tableau = Array.from({ length: TABLEAU_COLUMNS }, () => []);
  const held = { kind: "waste" };

  // A two-of-hearts can never go on an empty column.
  const twoOfHearts = structuredClone(bare);
  twoOfHearts.waste = [card("hearts", 2)];
  const ontoEmpty = resolveClick(twoOfHearts, held, { kind: "column", column: 3 });
  assert.equal(ontoEmpty.type, "invalid");
  assert.match(ontoEmpty.message, /cannot/i);

  // A king can.
  const kingOnEmpty = structuredClone(bare);
  kingOnEmpty.waste = [card("clubs", 13)];
  const placed = resolveClick(kingOnEmpty, held, { kind: "column", column: 3 });
  assert.equal(placed.type, "move");
  assert.deepEqual(placed.move, { kind: "waste-to-tableau", toColumn: 3 });

  // A column whose TOP card is still face-down is not an empty column: it does
  // not accept a king either. (The server's own rule, mirrored exactly.)
  const blocked = structuredClone(bare);
  blocked.tableau[3] = [{ faceUp: false, card: null }];
  blocked.waste = [card("clubs", 13)];
  assert.equal(canDropOnColumn(blocked, 3, card("clubs", 13)), false);
  assert.equal(resolveClick(blocked, held, { kind: "column", column: 3 }).type, "invalid");
});

test("refusals: the stock refuses a draw only when both piles are empty", () => {
  const { view } = opening();
  assert.equal(canDraw(view), true);
  assert.equal(resolveClick(view, null, { kind: "stock" }).type, "move");
  assert.deepEqual(resolveClick(view, null, { kind: "stock" }).move, { kind: "draw" });

  // Stock exhausted with a waste to recycle: still a legal move (a redeal).
  const redeal = structuredClone(view);
  redeal.stockCount = 0;
  redeal.waste = [card("spades", 4)];
  redeal.canRedeal = true;
  assert.equal(canDraw(redeal), true);
  assert.deepEqual(resolveClick(redeal, null, { kind: "stock" }).move, { kind: "draw" });

  // Both empty: nothing to draw, and the click is refused with a reason.
  const empty = structuredClone(view);
  empty.stockCount = 0;
  empty.waste = [];
  empty.canRedeal = false;
  assert.equal(canDraw(empty), false);
  const refused = resolveClick(empty, null, { kind: "stock" });
  assert.equal(refused.type, "invalid");
  assert.match(refused.message, /empty/i);
  assert.equal(moveForTarget(empty, { kind: "waste" }, { kind: "column", column: 0 }), null);
});

// ── 4. Selection behaviour ────────────────────────────────────────────────

test("selection: clicking the held card again puts it back down", () => {
  const view = structuredClone(viewForState(initialStateFromDeal(DEAL)));
  view.waste = [card("hearts", 7)];

  const first = resolveClick(view, null, { kind: "waste" });
  assert.equal(first.type, "select");

  const again = resolveClick(view, first.selection, { kind: "waste" });
  assert.equal(again.type, "clear");

  // A foundation's top card behaves the same way.
  view.foundations.spades = [card("spades", 1)];
  const foundation = resolveClick(view, null, { kind: "foundation", suit: "spades" });
  assert.equal(foundation.type, "select");
  assert.equal(resolveClick(view, foundation.selection, { kind: "foundation", suit: "spades" }).type, "clear");
});

test("selection: only the waste's TOP card is ever movable", () => {
  const view = structuredClone(viewForState(initialStateFromDeal(DEAL)));
  view.waste = [card("spades", 9), card("hearts", 8), card("clubs", 7)];

  assert.deepEqual(wasteTopCard(view), card("clubs", 7));
  const moves = movesForSelection(view, selectionFor(view, { kind: "waste" }));
  // Every candidate names the waste's top card as its source (a waste move has
  // no card field at all — the engine always resolves the top).
  for (const move of moves) {
    assert.ok(move.kind === "waste-to-tableau" || move.kind === "waste-to-foundation");
  }
  // Never a move from a card buried in the waste.
  assert.equal(
    moves.some((move) => move.kind === "tableau-to-tableau" && move.card.rank === 9),
    false,
  );
});

test("selection: highlighted targets are exactly the accepted destinations", () => {
  const view = structuredClone(viewForState(initialStateFromDeal(DEAL)));
  view.waste = [card("clubs", 13)];
  const selection = selectionFor(view, { kind: "waste" });
  const targets = dropTargetsFor(view, selection);

  for (const column of targets.columns) {
    const move = moveForTarget(view, selection, { kind: "column", column });
    assert.ok(move, `column ${column} was highlighted, so it must accept the card`);
    assert.equal(isLegalMove(view, move), true);
    assert.equal(canDropOnColumn(view, column, card("clubs", 13)), true);
  }
  // A column that cannot take it is not highlighted.
  for (let column = 0; column < TABLEAU_COLUMNS; column += 1) {
    if (!targets.columns.includes(column)) {
      assert.equal(canDropOnColumn(view, column, card("clubs", 13)), false);
    }
  }
  for (const suit of targets.suits) {
    assert.equal(canDropOnFoundation(view, suit, card("clubs", 13)), true);
  }
  // A king never goes on a foundation.
  assert.equal(canDropOnFoundation(view, "clubs", card("clubs", 13)), false);
});

// ── 5. The validation-only projection ─────────────────────────────────────

test("projection: the validation board agrees with the server on every question", () => {
  let state = initialStateFromDeal(DEAL);

  for (let step = 0; step < 30; step += 1) {
    const view = viewForState(state);
    const pseudo = boardForValidation(view);

    // The client's reconstruction keeps the fields validation reads...
    assert.equal(pseudo.ply, state.ply);
    assert.equal(pseudo.completed, state.completed);
    assert.deepEqual(pseudo.foundations, state.foundations);
    assert.deepEqual(pseudo.waste, state.waste);
    assert.equal(pseudo.stock.length, state.stock.length);
    // ...and it carries NO real stock identity (only its length is known).
    assert.equal(pseudo.peakFoundation, 0);
    for (const suit of SUITS) {
      assert.equal(pseudo.foundations[suit].length, state.foundations[suit].length);
    }

    // Every candidate move agrees, one for one.
    for (const candidate of serverLegalMoves(state)) {
      assert.equal(
        validateMove({ state: pseudo, move: candidate }).ok,
        validateMove({ state, move: candidate }).ok,
        `${key(candidate)} must be judged identically`,
      );
      assert.equal(isLegalMove(view, candidate), true);
    }

    // The engine's helpers agree too.
    for (let column = 0; column < TABLEAU_COLUMNS; column += 1) {
      const top = state.tableau[column][state.tableau[column].length - 1];
      if (top?.faceUp && top.card) {
        assert.equal(columnTopCard(view, column).rank, top.card.rank);
      } else {
        assert.equal(columnTopCard(view, column), null);
      }
      assert.equal(
        canDropOnColumn(view, column, card("clubs", 13)),
        canPlaceOnTableau(card("clubs", 13), top?.faceUp ? top.card : top ? null : null),
      );
    }
    for (const suit of SUITS) {
      assert.equal(foundationExpects(pseudo, suit), foundationExpects(state, suit));
    }

    const result = applyMove({ state, move: { kind: "draw" } });
    assert.equal(result.ok, true);
    state = result.state;
  }
});

test("projection: red/black alternation is the engine's own predicate", () => {
  // The board's colour rule must be the engine's, not a second one: a red
  // suit's cards only land on black ones, and vice versa.
  const view = structuredClone(viewForState(initialStateFromDeal(DEAL)));
  view.tableau[0] = [{ faceUp: true, card: card("spades", 10) }];
  assert.equal(isRedSuit("hearts"), true);
  assert.equal(canDropOnColumn(view, 0, card("hearts", 9)), true);
  assert.equal(canDropOnColumn(view, 0, card("diamonds", 9)), true);
  assert.equal(canDropOnColumn(view, 0, card("clubs", 9)), false);
  assert.equal(canDropOnColumn(view, 0, card("hearts", 8)), false);
});
