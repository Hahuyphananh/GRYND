import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, drawEdge, getLegalEdges } from "../src/lib/dotsAndBoxesEngine.ts";

test("Dots & Boxes starts with a complete legal edge set", () => {
  const state = createInitialState();
  assert.equal(getLegalEdges(state).length, 84);
  const moved = drawEdge(state, getLegalEdges(state)[0], "host");
  assert.equal(moved.error, undefined);
  assert.equal(moved.state.edges.length, 1);
});

test("engine preserves extra turns when a box is completed", () => {
  let state = createInitialState();
  for (const edge of ["h:0,0", "v:0,0", "v:0,1"]) {
    const moved = drawEdge(state, edge, state.currentTurn);
    assert.equal(moved.error, undefined);
    state = moved.state;
  }
  const final = drawEdge(state, "h:1,0", state.currentTurn);
  assert.equal(final.error, undefined);
  assert.equal(final.state.scores.host + final.state.scores.guest, 1);
  assert.equal(final.state.currentTurn, "guest");
});
