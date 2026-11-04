// tests/hex-duel-move-animation.test.mjs
//
// Troop-movement / battle animation layer:
//   • event snapshots built from PRE-action state + authoritative outcome
//   • dot budgets, survivor representation, timing
//   • curved travel + compact formation geometry
//   • wiring: engine publishes, board plays, motion preference respected
//
// The overlay must never compute gameplay, so the pure builder is fed real
// `resolveAttackOutcome` results and the components are checked for absence of
// dispatch/network calls.
//
// Run: node --import tsx --test tests/hex-duel-move-animation.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  HEX_DUEL_CAPITALS,
  P1_CAP_KEY,
  P2_CAP_KEY,
  makeInitialCore,
  resolveAttackOutcome,
} from "../src/lib/hex-duel/rules.ts";
import {
  ATTACK_ANIMATION_MS,
  DISPLACE_ANIMATION_MS,
  MAX_ATTACKER_DOTS,
  MAX_DEFENDER_DOTS,
  buildTroopAnimationPlan,
  buildTroopMoveEvent,
  clamp01,
  dotFormationPoint,
  easeOut,
  travelPoint,
} from "../src/lib/hexTroopAnimation.ts";

const read = (p) => fs.readFileSync(p, "utf8");

/** A hand-built pre-action board: P1 cap 5, P2 holds "1,0" with `defenders`. */
function contestedBoard(defenders, { sourceTroops = 5 } = {}) {
  return {
    capturedTiles: {
      [P1_CAP_KEY]: "player1",
      [P2_CAP_KEY]: "player2",
      "1,0": "player2",
    },
    tileTroops: {
      [P1_CAP_KEY]: sourceTroops,
      [P2_CAP_KEY]: 5,
      "1,0": defenders,
    },
    territoryLevels: {},
    currentTurn: "player1",
  };
}

function attackEvent(board, sent, target = "1,0", capitals = HEX_DUEL_CAPITALS) {
  const outcome = resolveAttackOutcome(
    board,
    P1_CAP_KEY,
    target,
    sent,
    "player1",
    capitals,
  );
  return buildTroopMoveEvent({
    kind: "attack",
    actor: "player1",
    fromKey: P1_CAP_KEY,
    toKey: target,
    sent,
    board,
    outcome,
    capitals,
  });
}

// ── A. Event snapshot: pre-action numbers ───────────────────────────────

test("a displacement reports the pre-action armies on both tiles", () => {
  const board = {
    capturedTiles: { [P1_CAP_KEY]: "player1", "1,0": "player1" },
    tileTroops: { [P1_CAP_KEY]: 5, "1,0": 2 },
    territoryLevels: {},
    currentTurn: "player1",
  };
  const event = buildTroopMoveEvent({
    kind: "displace",
    actor: "player1",
    fromKey: P1_CAP_KEY,
    toKey: "1,0",
    sent: 3,
    board,
  });

  assert.equal(event.kind, "displace");
  assert.equal(event.preSource, 5);
  assert.equal(event.preTarget, 2);
  assert.equal(event.preOwner, "player1");
  assert.equal(event.postOwner, "player1");
  assert.equal(event.outcome, "displace");
  assert.equal(event.survivors, 0);
  assert.equal(event.conquered, false);
});

test("a neutral destination has no defending dots and no owner", () => {
  const board = makeInitialCore("player1");
  const event = attackEvent(board, 4);

  assert.equal(event.preOwner, null);
  assert.equal(event.preTarget, 0);
  assert.equal(event.outcome, "conquer");
  assert.equal(event.conquered, true);
  assert.equal(event.postOwner, "player1");
  assert.ok(event.survivors > 0, "survivors come from the rulebook");
});

test("a successful conquest reports the authoritative survivors", () => {
  const event = attackEvent(contestedBoard(3), 4);
  const board = contestedBoard(3);
  const outcome = resolveAttackOutcome(
    board,
    P1_CAP_KEY,
    "1,0",
    4,
    "player1",
    HEX_DUEL_CAPITALS,
  );

  assert.equal(event.outcome, "conquer");
  assert.equal(event.conquered, true);
  assert.equal(event.postOwner, "player1");
  assert.equal(event.defenderAfter, 0);
  assert.equal(event.survivors, Math.max(0, outcome.remainingTroops));
  assert.ok(event.survivors > 0);
});

test("a failed attack keeps the defender and loses the attackers", () => {
  const event = attackEvent(contestedBoard(8), 3);

  assert.equal(event.outcome, "failed");
  assert.equal(event.conquered, false);
  assert.equal(event.postOwner, "player2");
  assert.equal(event.survivors, 0);
  assert.equal(event.defenderAfter, 5, "8 defenders vs 3 attackers leaves 5");
});

test("an equal-strength battle wipes both armies and neutralises the tile", () => {
  const event = attackEvent(contestedBoard(5, { sourceTroops: 6 }), 5);

  assert.equal(event.outcome, "tie");
  assert.equal(event.survivors, 0);
  assert.equal(event.defenderAfter, 0);
  assert.equal(event.postOwner, null);
  assert.equal(event.conquered, false);
});

test("capital capture is flagged from the real capitals map", () => {
  const board = {
    capturedTiles: { [P1_CAP_KEY]: "player1", [P2_CAP_KEY]: "player2" },
    tileTroops: { [P1_CAP_KEY]: 9, [P2_CAP_KEY]: 4 },
    territoryLevels: {},
    currentTurn: "player1",
  };
  const event = attackEvent(board, 8, P2_CAP_KEY);

  assert.equal(event.outcome, "conquer");
  assert.equal(event.capital, true);
  assert.equal(event.postOwner, "player1");
});

test("survivors never exceed the level-1 ceiling the reducer enforces", () => {
  const body = buildTroopMoveEvent({
    kind: "attack",
    actor: "player1",
    fromKey: P1_CAP_KEY,
    toKey: "1,0",
    sent: 40,
    board: { capturedTiles: {}, tileTroops: {} },
    outcome: { kind: "conquer", remainingTroops: 38, conqueredCapital: false },
  });
  assert.equal(body.survivors, 10);
});

// ── B. Dot budgets ─────────────────────────────────────────────────────

const withId = (body, id = 1) => ({ ...body, id });

test("dot counts follow the armies, capped for performance", () => {
  const huge = withId(
    buildTroopMoveEvent({
      kind: "attack",
      actor: "player1",
      fromKey: P1_CAP_KEY,
      toKey: "1,0",
      sent: 137,
      board: {
        capturedTiles: { "1,0": "player2" },
        tileTroops: { [P1_CAP_KEY]: 140, "1,0": 99 },
      },
      outcome: { kind: "failed", newDefenderTroops: 60, defenderWipedOut: false },
    }),
  );

  const plan = buildTroopAnimationPlan(huge);
  assert.equal(plan.attackerDots, MAX_ATTACKER_DOTS);
  assert.equal(plan.defenderDots, MAX_DEFENDER_DOTS);
  assert.equal(plan.skipped, false);
  assert.equal(plan.durationMs, ATTACK_ANIMATION_MS);

  const small = buildTroopAnimationPlan({
    ...huge,
    sent: 3,
    preTarget: 2,
    outcome: "failed",
    conquered: false,
  });
  assert.equal(small.attackerDots, 3);
  assert.equal(small.defenderDots, 2);
});

test("a conquest leaves surviving dots on the tile, proportionally", () => {
  const event = withId({
    ...attackEvent(contestedBoard(4), 5),
    sent: 10,
    survivors: 5,
    conquered: true,
  });
  const plan = buildTroopAnimationPlan(event);
  assert.equal(plan.attackerDots, 10);
  assert.equal(plan.survivorDots, 5);

  const wiped = buildTroopAnimationPlan({
    ...event,
    survivors: 0,
    conquered: false,
    outcome: "failed",
  });
  assert.equal(wiped.survivorDots, 0);

  const barelySurvived = buildTroopAnimationPlan({
    ...event,
    sent: 40,
    survivors: 1,
  });
  assert.equal(barelySurvived.survivorDots, 1, "at least one dot survives visually");
});

test("displacements have no defenders, no clash and a shorter timeline", () => {
  const event = withId(buildTroopMoveEvent({
    kind: "displace",
    actor: "player2",
    fromKey: P2_CAP_KEY,
    toKey: "4,3",
    sent: 2,
    board: {
      capturedTiles: { [P2_CAP_KEY]: "player2", "4,3": "player2" },
      tileTroops: { [P2_CAP_KEY]: 4, "4,3": 2 },
    },
  }));
  const plan = buildTroopAnimationPlan(event);
  assert.equal(plan.defenderDots, 0);
  assert.equal(plan.durationMs, DISPLACE_ANIMATION_MS);
  assert.ok(plan.durationMs < ATTACK_ANIMATION_MS);
  assert.ok(plan.clashAt > 0.5, "arrival glow happens late in the move");
});

test("reduced motion and empty armies skip the animation entirely", () => {
  const event = withId(attackEvent(contestedBoard(3), 4));

  const reduced = buildTroopAnimationPlan(event, { reducedMotion: true });
  assert.equal(reduced.skipped, true);
  assert.equal(reduced.durationMs, 0);
  assert.equal(reduced.attackerDots, 0);

  const empty = buildTroopAnimationPlan({ ...event, sent: 0 });
  assert.equal(empty.skipped, true);
  assert.equal(buildTroopAnimationPlan(event).skipped, false);
});

// ── C. Geometry ────────────────────────────────────────────────────────

test("travelPoint starts at the source, ends at the target and bows sideways", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 0 };

  assert.deepEqual(travelPoint(from, to, 0), { x: 0, y: 0 });
  assert.deepEqual(travelPoint(from, to, 1), { x: 100, y: 0 });
  const mid = travelPoint(from, to, 0.5);
  assert.ok(Math.abs(mid.x - 50) < 1e-9);
  assert.ok(Math.abs(mid.y) < 1e-9);

  const arced = travelPoint(from, to, 0.5, 20);
  assert.ok(arced.y > 0, "arc bows perpendicular to the line");
  assert.equal(arced.x, 50);
  // Diagonal travel still reaches both ends exactly.
  assert.deepEqual(travelPoint(from, { x: 40, y: 40 }, 0), from);
  assert.deepEqual(travelPoint(from, { x: 40, y: 40 }, 1), { x: 40, y: 40 });
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(7), 1);
  assert.equal(easeOut(0), 0);
  assert.equal(easeOut(1), 1);
  assert.ok(easeOut(0.5) > 0.5);
});

test("dot formations are centred, ten columns wide, with tidy short rows", () => {
  assert.deepEqual(dotFormationPoint(0, 1, 100, 50, 10), { x: 100, y: 50 });

  const spacing = 6;
  const first = dotFormationPoint(0, 10, 0, 0, spacing);
  assert.equal(first.x, -4.5 * spacing);
  assert.equal(first.y, 0);

  // 25 dots = 3 rows; the last row (5 dots) stays centred on the tile.
  const lastRowStart = dotFormationPoint(20, 25, 0, 0, spacing);
  const lastRowEnd = dotFormationPoint(24, 25, 0, 0, spacing);
  assert.equal(lastRowStart.x, -2 * spacing);
  assert.equal(lastRowEnd.x, 2 * spacing);
  assert.equal(lastRowStart.y, spacing);
  assert.equal(dotFormationPoint(0, 100, 0, 0, spacing).y, -4.5 * spacing);
});

// ── D. Engine feed: local, remote and AI all publish one event ─────────

test("the engine publishes a movement event from pre-action state", () => {
  const engine = read("src/lib/hexDuelEngine.ts");

  assert.match(engine, /const publishMove = useCallback/);
  assert.match(engine, /moveAnimationIdRef\.current \+= 1/);
  assert.match(engine, /setMoveAnimation\(\{ \.\.\.event, id: moveAnimationIdRef\.current \}\)/);
  // Local attack (with the outcome it already computed) and local displace.
  assert.match(engine, /logAttack\(sourceKey, targetKey, troopCount, state\.currentTurn, outcome\);\s*\n\s*publishMove\(/);
  assert.match(engine, /logDisplace\(sourceKey, targetKey, troopCount, state\.currentTurn\);\s*\n\s*publishMove\(/);
  // Remote attack and remote displace go through the same feed.
  assert.match(engine, /logAttack\(\s*\n\s*action\.sourceKey,[\s\S]{0,220}?publishMove\(/);
  assert.match(engine, /logDisplace\(\s*\n\s*action\.sourceKey,[\s\S]{0,220}?publishMove\(/);
  // Stale/duplicate deliveries never replay an animation.
  const guards = engine.match(/if \(state\.currentTurn !== fromPlayer\) return;/g) ?? [];
  assert.equal(guards.length, 2, "attack and displace both guard on the acting seat");
  assert.match(engine, /moveAnimation,/);
  // The AI drives the same local handlers, so it needs no animation code.
  const ai = read("src/lib/hexDuelAI.ts");
  assert.doesNotMatch(ai, /Animation|animation/);
});

test("the board plays one overlay per event id and reveals the real dots after", () => {
  const board = read("src/components/HexBoard.tsx");

  assert.match(board, /troopAnimation\?: TroopMoveEvent \| null;/);
  assert.match(board, /import HexMoveAnimation from "\.\/HexMoveAnimation";/);
  assert.match(board, /key=\{moveEffect\.event\.id\}/);
  assert.match(board, /prefers-reduced-motion: reduce/);
  assert.match(board, /dotsMuted=\{/);
  // The overlay is purely visual and cannot shift or block the board.
  assert.match(board, /pointer-events-none absolute inset-0 z-20/);
  assert.match(board, /const handleMoveDone = React\.useCallback/);
});

test("the overlay renders dots but never touches game state", () => {
  const overlay = read("src/components/HexMoveAnimation.tsx");

  assert.match(overlay, /requestAnimationFrame\(tick\)/);
  assert.match(overlay, /cancelAnimationFrame\(raf\)/);
  assert.match(overlay, /aria-hidden="true"/);
  assert.match(overlay, /pointer-events-none absolute inset-0 z-20/);
  assert.match(overlay, /buildTroopAnimationPlan\(event\)/);
  assert.match(overlay, /travelPoint\(start, end, easeOut\(progress\), arc\)/);
  assert.match(overlay, /dotFormationPoint\(/);
  assert.match(overlay, /event\.defenderAfter/);
  // No rules, no dispatch, no network: results are read, never produced.
  assert.doesNotMatch(overlay, /dispatch\(|recordMultiplayerAction|fetch\(|resolveAttackOutcome/);
});

test("the page forwards the engine's movement event", () => {
  const page = read("src/app/casino/hex-duel/game/[matchId]/PageClient.tsx");
  assert.match(page, /moveAnimation,/);
  assert.match(page, /troopAnimation=\{moveAnimation\}/);
});

test("the tile can hide its dot layer while the move plays", () => {
  const tile = read("src/components/HexTile.tsx");
  assert.match(tile, /dotsMuted\?: boolean;/);
  assert.match(tile, /troopDots > 0 && !dotsMuted/);
});
