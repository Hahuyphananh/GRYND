// tests/hex-duel-one-action.test.mjs
//
// Hex Duel is ONE ACTION PER TURN. This file pins the rulebook the client, the
// server replay and the AI all share:
//
//   1. attack      → resolves, grows the acting seat once, hands the turn over
//   2. displace    → same
//   3. skip        → the dedicated no-action move, same transition
//   4. capital     → ends the match immediately (no growth, no hand-over)
//   5. two actions → the second one from the same seat is a no-op / refused
//   6. AI          → exactly one action, then the human's turn
//   7. replay      → both clients and the stored log produce the same state
//   8. duplicates  → no double growth and no double turn flip
//
// Run: node --import tsx --test tests/hex-duel-one-action.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  HEX_DUEL_CAPITALS,
  P1_CAP_KEY,
  P2_CAP_KEY,
  applyRecordedMove,
  areAdjacent,
  checkHexDuelMove,
  coreReducer,
  makeInitialCore,
} from "../src/lib/hex-duel/rules.ts";
import { replayHexDuel } from "../src/lib/hex-duel/authority.ts";
import { decideAIAction } from "../src/lib/hexDuelAI.ts";

const SEATS = { player1Id: "user_1", player2Id: "user_2" };
const P1_CAP = P1_CAP_KEY;
const P2_CAP = P2_CAP_KEY;

function totalTroops(state) {
  return Object.values(state.tileTroops).reduce((sum, n) => sum + Number(n || 0), 0);
}

/** First neutral tile adjacent to `fromKey` (the AI and the tests need one). */
function adjacentNeutral(state, fromKey) {
  for (let x = 0; x <= 8; x += 1) {
    for (let y = 0; y <= 8; y += 1) {
      const key = `${x},${y}`;
      if (key === fromKey) continue;
      if (state.capturedTiles[key]) continue;
      if (areAdjacent(fromKey, key)) return key;
    }
  }
  throw new Error(`no neutral neighbour for ${fromKey}`);
}

/** A board where player1 really can take player2's capital. */
function statePrimedForCapture() {
  const state = makeInitialCore();
  state.capturedTiles["3,4"] = "player1";
  state.tileTroops["3,4"] = 8;
  return state;
}

// ── 1. Attack ────────────────────────────────────────────────────────────

test("an attack resolves and hands the turn over exactly once", () => {
  const state = makeInitialCore();
  const target = adjacentNeutral(state, P1_CAP);
  const after = applyRecordedMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: target,
    troopCount: 2,
  });

  assert.equal(after.capturedTiles[target], "player1", "the neutral tile was taken");
  assert.equal(after.tileTroops[P1_CAP], 4, "5 sent 2, then grew once");
  assert.equal(after.tileTroops[target], 3, "2 landed, then grew once");
  assert.equal(after.currentTurn, "player2", "the turn passed with the action");
  assert.equal(after.moveCount, 1);
  assert.equal(after.winner, null);
  // The defender did not grow: growth belongs to the seat that just acted.
  assert.equal(after.tileTroops[P2_CAP], 5);
});

// ── 2. Displace ──────────────────────────────────────────────────────────

test("a displacement hands the turn over exactly once", () => {
  const state = makeInitialCore();
  const friend = adjacentNeutral(state, P1_CAP);
  state.capturedTiles[friend] = "player1";
  state.tileTroops[friend] = 1;

  const after = applyRecordedMove(state, "player1", {
    type: "displace",
    sourceKey: P1_CAP,
    targetKey: friend,
    troopCount: 2,
  });

  assert.equal(after.tileTroops[P1_CAP], 4);
  assert.equal(after.tileTroops[friend], 4);
  assert.deepEqual(after.capturedTiles, state.capturedTiles, "ownership is unchanged");
  assert.equal(after.currentTurn, "player2");
  assert.equal(totalTroops(after), 13, "2 moved, then 1 growth per owned tile");
});

// ── 3. Skip ──────────────────────────────────────────────────────────────

test("skipping the turn is the dedicated no-action move", () => {
  const state = makeInitialCore();
  const skipped = applyRecordedMove(state, "player1", { type: "skipRound" });

  assert.equal(skipped.currentTurn, "player2");
  assert.equal(skipped.tileTroops[P1_CAP], 6, "the skipping seat still grew once");
  assert.equal(skipped.tileTroops[P2_CAP], 5);
  assert.equal(skipped.moveCount, state.moveCount, "a skip is not a move");

  // The legacy endTurn spelling is the same action, for stored rows.
  const legacy = applyRecordedMove(state, "player1", { type: "endTurn" });
  assert.deepEqual(legacy, skipped);
});

// ── 4. Capital capture ───────────────────────────────────────────────────

test("capturing the enemy capital ends the match immediately", () => {
  const state = statePrimedForCapture();
  const after = applyRecordedMove(state, "player1", {
    type: "attack",
    sourceKey: "3,4",
    targetKey: P2_CAP,
    troopCount: 7,
  });

  assert.equal(after.winner, "player1");
  assert.equal(after.capturedTiles[P2_CAP], "player1");
  // No growth and no hand-over: the match is over on the attacker's turn.
  assert.equal(after.currentTurn, "player1");
  assert.equal(after.tileTroops[P1_CAP], 5, "no passive growth on the deciding move");
  assert.equal(after.tileTroops["3,4"], 1, "7 of 8 sent, nothing grew back");
});

// ── 5. One action, not two ───────────────────────────────────────────────

test("two consecutive actions from the same seat are rejected", () => {
  const state = makeInitialCore();
  const afterFirst = applyRecordedMove(state, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: adjacentNeutral(state, P1_CAP),
    troopCount: 2,
  });
  const frozen = JSON.stringify(afterFirst);

  // The rulebook refuses a second action outright...
  const check = checkHexDuelMove(afterFirst, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: adjacentNeutral(afterFirst, P1_CAP),
    troopCount: 1,
  });
  assert.equal(check.ok, false);
  assert.equal(check.code, "NOT_YOUR_TURN");

  // ...and the reducer cannot be talked into it either.
  const afterSecond = applyRecordedMove(afterFirst, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: adjacentNeutral(afterFirst, P1_CAP),
    troopCount: 1,
  });
  assert.equal(JSON.stringify(afterSecond), frozen);
  assert.equal(afterSecond.currentTurn, "player2");

  // The seat whose turn it IS can act.
  assert.equal(
    checkHexDuelMove(afterFirst, "player2", {
      type: "attack",
      sourceKey: P2_CAP,
      targetKey: adjacentNeutral(afterFirst, P2_CAP),
      troopCount: 2,
    }).ok,
    true,
  );
});

// ── 6. The AI plays by the same rules ────────────────────────────────────

test("the AI performs exactly one action and hands control back", () => {
  // It must be the AI's turn for its action to be accepted at all.
  const game = applyRecordedMove(makeInitialCore(), "player1", { type: "skipRound" });
  assert.equal(game.currentTurn, "player2");

  const snap = {
    myPlayer: "player2",
    enemyPlayer: "player1",
    capturedTiles: game.capturedTiles,
    tileTroops: game.tileTroops,
    capitals: HEX_DUEL_CAPITALS,
  };

  for (const tier of ["easy", "normal", "hard"]) {
    const action = decideAIAction(snap, tier);
    const after = applyRecordedMove(game, "player2", action);

    assert.equal(after.currentTurn, "player1", `${tier}: the AI handed the turn back`);
    assert.equal(
      after.moveCount,
      action.type === "endTurn" ? 0 : 1,
      `${tier}: exactly one action, never a second`,
    );
    assert.equal(after.winner, null, `${tier}: no accidental instant win`);
  }
});

test("an AI skip is the same transition a human skip is", () => {
  const human = applyRecordedMove(makeInitialCore(), "player1", { type: "skipRound" });
  const ai = applyRecordedMove(human, "player2", { type: "endTurn" });

  assert.equal(human.currentTurn, "player2");
  assert.equal(ai.currentTurn, "player1");
  assert.equal(human.tileTroops[P1_CAP], 6);
  assert.equal(ai.tileTroops[P2_CAP], 6);
});

// ── 7. Replay parity ─────────────────────────────────────────────────────

test("a recorded match replays to the same state on both clients", () => {
  // Pick real, adjacent targets so the stored rows describe a legal match.
  const base = makeInitialCore();
  const p1Target = adjacentNeutral(base, P1_CAP);
  const afterP1 = applyRecordedMove(base, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: p1Target,
    troopCount: 2,
  });
  const p2Target = adjacentNeutral(afterP1, P2_CAP);
  const afterP2 = applyRecordedMove(afterP1, "player2", {
    type: "attack",
    sourceKey: P2_CAP,
    targetKey: p2Target,
    troopCount: 3,
  });
  const p2Target2 = adjacentNeutral(afterP2, p2Target);

  const moves = [
    { seat: "player1", move: { type: "attack", sourceKey: P1_CAP, targetKey: p1Target, troopCount: 2 } },
    { seat: "player2", move: { type: "attack", sourceKey: P2_CAP, targetKey: p2Target, troopCount: 3 } },
    { seat: "player1", move: { type: "skipRound" } },
    { seat: "player2", move: { type: "attack", sourceKey: p2Target, targetKey: p2Target2, troopCount: 2 } },
  ];

  // The client's local path: the reducer, exactly as the engine dispatches it.
  let client = makeInitialCore();
  for (const { seat, move } of moves) {
    client = coreReducer(
      client,
      move.type === "attack"
        ? { type: "attack", sourceKey: move.sourceKey, targetKey: move.targetKey, troopCount: move.troopCount, player: seat }
        : { type: "endTurn", player: seat, skipTroopGrowth: false },
      HEX_DUEL_CAPITALS,
    );
  }

  // The receiver's replay path.
  let receiver = makeInitialCore();
  const rows = [];
  for (const { seat, move } of moves) {
    receiver = applyRecordedMove(receiver, seat, move);
    rows.push({
      userId: seat === "player1" ? SEATS.player1Id : SEATS.player2Id,
      actionType: move.type,
      sourceKey: move.sourceKey ?? null,
      targetKey: move.targetKey ?? null,
      troopCount: move.troopCount ?? null,
    });
  }

  // The server's stored-log replay.
  const stored = replayHexDuel(SEATS, rows);

  assert.deepEqual(receiver, client, "receiver and client boards agree");
  assert.deepEqual(stored.state, client, "the stored log reproduces the same board");
  assert.equal(stored.applied, moves.length);
  assert.equal(stored.winner, null);
});

// ── 8. Duplicate delivery ────────────────────────────────────────────────

test("duplicate delivery cannot grow troops or flip the turn twice", () => {
  const start = makeInitialCore();
  const target = adjacentNeutral(start, P1_CAP);
  const attack = { type: "attack", sourceKey: P1_CAP, targetKey: target, troopCount: 2 };

  const once = applyRecordedMove(start, "player1", attack);
  const twice = applyRecordedMove(once, "player1", attack);
  const threeTimesViaSocketAndPoll = applyRecordedMove(
    applyRecordedMove(twice, "player1", attack),
    "player1",
    attack,
  );

  assert.deepEqual(twice, once, "a redelivery is a no-op");
  assert.deepEqual(threeTimesViaSocketAndPoll, once);
  assert.equal(once.currentTurn, "player2", "the turn flipped once");
  assert.equal(once.tileTroops[P1_CAP], 4, "growth applied once, not twice");
  assert.equal(once.tileTroops[target], 3);

  // A skip delivered twice must not skip the opponent's turn either.
  const skipped = applyRecordedMove(start, "player1", { type: "skipRound" });
  const skippedTwice = applyRecordedMove(skipped, "player1", { type: "skipRound" });
  assert.deepEqual(skippedTwice, skipped);
  assert.equal(skippedTwice.currentTurn, "player2");
  assert.equal(skippedTwice.tileTroops[P1_CAP], 6);
});

test("a snapshot written mid-turn cannot resurrect extra growth", () => {
  // A snapshot is an override, and the next action is evaluated against it —
  // so the seat that just acted must still be unable to act again.
  const afterAttack = applyRecordedMove(makeInitialCore(), "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: adjacentNeutral(makeInitialCore(), P1_CAP),
    troopCount: 2,
  });
  const synced = coreReducer(
    makeInitialCore(),
    { type: "syncSnapshot", snapshot: afterAttack },
    HEX_DUEL_CAPITALS,
  );
  const thenSecond = applyRecordedMove(synced, "player1", {
    type: "attack",
    sourceKey: P1_CAP,
    targetKey: adjacentNeutral(synced, P1_CAP),
    troopCount: 1,
  });

  assert.deepEqual(thenSecond.tileTroops, afterAttack.tileTroops);
  assert.equal(thenSecond.currentTurn, "player2");
});
