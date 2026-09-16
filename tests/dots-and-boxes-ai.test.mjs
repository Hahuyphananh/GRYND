import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState,
  drawEdge,
  ensureState,
  getLegalEdges,
} from "../src/lib/dotsAndBoxesEngine.ts";

test("Dots & Boxes starts with a complete legal edge set", () => {
  const state = createInitialState();
  assert.equal(getLegalEdges(state).length, 84);
  const moved = drawEdge(state, getLegalEdges(state)[0], "host");
  assert.equal(moved.error, undefined);
  assert.equal(moved.state.edges.length, 1);
});

test("every drawn edge records WHO drew it (board line colors)", () => {
  let state = createInitialState();
  assert.deepEqual(state.edgeOwners, {});

  const hostMove = drawEdge(state, "h:0,0", "host");
  assert.equal(hostMove.error, undefined);
  state = hostMove.state;
  assert.equal(state.edgeOwners["h:0,0"], "host");

  // host keeps the turn only when it claims a box; otherwise it passes.
  const guestMove = drawEdge(state, "v:0,0", "guest");
  assert.equal(guestMove.error, undefined);
  state = guestMove.state;
  assert.equal(state.edgeOwners["v:0,0"], "guest");
  assert.equal(state.edgeOwners["h:0,0"], "host");

  // Ownership survives the ensureState round-trip the routes use.
  const rehydrated = ensureState(JSON.parse(JSON.stringify(state)));
  assert.equal(rehydrated.edgeOwners["h:0,0"], "host");
  assert.equal(rehydrated.edgeOwners["v:0,0"], "guest");
});

test("ensureState tolerates legacy states without edge ownership", () => {
  // A row persisted before edgeOwners existed: the board falls back to a
  // neutral color for those lines instead of failing to render.
  const legacy = ensureState({
    edges: ["h:0,0", "v:0,0"],
    boxes: [],
    boxOwners: {},
    currentTurn: "host",
    scores: { host: 0, guest: 0 },
  });
  assert.deepEqual(legacy.edgeOwners, {});

  // Garbage is filtered: unknown roles and entries for undrawn edges drop out.
  const poisoned = ensureState({
    edges: ["h:0,0"],
    edgeOwners: { "h:0,0": "host", "v:5,5": "guest", "v:1,1": "nobody" },
    boxes: [],
    boxOwners: {},
    currentTurn: "guest",
    scores: { host: 0, guest: 0 },
  });
  assert.deepEqual(poisoned.edgeOwners, { "h:0,0": "host" });
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
