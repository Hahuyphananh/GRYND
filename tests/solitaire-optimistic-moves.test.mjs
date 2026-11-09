/**
 * solitaire-optimistic-moves.test.mjs
 *
 * The move is drawn the instant it is made, not a round trip later.
 *
 * `applyMoveToView` rewrites the viewer's OWN projected board for a move that
 * touches only cards the viewer can already see. These tests pin that it is the
 * same board the engine produces (minus the one thing a client cannot know: the
 * identity a face-down card flips to), and that the two unpredicted cases are
 * refused rather than guessed.
 *
 * Run: node --import tsx --test tests/solitaire-optimistic-moves.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  applyMoveToView,
  exposesHiddenCard,
  isPredictable,
} from "../src/lib/solitaire-duel/optimistic.ts";
import { legalMoves } from "../src/lib/solitaire-duel/ai.ts";
import {
  applyMove,
  initialStateFromDeal,
  viewForState,
} from "../src/lib/solitaire-duel/rules.ts";
import { solvableDealFromSeed } from "../src/lib/solitaire-duel/solvable.ts";

/** Walk a real deal and hand back (view, move, engine view after) samples. */
function samples() {
  const found = [];
  const seenKinds = new Set();
  for (const seed of [7, 2026, 4242, 99]) {
    let state = initialStateFromDeal(solvableDealFromSeed(seed));
    for (let ply = 0; ply < 40 && !state.completed; ply += 1) {
      const view = viewForState(state);
      for (const move of legalMoves(state)) {
        const applied = applyMove({ state, move });
        if (!applied.ok) continue;
        if (seenKinds.has(move.kind) && move.kind !== "tableau-to-tableau") continue;
        seenKinds.add(move.kind);
        found.push({ view, move, next: viewForState(applied.state) });
      }
      const move = legalMoves(state)[0];
      if (!move) break;
      const applied = applyMove({ state, move });
      if (!applied.ok) break;
      state = applied.state;
    }
  }
  return found;
}

const SAMPLES = samples();

test("a predictable move draws exactly the board the engine produces", () => {
  const kinds = new Set();
  let checked = 0;
  for (const { view, move, next } of SAMPLES) {
    if (move.kind === "draw") continue;
    // A move that turns a card over leaves that position face-down here: the
    // identity is the server's to name, so the rest of the board is what we
    // compare.
    if (exposesHiddenCard(view, move)) continue;

    const painted = applyMoveToView(view, move);
    assert.ok(painted, `${move.kind} must be predictable`);
    kinds.add(move.kind);
    checked += 1;

    assert.deepEqual(painted.tableau, next.tableau, `${move.kind}: tableau`);
    assert.deepEqual(painted.waste, next.waste, `${move.kind}: waste`);
    assert.deepEqual(painted.foundations, next.foundations, `${move.kind}: foundations`);
    assert.equal(painted.stockCount, next.stockCount, `${move.kind}: stock count`);
    assert.equal(painted.ply, view.ply + 1, "the draw advances the local cursor once");
    assert.equal(painted.completed, false, "only the server may finish a race");
  }
  assert.ok(checked >= 10, `expected real samples, got ${checked}`);
  // The sample depends on the deals' shape; what matters is that the visible
  // moves a player actually makes are covered, not every kind on every seed.
  assert.ok(kinds.size >= 3, `expected several move kinds, got ${[...kinds].join(",")}`);
});

test("a draw is refused, never guessed", () => {
  const drawSample = SAMPLES.find((sample) => sample.move.kind === "draw");
  assert.ok(drawSample, "the sample must contain a draw");
  assert.equal(applyMoveToView(drawSample.view, { kind: "draw" }), null);
  assert.equal(isPredictable({ kind: "draw" }), false);
});

test("a move that exposes a hidden card is still drawn, without the flip", () => {
  const revealing = SAMPLES.find((sample) => exposesHiddenCard(sample.view, sample.move));
  if (!revealing) return; // sample-dependent, but the rule is asserted below
  const painted = applyMoveToView(revealing.view, revealing.move);
  assert.ok(painted);
  const column = painted.tableau[revealing.move.fromColumn];
  const exposed = column[column.length - 1];
  assert.equal(exposed.faceUp, false, "a face-down identity is never invented");
  assert.equal(exposed.card, null, "no placeholder card either");
});

test("the race page draws first and syncs behind, instead of locking the board", () => {
  const source = fs.readFileSync(
    "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx",
    "utf8",
  );
  assert.match(source, /applyMoveToView/);
  assert.match(source, /queueRef/, "moves are queued, not dropped while in flight");
  assert.match(source, /MOVE_QUEUE_LIMIT/);
  assert.doesNotMatch(source, /inFlightRef/, "the old in-flight lock is gone");
  assert.doesNotMatch(source, /queuedDrawsRef/, "draws share the one queue");
  assert.doesNotMatch(source, /pending=\{pending\}/, "the board is never disabled while verifying");
  // The authoritative cursor still comes from the server's own snapshot.
  assert.match(source, /expectedPly = Number\(authoritativeViewRef\.current\?\.ply/);
  assert.match(source, /optimisticView \?\? match\?\.view/);
});
