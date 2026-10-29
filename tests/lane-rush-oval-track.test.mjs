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
import zlib from "node:zlib";

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
  carSpriteBox,
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

test("sprite size grows with the tier and stays off the adjacent lane", () => {
  assert.ok(carSpriteSize(1) < carSpriteSize(2));
  assert.ok(carSpriteSize(2) < carSpriteSize(3));
  assert.ok(carSpriteSize(3) < carSpriteSize(4));
  assert.equal(carSpriteSize(99), CAR_SPRITE_SIZE[1], "an unknown tier keeps Tier 1's size");

  // The width is the car's ACROSS-THE-LANE footprint. Half of it plus the seat
  // offset must stay short of the neighbouring route's centre line, so two
  // route lanes can never paint a car on top of each other.
  //
  // The old contract capped the width at the band itself (`LANE_BAND_WIDTH + 2`)
  // because the sprite was a square dot; a real car is longer than it is wide,
  // so the across-lane width is now led by the artwork's own proportions and the
  // length runs along the lane. The previous floor (`dotRadius(tier) * 2`) is
  // kept: no tier may shrink back to the size of the old dot.
  const lanePitch = LANE_RADII.safe.rx - LANE_RADII.sprint.rx;
  for (const tier of [1, 2, 3, 4]) {
    assert.equal(carSpriteSize(tier), CAR_SPRITE_SIZE[tier]);
    assert.ok(
      carSpriteSize(tier) >= dotRadius(tier) * 2,
      `Tier ${tier} is at least as large as its old dot`,
    );
    assert.ok(
      carSpriteSize(tier) / 2 + SEAT_RADIAL_OFFSET < lanePitch,
      `Tier ${tier} stays clear of the adjacent lane's centre line`,
    );
    // The camera invariant: half a car plus the seat offset still fits INSIDE
    // the painted band, so the widest tier never spills onto the tarmac (or
    // onto the neighbouring route's band) however the car is rotated.
    assert.ok(
      carSpriteSize(tier) / 2 + SEAT_RADIAL_OFFSET <= LANE_BAND_WIDTH / 2,
      `Tier ${tier} stays inside its own lane band`,
    );
  }
});

test("the sprite box follows the artwork's own aspect instead of a square", () => {
  for (const tier of [1, 2, 3, 4]) {
    for (const damaged of [false, true]) {
      const box = carSpriteBox({ tier, damaged });
      const { frame } = carSpriteFor({ tier, damaged });
      assert.equal(box.width, carSpriteSize(tier), `Tier ${tier} boxes share one width`);
      assert.ok(
        Math.abs(box.height - (box.width * frame.height) / frame.width) < 0.11,
        `Tier ${tier}${damaged ? " (damaged)" : ""} preserves the artwork aspect`,
      );
      // A car is roughly twice as long as it is wide — the height may never be
      // collapsed back to a square (or a dot).
      assert.ok(
        box.height > box.width * 1.5,
        `Tier ${tier}${damaged ? " (damaged)" : ""} is a car, not a square`,
      );
    }
  }
  assert.equal(carSpriteBox({ tier: 99 }).width, CAR_SPRITE_SIZE[1], "unknown tiers keep Tier 1");
});

// ── The stored content frames must match the shipped PNGs ──────────────────
//
// The sprite crops the transparent canvas by drawing the asset through a
// viewBox set to its alpha bounding box. If an asset is ever re-rendered, these
// frames silently frame the wrong part of the car, so they are re-measured here
// (PNG → inflate → per-pixel alpha) instead of trusted.
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function alphaBoundingBox(file) {
  const buf = fs.readFileSync(file);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const chunks = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      chunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  assert.equal(bitDepth, 8, `${file} must be 8-bit per channel`);
  const channels = PNG_CHANNELS[colorType];
  assert.ok(channels >= 2, `${file} must carry an alpha channel`);

  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride);
  let rp = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp];
    rp += 1;
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value = (value + a) & 0xff;
      else if (filter === 2) value = (value + b) & 0xff;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) value = (value + paeth(a, b, c)) & 0xff;
      line[x] = value;
    }
    line.copy(pixels, y * stride);
    previous = line;
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[y * stride + x * channels + channels - 1];
      if (alpha > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

test("every sprite's content frame matches the transparent margins of its PNG", () => {
  for (const tier of [1, 2, 3, 4]) {
    for (const damaged of [false, true]) {
      const sprite = carSpriteFor({ tier, damaged });
      const measured = alphaBoundingBox(`public${sprite.src}`);
      for (const edge of ["x", "y", "width", "height"]) {
        assert.ok(
          Math.abs(measured[edge] - sprite.frame[edge]) <= 1,
          `${sprite.src} ${edge}: frame ${sprite.frame[edge]} vs measured ${measured[edge]}`,
        );
      }
      // The crop is what makes the car fill its box: the frame must be a real
      // crop of the canvas, not the whole square.
      assert.ok(
        sprite.frame.width < 256 * 0.75,
        `${sprite.src} must crop its side margins (${sprite.frame.width}px of 256)`,
      );
    }
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

test("cars sharing one route park nose-to-tail instead of stacking", () => {
  // The rules allow four cars on one route. They are real car sprites now, so a
  // fixed fractional grid step would paint them on top of each other; the queue
  // must leave at least a car's half-length either side of each neighbour.
  const fleet = [1, 1, 2, 3].map((tier, index) => ({
    id: `same-${index}`,
    owner: "player1",
    tier,
    status: "racing",
    route: "risk",
  }));
  const cars = gridCars({ myCars: fleet, oppCars: [], mySeat: "player1" });
  assert.equal(cars.length, 4);
  assert.ok(
    cars.every((car) => car.t < 0),
    "the queue stays behind the start line",
  );

  const { rx } = laneRadii("risk", "player1");
  const circumference = 2 * Math.PI * rx;
  for (let i = 1; i < cars.length; i += 1) {
    const gap = (cars[i - 1].t - cars[i].t) * circumference;
    const needed = (carSpriteBox({ tier: cars[i - 1].tier }).height +
      carSpriteBox({ tier: cars[i].tier }).height) /
      2;
    assert.ok(
      gap >= needed,
      `cars ${i - 1}/${i} keep a car's length apart (${gap.toFixed(1)} < ${needed.toFixed(1)})`,
    );
  }

  // Different routes never share a queue: each lane starts at its own slot.
  const mixed = gridCars({
    myCars: [
      { id: "s1", owner: "player1", tier: 1, status: "racing", route: "safe" },
      { id: "s2", owner: "player1", tier: 1, status: "racing", route: "sprint" },
    ],
    mySeat: "player1",
  });
  assert.equal(mixed[0].t, mixed[1].t, "a fresh lane still parks at the line");
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
