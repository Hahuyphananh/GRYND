// Pool Masters — precision physics + the 8-ball foul change.
//
// Two things are pinned here:
//
//  1. PHYSICS PRECISION. Velocities are table units per 60 Hz tick and a
//     full-power shot moves a ball ~25 units — further than a ball diameter.
//     Integrating that as one jump per tick let fast balls tunnel through each
//     other and skip the pocket mouths (the rail clamp then bounced the ball
//     back out, so pots "didn't go in"). Every tick is now substepped, so
//     contact and pot capture happen against positions the ball really crosses.
//
//  2. RULES. A shooter who has cleared their whole group is on the 8-ball and
//     their first contact is unrestricted — the "hit your group before shooting
//     the 8-ball" foul is gone. Everything else (wrong group first while balls
//     remain, scratch, no rail / no pot, 8-ball on an open table) still fouls.

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyShotPower,
  isMoving,
  tickPhysics,
} from "../src/lib/pool/physics.ts";
import { evaluateRules } from "../src/lib/pool/rules.ts";
import {
  BALL_R,
  FRICTION,
  MAX_PULL,
  POCKET_R,
  RAIL,
  TABLE_H,
  TABLE_W,
} from "../src/lib/pool/constants.ts";

const ball = (number, x, y, vx = 0, vy = 0, extra = {}) => ({
  id: number,
  number,
  x,
  y,
  vx,
  vy,
  color: "#fff",
  striped: number >= 9,
  pocketed: false,
  ...extra,
});

const freshMeta = () => ({
  firstContactNumber: null,
  railAfterContact: false,
  pocketedNumbers: [],
  cueScratch: false,
});

/** Runs physics ticks until the table settles (or `max` ticks elapse). */
const settle = (balls, meta, max = 4000) => {
  let ticks = 0;
  while (ticks < max && isMoving(balls)) {
    tickPhysics(balls, meta);
    ticks++;
  }
  return ticks;
};

const inBounds = (b) =>
  b.x >= RAIL + BALL_R - 0.001 &&
  b.x <= TABLE_W - RAIL - BALL_R + 0.001 &&
  b.y >= RAIL + BALL_R - 0.001 &&
  b.y <= TABLE_H - RAIL - BALL_R + 0.001;

// ───────────────────────────── physics: precision ─────────────────────────────

test("a full-power ball cannot tunnel through an object ball it flies past", () => {
  // 25 units of travel in one tick: the cue ball jumps from 400 to 425 and
  // lands 22.1 units past a ball it should have hit at 403.
  const cue = ball(0, 400, 250, 25, 0);
  const object = ball(1, 403, 250);
  const balls = [cue, object];
  const meta = freshMeta();

  tickPhysics(balls, meta);

  assert.equal(meta.firstContactNumber, 1, "the cue ball must touch the ball in its path");
  assert.ok(object.vx > 0, "the struck ball must be pushed forward");
  assert.ok(cue.vx < 25, "the cue ball must lose speed in the contact");
});

test("a shot into a corner pocket drops instead of bouncing off the rail", () => {
  const cue = ball(0, 200, 200, -17.6, -17.6); // straight at the (34,34) pocket
  const meta = freshMeta();

  // Roll all the way in: it reaches the pocket mouth after ~14 ticks, and the
  // old coarse integration (17.6 units per tick) jumped over the mouth and
  // returned a rail bounce instead of a pot.
  for (let i = 0; i < 40 && !cue.pocketed; i++) tickPhysics([cue], meta);

  assert.equal(cue.pocketed, true, "the ball must be swallowed by the pocket");
  assert.equal(meta.cueScratch, true, "a potted cue ball is a scratch");
});

test("a ball rolled over a middle pocket mouth is potted exactly once", () => {
  // Resting on the rail line, 25 units above the (450,28) pocket centre.
  const object = ball(1, 450, RAIL + BALL_R, 0, -6);
  const meta = freshMeta();

  tickPhysics([object], meta);

  assert.equal(object.pocketed || object.animatingPocket, true, "the ball drops");
  assert.equal(meta.pocketedNumbers.length, 1);
  assert.deepEqual(meta.pocketedNumbers, [1], "a pot is recorded once, not per substep");

  settle([object], meta, 20);
  assert.equal(object.pocketed, true, "the pot animation finishes");
});

test("a ball passing NEAR a pocket mouth is not swallowed", () => {
  // 34 units from the pocket centre — clear of the POCKET_R mouth, and rolling
  // across the table rather than into it.
  const object = ball(1, 450, 28 + POCKET_R + 4, 6, 0);
  const startX = object.x;
  const meta = freshMeta();

  settle([object], meta, 40);

  assert.equal(object.pocketed, false);
  assert.equal(object.animatingPocket, undefined);
  assert.equal(meta.pocketedNumbers.length, 0);
  assert.ok(object.x > startX, "the ball keeps rolling across the table");
});

test("a ball rolling back OUT of a pocket mouth keeps rolling", () => {
  // Sitting in the jaws (33.5 units from the pocket centre, inside the old
  // permissive capture radius) but travelling away from the hole.
  const object = ball(1, 440, 60, -6, 0);
  const meta = freshMeta();

  settle([object], meta, 40);

  assert.equal(object.pocketed, false, "a ball leaving the jaws must not drop");
  assert.equal(object.animatingPocket, undefined);
  assert.equal(meta.pocketedNumbers.length, 0);
});

test("a ball still heading into the jaws drops", () => {
  // Same spot, opposite direction: the ball edge is over the mouth.
  const object = ball(1, 428, 60, 6, -2);
  const meta = freshMeta();

  settle([object], meta, 40);

  assert.equal(object.pocketed, true);
  assert.deepEqual(meta.pocketedNumbers, [1]);
});

test("impact speed decays by exactly one tick of friction (rollout unchanged)", () => {
  const cue = ball(0, 450, 250, 20, 0);
  const meta = freshMeta();

  tickPhysics([cue], meta);

  assert.ok(
    Math.abs(cue.vx - 20 * FRICTION) < 0.001,
    `expected ${20 * FRICTION}, got ${cue.vx}`,
  );
});

test("a hard rail shot stays inside the table and settles", () => {
  const cue = ball(0, 450, 250, -applyShotPower(MAX_PULL), 7);
  const meta = freshMeta();

  const ticks = settle([cue], meta, 4000);

  assert.ok(ticks < 4000, "the table must come to rest");
  assert.equal(isMoving([cue]), false);
  assert.ok(
    cue.pocketed || inBounds(cue),
    `ball escaped the table at (${cue.x}, ${cue.y})`,
  );
  assert.equal(meta.railAfterContact, true);
});

test("a rack of balls resolves without tunnelling, escaping, or jitter", () => {
  const cue = ball(0, 180, 250);
  cue.vx = applyShotPower(MAX_PULL);
  const rack = [];
  const start = new Map();
  let k = 1;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c <= r; c++) {
      const b = ball(k, 620 + r * 19, 250 - r * 11 + c * 22);
      rack.push(b);
      start.set(k, { x: b.x, y: b.y });
      k++;
    }
  }
  const balls = [cue, ...rack];
  const meta = freshMeta();

  const ticks = settle(balls, meta, 4000);

  assert.ok(ticks < 4000, "the rack must settle");
  assert.equal(meta.firstContactNumber, 1, "the break must contact the rack");
  for (const b of balls) {
    assert.ok(
      b.pocketed || inBounds(b),
      `ball ${b.number} escaped at (${b.x}, ${b.y})`,
    );
    assert.equal(b.vx, 0, `ball ${b.number} still sliding in x`);
    assert.equal(b.vy, 0, `ball ${b.number} still sliding in y`);
  }
  // A tunnelled contact would leave the rack stacked where it started.
  assert.ok(
    rack.some((b) => {
      const from = start.get(b.number);
      return b.pocketed || Math.hypot(b.x - from.x, b.y - from.y) > 1;
    }),
    "the rack must actually break apart",
  );
});

// ───────────────────────────── rules: the 8-ball foul ─────────────────────────

const solids = (pocketedNumbers) => {
  const balls = [ball(0, 180, 250)];
  for (let n = 1; n <= 7; n++) balls.push(ball(n, 600, 100 + n * 10, 0, 0, { pocketed: pocketedNumbers.includes(n) }));
  balls.push(ball(8, 700, 250));
  for (let n = 9; n <= 15; n++) balls.push(ball(n, 500, 60 + n * 10));
  return balls;
};

const clearedTable = () => solids([1, 2, 3, 4, 5, 6, 7]);

test("cleared shooter: hitting the 8-ball first is legal and wins", () => {
  const res = evaluateRules({
    balls: clearedTable(),
    turn: 1,
    myTurn: 1,
    myTeam: "solids",
    oppTeam: "stripes",
    openTable: false,
    firstContact: 8,
    railAfterContact: false,
    pocketed: [8],
    scratch: false,
  });

  assert.equal(res.foul, false);
  assert.equal(res.foulMessage, null);
  assert.equal(res.winner, 1, "clearing your group then potting the 8 wins");
});

test("cleared shooter: hitting an opponent ball first is no longer a foul", () => {
  const res = evaluateRules({
    balls: clearedTable(),
    turn: 1,
    myTurn: 1,
    myTeam: "solids",
    oppTeam: "stripes",
    openTable: false,
    firstContact: 9,
    railAfterContact: false,
    pocketed: [8],
    scratch: false,
  });

  assert.equal(res.foul, false, "the removed 'hit your group before the 8-ball' foul");
  assert.equal(res.foulMessage, null);
  assert.equal(res.winner, 1, "the 8 still counts when the group is cleared");
});

test("cleared shooter: pointing at the group ball on the table is not required (no group left)", () => {
  // Same shape as the old bug report: the player is on the 8-ball and the
  // ruler used to demand a group ball first. Any object ball is fine now.
  for (const firstContact of [1, 9, 15]) {
    const balls = clearedTable();
    const res = evaluateRules({
      balls,
      turn: 1,
      myTurn: 1,
      myTeam: "solids",
      oppTeam: "stripes",
      openTable: false,
      firstContact,
      railAfterContact: true,
      pocketed: [],
      scratch: false,
    });
    assert.equal(res.foul, false, `first contact ${firstContact} must be legal`);
  }
});

test("cleared shooter still fouls on a scratch (and loses an early 8)", () => {
  const res = evaluateRules({
    balls: clearedTable(),
    turn: 1,
    myTurn: 1,
    myTeam: "solids",
    oppTeam: "stripes",
    openTable: false,
    firstContact: 8,
    railAfterContact: false,
    pocketed: [8],
    scratch: true,
  });

  assert.equal(res.foul, true);
  assert.match(res.foulMessage, /scratch/i);
  assert.equal(res.winner, 2, "potting the 8 on a foul loses");
  assert.equal(res.ballInHand, true);
});

test("cleared shooter who pots nothing and hits no rail still fouls", () => {
  const res = evaluateRules({
    balls: clearedTable(),
    turn: 1,
    myTurn: 1,
    myTeam: "solids",
    oppTeam: "stripes",
    openTable: false,
    firstContact: 9,
    railAfterContact: false,
    pocketed: [],
    scratch: false,
  });

  assert.equal(res.foul, true);
  assert.match(res.foulMessage, /no ball was pocketed and no ball reached a rail/i);
  assert.equal(res.nextTurn, 2);
});

test("shooter with group balls left: hitting a wrong ball first still fouls", () => {
  const res = evaluateRules({
    balls: solids([1, 2, 3]), // 4..7 still on the table
    turn: 1,
    myTurn: 1,
    myTeam: "solids",
    oppTeam: "stripes",
    openTable: false,
    firstContact: 9,
    railAfterContact: true,
    pocketed: [],
    scratch: false,
  });

  assert.equal(res.foul, true);
  assert.equal(res.foulMessage, "Foul: wrong ball hit first.");
  assert.equal(res.nextTurn, 2);
});

test("shooter with group balls left: the 8-ball struck first is still a foul", () => {
  const res = evaluateRules({
    balls: solids([1, 2, 3]),
    turn: 1,
    myTurn: 1,
    myTeam: "solids",
    oppTeam: "stripes",
    openTable: false,
    firstContact: 8,
    railAfterContact: true,
    pocketed: [],
    scratch: false,
  });

  assert.equal(res.foul, true, "clearing the group is still required before the 8");
  assert.equal(res.foulMessage, "Foul: wrong ball hit first.");
});

test("an object ball still ON the table means the shooter is not cleared", () => {
  // The group is one ball short of cleared — so first contact is restricted
  // again, even though the shooter pockets a stripe on the same shot.
  const balls = solids([1, 2, 3, 4, 5, 6]); // the 7 is still out there
  const res = evaluateRules({
    balls,
    turn: 1,
    myTurn: 1,
    myTeam: "solids",
    oppTeam: "stripes",
    openTable: false,
    firstContact: 9,
    railAfterContact: true,
    pocketed: [9],
    scratch: false,
  });

  assert.equal(res.foul, true);
  assert.equal(res.nextTurn, 2);
});

test("open table: the 8-ball cannot be struck first", () => {
  const res = evaluateRules({
    balls: solids([]),
    turn: 1,
    myTurn: 1,
    myTeam: null,
    oppTeam: null,
    openTable: true,
    firstContact: 8,
    railAfterContact: true,
    pocketed: [],
    scratch: false,
  });

  assert.equal(res.foul, true);
  assert.match(res.foulMessage, /open table/i);
});

test("second seat reads the same rules from its own perspective", () => {
  const res = evaluateRules({
    balls: solids([1, 2, 3, 4, 5, 6, 7]),
    turn: 2,
    myTurn: 1, // this client is seat 1, so seat 2 shoots with the stripes
    myTeam: "solids",
    oppTeam: "stripes",
    openTable: false,
    firstContact: 9, // legal: it is seat 2's own group
    railAfterContact: true,
    pocketed: [8],
    scratch: false,
  });

  assert.equal(res.foul, false);
  assert.equal(res.winner, 1, "seat 2 potting the 8 before clearing stripes loses");
});
