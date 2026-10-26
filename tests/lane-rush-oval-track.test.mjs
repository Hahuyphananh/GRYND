/**
 * Lane Rush — oval track geometry + playback projection.
 *
 * The board's positions are one normalized lap progress value, so they can be
 * tested without a browser: these tests pin the shape of the circuit (closed
 * ellipse, clockwise, start/finish on the left), the lane/seat separation that
 * keeps dots readable, and — most importantly — that the playback projection is
 * a pure re-projection of the SERVER's resolved round (finish → the line, DNF →
 * a stall before it) rather than a second, client-side race.
 *
 * Run:  node --import tsx --test tests/lane-rush-oval-track.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  LANE_ORDER,
  LANE_RADII,
  LANE_BAND_WIDTH,
  RIVAL_RADII,
  SEAT_RADIAL_OFFSET,
  TIER_RADIUS,
  TRACK_CENTER,
  buildRacePlayback,
  directionChevrons,
  dotRadius,
  finishLineSegments,
  gridCars,
  gridProgress,
  headingOnLane,
  headingOnRivalRing,
  laneLabelAnchors,
  laneRadii,
  normalizeProgress,
  playbackDurationSeconds,
  pointOnLane,
  pointOnRivalRing,
  stallProgress,
  tierRingInset,
} from "../src/components/lane-rush/ovalGeometry.js";
import {
  CAR_SPRITE_SIZE,
  carSpriteFor,
  carSpriteRotation,
  carSpriteSize,
} from "../src/components/lane-rush/carSprites.js";

const near = (a, b, message) =>
  assert.ok(Math.abs(a - b) < 0.001, `${message} (${a} vs ${b})`);

// ════════════════════════════════════════════════════════════════════
// The circuit
// ════════════════════════════════════════════════════════════════════

test("the start/finish line is the leftmost point and t=0.25 is the top", () => {
  for (const route of LANE_ORDER) {
    for (const seat of ["player1", "player2"]) {
      const { rx, ry } = laneRadii(route, seat);
      const start = pointOnLane({ route, seat, t: 0 });
      near(start.x, TRACK_CENTER.x - rx, `${route}/${seat} starts on the left`);
      near(start.y, TRACK_CENTER.y, `${route}/${seat} starts level with the centre`);

      const top = pointOnLane({ route, seat, t: 0.25 });
      near(top.x, TRACK_CENTER.x, `${route}/${seat} reaches the top at 0.25`);
      near(top.y, TRACK_CENTER.y - ry, `${route}/${seat} reaches the top edge`);

      const right = pointOnLane({ route, seat, t: 0.5 });
      near(right.x, TRACK_CENTER.x + rx, `${route}/${seat} reaches the right at 0.5`);

      // A closed lap: t=1 is exactly the start/finish line again.
      const lap = pointOnLane({ route, seat, t: 1 });
      near(lap.x, start.x, "a full lap returns to the line");
      near(lap.y, start.y, "a full lap returns to the line");
    }
  }
});

test("travel is clockwise: the car climbs the left side before dropping the right", () => {
  const start = pointOnLane({ route: "safe", seat: "player1", t: 0 });
  const early = pointOnLane({ route: "safe", seat: "player1", t: 0.05 });
  const late = pointOnLane({ route: "safe", seat: "player1", t: 0.95 });
  assert.ok(early.y < start.y, "the car leaves the line upward (left side)");
  assert.ok(late.y > start.y, "…and comes back down on the right side");

  // Screen-space headings: right along the top, down the right-hand side.
  near(headingOnLane({ route: "safe", seat: "player1", t: 0.25 }), 0, "top heading is right");
  near(headingOnLane({ route: "safe", seat: "player1", t: 0.5 }), 90, "right heading is down");
  near(headingOnLane({ route: "safe", seat: "player1", t: 0.75 }), 180, "bottom heading is left");
});

test("geometry is deterministic and wraps any progress onto the lap", () => {
  const a = pointOnLane({ route: "sprint", seat: "player2", t: 0.37 });
  const b = pointOnLane({ route: "sprint", seat: "player2", t: 0.37 });
  assert.deepEqual(a, b, "the same input always produces the same position");

  const wrapped = pointOnLane({ route: "sprint", seat: "player2", t: 1.37 });
  near(wrapped.x, a.x, "t=1.37 is one lap plus 0.37");
  near(wrapped.y, a.y, "t=1.37 is one lap plus 0.37");

  const negative = pointOnLane({ route: "sprint", seat: "player2", t: -0.63 });
  near(negative.x, a.x, "negative progress wraps instead of leaving the track");
  near(negative.y, a.y, "negative progress wraps instead of leaving the track");

  assert.equal(normalizeProgress(1), 0);
  assert.equal(normalizeProgress(-0.25), 0.75);
  assert.equal(normalizeProgress(Number.NaN), 0);
  assert.equal(normalizeProgress("nope"), 0);
});

test("bad input can never produce a NaN position", () => {
  for (const route of ["safe", "sprint", "risk", "teleport", undefined, null]) {
    for (const seat of ["player1", "player2", "spectator", undefined]) {
      for (const t of [0, 0.5, -2, 3.2, Number.NaN, undefined]) {
        const point = pointOnLane({ route, seat, t });
        assert.ok(Number.isFinite(point.x), `x finite for ${route}/${seat}/${t}`);
        assert.ok(Number.isFinite(point.y), `y finite for ${route}/${seat}/${t}`);
      }
    }
  }
  const rival = pointOnRivalRing({ seat: "player2", t: -0.02 });
  assert.ok(Number.isFinite(rival.x) && Number.isFinite(rival.y));
});

// ════════════════════════════════════════════════════════════════════
// Lanes, seats and dot size
// ════════════════════════════════════════════════════════════════════

test("the three route lanes are concentric, distinct and in a stable order", () => {
  assert.deepEqual([...LANE_ORDER], ["safe", "sprint", "risk"]);
  const safe = laneRadii("safe");
  const sprint = laneRadii("sprint");
  const risk = laneRadii("risk");
  assert.ok(safe.rx > sprint.rx && sprint.rx > risk.rx, "lanes nest outward → inward");
  assert.ok(safe.ry > sprint.ry && sprint.ry > risk.ry, "lanes nest outward → inward");
  // Gaps are wider than a lane band, so the bands never touch.
  assert.ok(safe.rx - sprint.rx > LANE_BAND_WIDTH * 0.5);
  assert.ok(sprint.rx - risk.rx > LANE_BAND_WIDTH * 0.5);

  for (const route of LANE_ORDER) {
    assert.equal(LANE_RADII[route].rx > 0, true);
  }
});

test("the two seats ride the two halves of one lane band and never coincide", () => {
  for (const route of LANE_ORDER) {
    for (const t of [0, 0.13, 0.5, 0.87]) {
      const p1 = pointOnLane({ route, seat: "player1", t });
      const p2 = pointOnLane({ route, seat: "player2", t });
      const distance = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      assert.ok(
        distance >= SEAT_RADIAL_OFFSET * 1.5,
        `${route}@${t} keeps the seats apart (${distance})`,
      );
    }
  }
  // The radial offset fits inside the band, so neither seat drifts into the
  // neighbouring route.
  assert.ok(SEAT_RADIAL_OFFSET * 2 + 4 < LANE_BAND_WIDTH);
});

test("tier dots grow with the tier and gain rings above Tier 1", () => {
  assert.ok(dotRadius(1) < dotRadius(2));
  assert.ok(dotRadius(2) < dotRadius(3));
  assert.ok(dotRadius(3) < dotRadius(4));
  assert.equal(dotRadius(99), TIER_RADIUS[1], "an unknown tier falls back to Tier 1");
  assert.equal(tierRingInset(1), 0);
  assert.ok(tierRingInset(2) > 0);
  assert.ok(tierRingInset(4) > 0);
});

// ════════════════════════════════════════════════════════════════════
// Car sprites — tier/damage mapping, sizing and orientation
// ════════════════════════════════════════════════════════════════════

test("all four tiers map to their own artwork and damaged variant", () => {
  const expected = {
    1: ["compact.png", "compact-damaged.png"],
    2: ["sport.png", "sport-damaged.png"],
    3: ["supercar.png", "supercar-damaged.png"],
    4: ["hypercar.png", "hypercar-damaged.png"],
  };

  for (const [tier, [intactAsset, damagedAsset]] of Object.entries(expected)) {
    const intact = carSpriteFor({ tier: Number(tier) });
    assert.equal(intact.tier, Number(tier));
    assert.equal(intact.damaged, false, `Tier ${tier} starts undamaged`);
    assert.equal(intact.src, `/images/lane-rush/cars/${intactAsset}`);

    const damaged = carSpriteFor({ tier: Number(tier), damaged: true });
    assert.equal(damaged.damaged, true);
    assert.equal(damaged.src, `/images/lane-rush/cars/${damagedAsset}`);
    assert.notEqual(damaged.src, intact.src, `Tier ${tier} has a distinct damaged asset`);

    // Both files ship with the app; a missing asset is a hard failure.
    assert.ok(fs.existsSync(`public${intact.src}`), `missing public${intact.src}`);
    assert.ok(fs.existsSync(`public${damaged.src}`), `missing public${damaged.src}`);
  }

  const fallback = carSpriteFor({ tier: 99 });
  assert.equal(fallback.tier, 1, "an unknown tier falls back to Tier 1");
  assert.equal(fallback.src, "/images/lane-rush/cars/compact.png");
  assert.equal(carSpriteFor().src, "/images/lane-rush/cars/compact.png");
  assert.equal(
    carSpriteFor({ tier: 3, damaged: true }).name,
    "Supercar",
    "damage never changes the car's identity",
  );
});

test("sprite size grows modestly with the tier and stays inside its lane", () => {
  assert.ok(carSpriteSize(1) < carSpriteSize(2));
  assert.ok(carSpriteSize(2) < carSpriteSize(3));
  assert.ok(carSpriteSize(3) < carSpriteSize(4));
  assert.equal(carSpriteSize(99), CAR_SPRITE_SIZE[1], "an unknown tier keeps Tier 1's size");

  // Half a sprite + the seat offset must stay inside the gap between lanes,
  // so neighbouring route lanes can never overlap even for a Tier 4 car.
  const lanePitch = LANE_RADII.safe.rx - LANE_RADII.sprint.rx;
  for (const tier of [1, 2, 3, 4]) {
    const size = carSpriteSize(tier);
    assert.equal(size, CAR_SPRITE_SIZE[tier]);
    assert.ok(size >= dotRadius(tier) * 2, `Tier ${tier} is at least as large as its old dot`);
    assert.ok(size <= LANE_BAND_WIDTH + 2, `Tier ${tier} fits its lane band`);
    assert.ok(
      size / 2 + SEAT_RADIAL_OFFSET < lanePitch - LANE_BAND_WIDTH / 2,
      `Tier ${tier} stays clear of the adjacent lane`,
    );
  }
});

test("nose-up artwork rotates to the screen-space direction of travel", () => {
  // t=0 is the left edge travelling UP, t=0.25 the top travelling RIGHT.
  near(carSpriteRotation(headingOnLane({ route: "safe", t: 0 })), 0, "left edge faces up");
  near(carSpriteRotation(headingOnLane({ route: "safe", t: 0.25 })), 90, "top faces right");
  near(carSpriteRotation(headingOnLane({ route: "safe", t: 0.5 })), 180, "right edge faces down");
  near(carSpriteRotation(headingOnLane({ route: "risk", t: 0.75 })), 270, "bottom faces left");
  assert.equal(carSpriteRotation(Number.NaN), 90, "a malformed heading falls back to rightwards");
});

// ════════════════════════════════════════════════════════════════════
// The grid
// ════════════════════════════════════════════════════════════════════

test("grid slots sit just BEFORE the start line and never overlap", () => {
  const slots = [
    gridProgress("player1", 0),
    gridProgress("player1", 1),
    gridProgress("player2", 0),
    gridProgress("player2", 1),
  ];
  for (const slot of slots) {
    assert.ok(slot < 0, "a parked car has not started the lap yet");
    assert.ok(slot > -0.1, "the grid stays next to the line");
  }
  assert.equal(new Set(slots).size, slots.length, "every grid slot is distinct");
});

test("the rival ring parks a route-hidden grid outside every lane", () => {
  assert.ok(RIVAL_RADII.rx > LANE_RADII.safe.rx);
  assert.ok(RIVAL_RADII.ry > LANE_RADII.safe.ry);
  const outer = pointOnRivalRing({ seat: "player1", t: 0 });
  const inner = pointOnRivalRing({ seat: "player2", t: 0 });
  near(outer.x, TRACK_CENTER.x - RIVAL_RADII.rx - 8, "Player 1 waits on the outer half");
  near(inner.x, TRACK_CENTER.x - RIVAL_RADII.rx + 8, "Player 2 waits on the inner half");
  assert.ok(inner.x > outer.x, "the two seats never share a rival grid slot");
});

test("the rival grid faces along its own ellipse at every slot", () => {
  for (const seat of ["player1", "player2"]) {
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.98]) {
      const here = pointOnRivalRing({ seat, t });
      const ahead = pointOnRivalRing({ seat, t: t + 0.001 });
      const tangent = (Math.atan2(ahead.y - here.y, ahead.x - here.x) * 180) / Math.PI;
      const heading = headingOnRivalRing({ seat, t });
      // Circular difference: a tangent of -180° and a heading of 180° match.
      const delta = Math.abs(((heading - tangent + 540) % 360) - 180);
      assert.ok(
        delta < 0.6,
        `${seat}@${t} is tangential to the rival ring (${heading} vs ${tangent})`,
      );
    }
  }

  // Cardinal points match the route lanes' convention: clockwise travel.
  near(headingOnRivalRing({ seat: "player1", t: 0 }), -90, "the left slot faces up");
  near(headingOnRivalRing({ seat: "player1", t: 0.25 }), 0, "the top slot faces right");
  near(headingOnRivalRing({ seat: "player1", t: 0.5 }), 90, "the right slot faces down");
  near(headingOnRivalRing({ seat: "player2", t: 0.75 }), 180, "the bottom slot faces left");

  // A parked rival is not left pointing in one fixed direction.
  const headings = [0, 0.25, 0.5, 0.75].map((t) =>
    Math.round(headingOnRivalRing({ seat: "player2", t })),
  );
  assert.equal(new Set(headings).size, headings.length);
});

test("gridCars separates the viewer's routed cars from the hidden rival grid", () => {
  const cars = gridCars({
    mySeat: "player2",
    myCars: [
      { id: "p2-c1", owner: "player2", tier: 2, status: "racing", route: "sprint" },
      { id: "p2-c2", owner: "player2", tier: 1, status: "garage", route: null },
      { id: "p2-c3", owner: "player2", tier: 1, status: "racing", route: "risk" },
    ],
    oppCars: [
      { id: "p1-c1", owner: "player1", tier: 3, status: "racing", route: null },
      { id: "p1-c2", owner: "player1", tier: 1, status: "garage", route: null },
    ],
  });
  const mine = cars.filter((car) => car.mine);
  const theirs = cars.filter((car) => !car.mine);
  assert.equal(mine.length, 2, "only deployed cars reach the grid");
  assert.equal(theirs.length, 1);
  assert.equal(mine[0].route, "sprint");
  assert.equal(mine[0].seat, "player2");
  assert.equal(theirs[0].route, null, "the opponent's route is not invented");
  assert.equal(theirs[0].seat, "player1");
  assert.ok(cars.every((car) => car.t < 0), "every grid car is behind the line");
});

test("a parked car carries its damaged flag to the sprite", () => {
  const cars = gridCars({
    mySeat: "player1",
    myCars: [
      {
        id: "p1-damaged",
        owner: "player1",
        tier: 2,
        status: "racing",
        route: "safe",
        damaged: true,
      },
    ],
  });
  assert.equal(cars.length, 1);
  assert.equal(cars[0].damaged, true, "damage is carried, not inferred from the lane");
  assert.equal(cars[0].tier, 2);
  assert.equal(carSpriteFor({ tier: cars[0].tier, damaged: cars[0].damaged }).tier, 2);
});

// ════════════════════════════════════════════════════════════════════
// Confirmed-result playback
// ════════════════════════════════════════════════════════════════════

const LAST_RESULT = {
  round: 3,
  resolvedAt: "2026-10-20T12:00:00.000Z",
  cars: [
    {
      seat: "player1",
      carId: "p1-c1",
      tier: 3,
      route: "risk",
      roll: 0.42,
      outcome: "finished",
      points: 143,
      reward: { resource: "tech", amount: 1 },
    },
    {
      seat: "player1",
      carId: "p1-c2",
      tier: 1,
      route: "safe",
      roll: 0.01,
      outcome: "dnf",
      points: 0,
      reward: null,
    },
    {
      seat: "player2",
      carId: "p2-c1",
      tier: 2,
      route: "sprint",
      roll: 0.6,
      outcome: "finished",
      points: 42,
      reward: { resource: "fuel", amount: 1 },
    },
  ],
  points: { player1: 143, player2: 42 },
  totals: { player1: 900, player2: 710 },
};

test("playback re-projects the server's round; it does not re-race it", () => {
  const playback = buildRacePlayback(LAST_RESULT);
  assert.equal(playback.round, 3);
  assert.equal(playback.cars.length, 3);
  assert.equal(playback.finished, 2);
  assert.equal(playback.dnf, 1);
  assert.equal(playback.points.player1, 143);
  assert.equal(playback.totals.player2, 710);

  assert.deepEqual(
    playback.cars.map((car) => [car.carId, car.outcome, car.points]),
    [
      ["p1-c1", "finished", 143],
      ["p1-c2", "dnf", 0],
      ["p2-c1", "finished", 42],
    ],
  );
  // The route and seat come straight from the payload.
  assert.equal(playback.cars[0].route, "risk");
  assert.equal(playback.cars[2].seat, "player2");
  assert.deepEqual(playback.cars[0].reward, { resource: "tech", amount: 1 });
});

test("a finished car crosses the line; a DNF stalls before it", () => {
  const playback = buildRacePlayback(LAST_RESULT);
  const finisher = playback.cars[0];
  const dnf = playback.cars[1];
  assert.equal(finisher.to, 1, "a confirmed finish always reaches the line");
  assert.ok(dnf.to > 0.3 && dnf.to < 1, "a DNF stops short of the line");
  assert.equal(dnf.to, stallProgress({ roll: 0.01 }), "the stall is derived from the server roll");

  // Every car starts behind the line and moves forward.
  for (const car of playback.cars) {
    assert.ok(car.from < 0);
    assert.ok(car.to > car.from);
    assert.ok(car.duration > 0.5 && car.duration <= 2.2);
    assert.ok(car.delay >= 0 && car.delay < 0.5);
  }
});

test("a confirmed DNF keeps its outcome and only changes the artwork", () => {
  const playback = buildRacePlayback(LAST_RESULT);
  const dnf = playback.cars.find((car) => car.outcome === "dnf");
  assert.ok(dnf, "the payload's DNF stays a DNF");
  assert.equal(dnf.points, 0);
  assert.equal(dnf.to, stallProgress({ roll: 0.01 }), "the stall still comes from the server roll");
  assert.equal(playback.finished, 2, "a damaged sprite is not a second race outcome");
  assert.equal(playback.dnf, 1);

  // The sprite choice is derived from the confirmed outcome, never the reverse.
  assert.equal(
    carSpriteFor({ tier: dnf.tier, damaged: dnf.outcome === "dnf" }).damaged,
    true,
  );
  assert.equal(
    carSpriteFor({ tier: dnf.tier, damaged: false }).damaged,
    false,
    "an intact car never borrows the damaged asset",
  );
});

test("the same resolved round always animates identically", () => {
  const first = buildRacePlayback(LAST_RESULT);
  const second = buildRacePlayback(JSON.parse(JSON.stringify(LAST_RESULT)));
  assert.deepEqual(first, second);

  // Durations only vary with the server's own roll/tier, within a bound.
  const slow = playbackDurationSeconds({ tier: 1, roll: 0.99, outcome: "finished" });
  const fast = playbackDurationSeconds({ tier: 4, roll: 0, outcome: "finished" });
  assert.ok(slow > fast, "a lower tier / unluckier roll runs longer");
  assert.equal(
    playbackDurationSeconds({ tier: 1, roll: Number.NaN, outcome: "finished" }),
    playbackDurationSeconds({ tier: 1, roll: 0.5, outcome: "finished" }),
    "a malformed roll falls back instead of producing NaN",
  );
});

test("the round playback is null without a resolved round", () => {
  assert.equal(buildRacePlayback(null), null);
  assert.equal(buildRacePlayback(undefined), null);
  assert.equal(buildRacePlayback({ round: 1 }), null);
  const empty = buildRacePlayback({ round: 1, cars: [], points: {}, totals: {} });
  assert.equal(empty.cars.length, 0);
});

// ════════════════════════════════════════════════════════════════════
// Markings
// ════════════════════════════════════════════════════════════════════

test("there is one checkered start/finish segment per route plus the rival ring", () => {
  const segments = finishLineSegments();
  assert.equal(segments.length, LANE_ORDER.length + 1);
  for (const route of LANE_ORDER) {
    const segment = segments.find((entry) => entry.route === route);
    assert.ok(segment, `a finish segment exists for ${route}`);
    near(segment.x, TRACK_CENTER.x - laneRadii(route, "player1").rx, "it sits on the leftmost point");
    near(segment.y, TRACK_CENTER.y, "it crosses the lane at the centre line");
    assert.ok(segment.width > 0 && segment.height > 0);
  }
  const xs = segments.map((segment) => Math.round(segment.x));
  assert.equal(new Set(xs).size, xs.length, "each lane gets its own marking");
});

test("direction chevrons cover every lane and lane labels stay inside the oval", () => {
  const chevrons = directionChevrons();
  assert.equal(chevrons.length, LANE_ORDER.length * 4);
  for (const route of LANE_ORDER) {
    assert.equal(chevrons.filter((chevron) => chevron.route === route).length, 4);
    assert.ok(chevrons.every((chevron) => Number.isFinite(chevron.angle)));
  }
  const labels = laneLabelAnchors();
  assert.deepEqual(labels.map((label) => label.route), [...LANE_ORDER]);
  for (const label of labels) {
    const point = pointOnLane({ route: label.route, seat: "player1", t: 0.75 });
    assert.ok(label.y < point.y, "the caption sits inside its own band");
    assert.ok(label.y > point.y - LANE_BAND_WIDTH - 20);
  }
});

test("floating point positions compare equal within the board's tolerance", () => {
  // A guard against a future refactor introducing an absolute-space mistake
  // (e.g. a radius applied twice) that still looks roughly elliptical.
  const point = pointOnLane({ route: "risk", seat: "player2", t: 0.1 });
  const { rx, ry } = laneRadii("risk", "player2");
  const theta = Math.PI + 0.1 * Math.PI * 2;
  near(point.x, TRACK_CENTER.x + rx * Math.cos(theta), "x is parametric");
  near(point.y, TRACK_CENTER.y + ry * Math.sin(theta), "y is parametric");
});
