// Pool Masters — aim-guide shot readout.
//
// The readout shows the ball the cue ball will hit first, whether that contact
// is legal, and the best pocket line the contacted ball sits on. The contact
// verdict is exact (it calls the same `firstContactFoul` the rules engine rules
// with, so the guide can never contradict the foul it warns about) while the
// pot number is a documented geometry estimate.
//
// Layout note: the table is 900×500 with y growing downward, so POCKETS[1]
// (450, 28) is the TOP-MIDDLE pocket on the canvas.

import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeShot,
  pocketLabel,
  potGeometry,
  potPull,
} from "../src/lib/pool/analysis.ts";
import { drawPotPreview } from "../src/lib/pool/render.ts";
import { evaluateRules, firstContactFoul } from "../src/lib/pool/rules.ts";
import { BALL_LAYOUT, POCKETS } from "../src/lib/pool/constants.ts";

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
const UP = -Math.PI / 2;
const RIGHT = 0;

const TM = POCKETS.findIndex(([x, y]) => x === 450 && y === 28); // top-middle
const BR = POCKETS.findIndex(([x, y]) => x === 866 && y === 466); // bottom-right

test("pocket names follow the orientation the player sees", () => {
  assert.equal(pocketLabel(TM, false), "top-middle");
  assert.equal(pocketLabel(BR, false), "bottom-right");
  // Portrait rotates the canvas 90° clockwise: the canvas' top-middle pocket is
  // the middle of the RIGHT rail on a phone, and the canvas' left column moves
  // to the top row while the right column moves to the bottom row.
  assert.equal(pocketLabel(TM, true), "middle-right");
  assert.equal(pocketLabel(BR, true), "bottom-left");
  assert.equal(pocketLabel(0, true), "top-right"); // canvas top-left
  assert.equal(pocketLabel(3, true), "top-left"); // canvas bottom-left
});

test("straight pot: first contact, legal contact and a strong pocket line", () => {
  const balls = [cue(450, 400), ball(1, 450, 300)];
  const readout = analyzeShot({ balls, aim: UP, team: null, openTable: false });

  assert.equal(readout.firstContact, 1);
  assert.equal(readout.firstContactFoul, null);
  assert.ok(readout.pot, "a pot line must be found");
  assert.equal(readout.pot.ball, 1, "the pot line belongs to the contacted ball");
  assert.equal(readout.pot.pocket, TM);
  assert.equal(readout.pot.pocketLabel, "top-middle");
  assert.equal(readout.pot.blocked, false);
  assert.ok(
    readout.pot.chance > 0.7,
    `a short straight pot should read high, got ${readout.pot.chance}`,
  );
  assert.equal(readout.scratchRisk, false);
});

test("the same pot line is reported rotated, with a rotated pocket name", () => {
  const balls = [cue(450, 400), ball(1, 450, 300)];
  const readout = analyzeShot({
    balls,
    aim: UP,
    team: null,
    openTable: false,
    rotated: true,
  });

  assert.equal(readout.pot?.pocketLabel, "middle-right");
  assert.equal(readout.pot?.blocked, false);
});

test("a ball on the object line blocks the pot", () => {
  const balls = [cue(450, 400), ball(1, 450, 300), ball(2, 450, 200)];
  const readout = analyzeShot({ balls, aim: UP, team: null, openTable: false });

  assert.equal(readout.firstContact, 1, "the blocker is behind the first contact");
  assert.ok(readout.pot);
  assert.equal(readout.pot.blocked, true);
  assert.equal(readout.pot.chance, 0);
});

test("thin cuts read lower than straight shots", () => {
  const straight = analyzeShot({
    balls: [cue(450, 400), ball(1, 450, 300)],
    aim: UP,
    team: null,
    openTable: false,
  });
  // Same ball and pocket, but approached from wide left: the object ball is
  // still sent up at the pocket, only off a much thinner contact. The ghost
  // point that sends the 1 at the top-middle pocket is (450, 322).
  const cut = analyzeShot({
    balls: [cue(300, 375), ball(1, 450, 300)],
    aim: Math.atan2(322 - 375, 450 - 300),
    team: null,
    openTable: false,
  });

  assert.equal(cut.firstContact, 1);
  assert.ok(cut.pot, "the cut still lines the 1 up");
  assert.equal(cut.pot.pocket, TM);
  assert.ok(
    cut.pot.chance < straight.pot.chance,
    `cut ${cut.pot.chance} must read lower than straight ${straight.pot.chance}`,
  );
  assert.ok(cut.pot.chance > 0, "a makeable cut must not read as impossible");
});

test("a full-ball hit along the open table reports no pocket line", () => {
  const balls = [cue(300, 300), ball(1, 450, 300)];
  const readout = analyzeShot({ balls, aim: RIGHT, team: null, openTable: false });

  assert.equal(readout.firstContact, 1);
  assert.equal(readout.pot, null, "nothing is lined up with a pocket");
});

test("no object ball in the line: cushion contact and the matching foul", () => {
  const balls = [cue(450, 400), ball(1, 200, 100)];
  const readout = analyzeShot({ balls, aim: UP, team: null, openTable: false });

  assert.equal(readout.firstContact, null);
  assert.equal(
    readout.firstContactFoul,
    "Foul: cue ball did not contact an object ball.",
  );
  assert.equal(readout.pot, null);
});

test("wrong group first is flagged while group balls remain", () => {
  const balls = [cue(450, 400), ball(9, 450, 300), ball(1, 200, 100)];
  const readout = analyzeShot({
    balls,
    aim: UP,
    team: "solids",
    openTable: false,
  });

  assert.equal(readout.firstContact, 9);
  assert.equal(readout.firstContactFoul, "Foul: wrong ball hit first.");
});

test("a cleared shooter is flagged legal — the removed 8-ball foul", () => {
  const balls = [cue(450, 400), ball(9, 450, 300)];
  for (let n = 1; n <= 7; n++) balls.push(ball(n, 200, 100 + n * 20, { pocketed: true }));

  const readout = analyzeShot({
    balls,
    aim: UP,
    team: "solids",
    openTable: false,
  });

  assert.equal(readout.firstContact, 9);
  assert.equal(readout.firstContactFoul, null);
  // …and the ruling itself agrees with the guide.
  const ruling = evaluateRules({
    balls,
    turn: 1,
    myTurn: 1,
    myTeam: "solids",
    oppTeam: "stripes",
    openTable: false,
    firstContact: readout.firstContact,
    railAfterContact: true,
    pocketed: [],
    scratch: false,
  });
  assert.equal(ruling.foul, false);
  assert.equal(ruling.foulMessage, null);
});

test("open table: striking the 8 first is flagged", () => {
  const balls = [cue(450, 400), ball(8, 450, 300)];
  const readout = analyzeShot({
    balls,
    aim: UP,
    team: null,
    openTable: true,
  });

  assert.equal(readout.firstContact, 8);
  assert.match(readout.firstContactFoul, /open table/i);
});

test("the readout reuses the rules helper, so guide and ruling never disagree", () => {
  for (const team of [null, "solids", "stripes"]) {
    for (const openTable of [true, false]) {
      for (const firstContact of [null, 1, 8, 9]) {
        const balls = [cue(450, 400), ball(1, 100, 100), ball(8, 120, 100), ball(9, 140, 100)];
        const shared = firstContactFoul({ balls, team, openTable, firstContact });
        const ruling = evaluateRules({
          balls,
          turn: 1,
          myTurn: 1,
          myTeam: team,
          oppTeam: team === "solids" ? "stripes" : "solids",
          openTable,
          firstContact,
          railAfterContact: true,
          pocketed: [],
          scratch: false,
        });
        assert.equal(
          shared,
          ruling.foulMessage,
          `firstContact=${firstContact} team=${team} open=${openTable}`,
        );
      }
    }
  }
});

test("scratch risk is flagged when the cue ball's own line reaches a pocket", () => {
  const open = analyzeShot({
    balls: [cue(450, 200)],
    aim: UP,
    team: null,
    openTable: false,
  });
  // A ball close enough to be struck first stops the readout worrying about the
  // pocket sitting beyond it.
  const blocked = analyzeShot({
    balls: [cue(450, 200), ball(1, 450, 100)],
    aim: UP,
    team: null,
    openTable: false,
  });

  assert.equal(open.scratchRisk, true);
  assert.equal(blocked.scratchRisk, false);
});

test("the pot chance reacts to how hard the shot is pulled", () => {
  const spawn = () => [cue(450, 400), ball(1, 450, 250)];
  const geometry = potGeometry(spawn()[0], spawn()[1], TM);
  assert.ok(geometry, "the ghost point must exist");
  const needed = potPull(geometry.cueDist, geometry.objDist, geometry.cutCos);

  const aimless = analyzeShot({
    balls: spawn(),
    aim: -Math.PI / 2,
    team: null,
    openTable: false,
  });
  const charged = analyzeShot({
    balls: spawn(),
    aim: -Math.PI / 2,
    team: null,
    openTable: false,
    pull: needed,
  });
  const feather = analyzeShot({
    balls: spawn(),
    aim: -Math.PI / 2,
    team: null,
    openTable: false,
    pull: 12,
  });

  // With the pace the plan asks for, the line is as good as its geometry.
  assert.ok(
    charged.pot.chance > 0.7,
    `no pace penalty at the required pull, got ${charged.pot.chance}`,
  );
  assert.ok(
    charged.pot.chance <= aimless.pot.chance + 1e-9,
    "pace can only ever make a pot harder",
  );
  // A tap cannot carry the object ball anywhere near the pocket.
  assert.equal(feather.pot.chance, 0, "a 12-pull cannot reach the pocket");
  assert.equal(
    analyzeShot({
      balls: spawn(),
      aim: -Math.PI / 2,
      team: null,
      openTable: false,
      pull: 0,
    }).pot.chance,
    aimless.pot.chance,
    "an uncharged shot carries no pace information",
  );
});

test("drawPotPreview paints the line and the pocket, and skips a missing pot", () => {
  const calls = [];
  const ctx = {
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    moveTo: (x, y) => calls.push(["moveTo", x, y]),
    lineTo: (x, y) => calls.push(["lineTo", x, y]),
    arc: (x, y, r) => calls.push(["arc", x, y, r]),
    stroke: () => calls.push("stroke"),
    setLineDash: (d) => calls.push(["setLineDash", d.length]),
    lineWidth: 1,
    strokeStyle: "",
    globalAlpha: 1,
    lineCap: "round",
  };
  const balls = [ball(1, 450, 250)];

  drawPotPreview(ctx, balls, { ball: 1, pocket: TM, chance: 0.8, blocked: false });

  const line = calls.find((c) => Array.isArray(c) && c[0] === "moveTo");
  assert.ok(line, "the line must start at the ball");
  assert.equal(line[1], 450);
  assert.equal(line[2], 250);
  assert.ok(
    calls.some((c) => Array.isArray(c) && c[0] === "lineTo" && c[1] === 450 && c[2] === 28),
    "and end at the pocket centre",
  );
  assert.ok(calls.includes("stroke"), "and be stroked");

  const quiet = [];
  const silent = { ...ctx, stroke: () => quiet.push("stroke") };
  drawPotPreview(silent, balls, null);
  drawPotPreview(silent, balls, { ball: 99, pocket: TM, chance: 1, blocked: false });
  assert.equal(quiet.length, 0, "nothing to draw means nothing is drawn");
});

test("analysis never mutates the table", () => {
  const balls = [
    cue(450, 400),
    ball(1, 450, 300),
    ball(2, 450, 200, { pocketed: true }),
  ];
  const before = JSON.stringify(balls);

  analyzeShot({ balls, aim: UP, team: "solids", openTable: false, rotated: true });

  assert.equal(JSON.stringify(balls), before);
});
