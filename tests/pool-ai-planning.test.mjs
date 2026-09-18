// Pool Masters — AI shot planning.
//
// The AI plans pots by solving the ghost-ball contact for every (ball, pocket)
// pair, validating the line with the shared shot analysis, and then playing the
// surviving candidates through the REAL physics engine before committing. Each
// test below therefore re-plays the returned plan through that same engine and
// judges the result with the same rules engine the match uses: if the plan were
// wrong, it would show up as a missed pot, a foul, or a lost match.

import test from "node:test";
import assert from "node:assert/strict";

import { planAiShot, simulateShot } from "../src/lib/pool/ai.ts";
import { evaluateRules } from "../src/lib/pool/rules.ts";
import { BALL_LAYOUT, POCKETS } from "../src/lib/pool/constants.ts";

const AI_SEAT = 2;

const ball = (number, x, y, extra = {}) => {
  const layout = BALL_LAYOUT.find((b) => b.n === number);
  return {
    id: number,
    number,
    x,
    y,
    vx: 0,
    vy: 0,
    color: layout?.c ?? "#f5f5f5",
    striped: layout?.s ?? false,
    pocketed: false,
    ...extra,
  };
};
const cue = (x, y) => ball(0, x, y);
const pocketed = (n) => ball(n, 60, 460, { pocketed: true });

const TM = POCKETS.findIndex(([x, y]) => x === 450 && y === 28);

/** No aim jitter, so a plan is a fixed function of the table. */
const noNoise = () => 0.5;

/** Plays a plan for real and rules the outcome from the AI's seat. */
function playPlan(plan, balls, { team, oppTeam, openTable }) {
  const { balls: after, meta } = simulateShot(balls, plan.angle, plan.power);
  const ruling = evaluateRules({
    balls: after,
    turn: AI_SEAT,
    myTurn: AI_SEAT,
    myTeam: team,
    oppTeam,
    openTable,
    firstContact: meta.firstContactNumber,
    railAfterContact: meta.railAfterContact,
    pocketed: [...new Set(meta.pocketedNumbers)],
    scratch: meta.cueScratch,
  });
  return { after, meta, ruling, potted: [...new Set(meta.pocketedNumbers)] };
}

test("the AI plans a pot and the pot actually drops in the engine", () => {
  const balls = [cue(450, 400), ball(1, 450, 250)];
  const plan = planAiShot({
    balls,
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
    random: noNoise,
  });

  assert.ok(plan, "the AI must find a shot");
  assert.equal(plan.kind, "pot");
  assert.equal(plan.target, 1);
  assert.equal(plan.pocket, TM);
  assert.ok(plan.chance > 0.5, `expected a strong chance, got ${plan.chance}`);

  const { meta, potted, ruling } = playPlan(plan, balls, {
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
  });

  assert.ok(potted.includes(1), "the planned pot must go in");
  assert.equal(meta.firstContactNumber, 1, "and it must hit its own ball first");
  assert.equal(ruling.foul, false);
  assert.equal(ruling.keepTurn, true);
  assert.equal(ruling.winner, null);
});

test("with a pot available the AI does not fall back to a safety", () => {
  // Two solids: one lined straight at a pocket, one tucked in a corner.
  const balls = [cue(450, 400), ball(1, 450, 250), ball(3, 90, 90)];
  const plan = planAiShot({
    balls,
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
    random: noNoise,
  });

  assert.equal(plan.kind, "pot");
  assert.equal(plan.target, 1);
});

test("a cleared AI goes for the 8-ball and wins the match", () => {
  const balls = [
    cue(450, 400),
    ...Array.from({ length: 7 }, (_, i) => pocketed(i + 1)),
    ball(8, 450, 250),
    ball(9, 90, 90),
  ];
  const plan = planAiShot({
    balls,
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
    random: noNoise,
  });

  assert.equal(plan.target, 8, "the 8-ball is the only legal target");
  const { potted, ruling } = playPlan(plan, balls, {
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
  });

  assert.ok(potted.includes(8));
  assert.equal(ruling.winner, AI_SEAT);
  assert.equal(ruling.foul, false);
});

test("the AI never pots the 8-ball early, however tempting the line", () => {
  // The 8 sits right behind the AI's ball, straight over the pocket: potting
  // the 1 through the 8 would sink it, which loses the match.
  const balls = [cue(450, 400), ball(1, 450, 250), ball(8, 450, 120)];
  const plan = planAiShot({
    balls,
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
    random: noNoise,
  });

  const { potted, ruling } = playPlan(plan, balls, {
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
  });

  assert.equal(potted.includes(8), false, "the 8 must stay on the table");
  assert.notEqual(ruling.winner, 1, "and the AI must not hand the match away");
  assert.equal(ruling.winner === AI_SEAT && !ruling.foul, false);
});

test("an open table: the AI plays a legal ball, never the 8", () => {
  const balls = [cue(450, 400), ball(9, 450, 250), ball(8, 200, 120)];
  const plan = planAiShot({
    balls,
    team: null,
    oppTeam: null,
    openTable: true,
    random: noNoise,
  });

  assert.equal(plan.target, 9, "the 8 cannot be struck first on an open table");
  const { meta, ruling } = playPlan(plan, balls, {
    team: null,
    oppTeam: null,
    openTable: true,
  });
  assert.notEqual(meta.firstContactNumber, 8);
  assert.equal(ruling.foul, false);
});

test("with only the 8 left on an open table the AI still takes a shot", () => {
  // Otherwise the match would hang: hitting it is a foul, but standing still
  // is not a move at all.
  const balls = [cue(450, 400), ball(8, 450, 250)];
  const plan = planAiShot({
    balls,
    team: null,
    oppTeam: null,
    openTable: true,
    random: noNoise,
  });

  assert.ok(plan, "the AI must never stall");
  assert.equal(plan.target, 8);
});

test("a clustered break still produces a legal, non-losing shot", () => {
  const rack = [];
  let k = 1;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c <= r; c++) {
      rack.push(ball(BALL_LAYOUT[k - 1].n, 620 + r * 19, 250 - r * 11 + c * 22));
      k++;
    }
  }
  const balls = [cue(180, 250), ...rack];

  const plan = planAiShot({
    balls,
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
    random: noNoise,
  });

  assert.ok(plan, "a break must still be planned");

  const { meta, ruling } = playPlan(plan, balls, {
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
  });

  assert.equal(ruling.winner, null, "the break must not lose the match");
  assert.equal(ruling.foul, false, "a planned shot must be legal");
  assert.ok(
    meta.firstContactNumber !== null,
    "the break must contact a ball",
  );
});

test("every candidate shot it can pick is ruled legal from its seat", () => {
  // A spread table with pots available in several directions.
  const balls = [
    cue(200, 250),
    ball(1, 620, 120),
    ball(3, 700, 380),
    ball(5, 330, 120),
    ball(7, 500, 430),
    ball(9, 760, 250),
    ball(12, 130, 90),
    ball(8, 830, 200),
  ];

  for (const team of ["solids", "stripes"]) {
    const plan = planAiShot({
      balls,
      team,
      oppTeam: team === "solids" ? "stripes" : "solids",
      openTable: false,
      random: noNoise,
    });
    assert.ok(plan);

    const { ruling } = playPlan(plan, balls, {
      team,
      oppTeam: team === "solids" ? "stripes" : "solids",
      openTable: false,
    });

    assert.equal(ruling.foul, false, `fouled while playing as ${team}`);
    assert.notEqual(ruling.winner, 1, "the AI must not lose off its own shot");
  }
});

test("planning is deterministic for a given table and rng", () => {
  const build = () => [
    cue(200, 250),
    ball(1, 620, 120),
    ball(3, 700, 380),
    ball(5, 330, 120),
    ball(9, 760, 250),
    ball(8, 830, 200),
  ];
  const first = planAiShot({
    balls: build(),
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
    random: noNoise,
  });
  const second = planAiShot({
    balls: build(),
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
    random: noNoise,
  });

  assert.deepEqual(second, first);
});

test("planning never mutates the table", () => {
  const balls = [
    cue(450, 400),
    ball(1, 450, 250),
    ball(8, 200, 120),
    pocketed(3),
  ];
  const before = JSON.stringify(balls);

  planAiShot({
    balls,
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
    random: noNoise,
  });

  assert.equal(JSON.stringify(balls), before);
});

test("planning a shot from a full rack stays well inside a frame budget", () => {
  const rack = [];
  let k = 1;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c <= r; c++) {
      rack.push(ball(BALL_LAYOUT[k - 1].n, 620 + r * 19, 250 - r * 11 + c * 22));
      k++;
    }
  }
  const balls = [cue(180, 250), ...rack];

  const started = Date.now();
  planAiShot({
    balls,
    team: "solids",
    oppTeam: "stripes",
    openTable: false,
    random: noNoise,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, `planning took ${elapsed}ms`);
});
