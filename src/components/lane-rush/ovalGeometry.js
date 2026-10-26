// src/components/lane-rush/ovalGeometry.js
//
// PURE GEOMETRY for the Lane Rush oval racetrack.
//
// The track is one closed ellipse per route, drawn as a band around the same
// centre. A car's position is a SINGLE NORMALIZED number — its lap progress
// `t` in [0, 1) — so the board, the animation and the server's resolved round
// all speak the same coordinates:
//
//   * t = 0      → the start/finish line (the leftmost point of the ellipse);
//   * t = 0.25   → the top of the oval;
//   * t = 1      → one full clockwise lap, back on the finish line.
//
// Increasing `t` travels CLOCKWISE on screen. Nothing here reads a clock, a
// random value or a game result: `buildRacePlayback` only re-projects the
// round the SERVER already resolved (route, seat, tier, outcome) into the
// start/end progress of a presentation animation. DNF stall points use the
// server's own roll, so the same payload always replays identically.
//
// This module has no React/DOM dependency on purpose: the ellipse maths is
// unit-tested (tests/lane-rush-oval-track.test.mjs) without a browser.

export const TRACK_VIEWBOX = Object.freeze({ width: 800, height: 504 });
export const TRACK_CENTER = Object.freeze({ x: 400, y: 252 });

/** Width of one route's band, in viewBox units. */
export const LANE_BAND_WIDTH = 34;

/** Route lanes, outermost first. Three concentric lanes = three route choices. */
export const LANE_ORDER = Object.freeze(["safe", "sprint", "risk"]);

/**
 * Ellipse radii per route lane. The three lanes share a centre, so a route
 * choice is a real, visible line around the SAME circuit — not a straight
 * track that pretends to be a different course.
 */
export const LANE_RADII = Object.freeze({
  safe: Object.freeze({ rx: 318, ry: 180 }),
  sprint: Object.freeze({ rx: 274, ry: 142 }),
  risk: Object.freeze({ rx: 230, ry: 104 }),
});

/** The thin dashed ring the opponent's (route-hidden) grid sits on. */
export const RIVAL_RADII = Object.freeze({ rx: 368, ry: 222 });

/**
 * The two seats share a lane band: player 1 rides the outer half, player 2 the
 * inner half, so two cars on the same route never sit on top of each other.
 */
export const SEAT_RADIAL_OFFSET = 6.5;

/** Dot radius per car tier — the primary tier cue (rings are added on top). */
export const TIER_RADIUS = Object.freeze({ 1: 7, 2: 9, 3: 11, 4: 13 });

/** How far inside the dot edge the first tier ring is drawn (0 = no ring). */
export function tierRingInset(tier) {
  return tier >= 2 ? 2.2 : 0;
}

export function dotRadius(tier) {
  const value = Number(tier);
  return TIER_RADIUS[value] ?? TIER_RADIUS[1];
}

/** Seat colours are the rulebook's: player 1 blue, player 2 red. */
export const SEAT_COLORS = Object.freeze({
  player1: Object.freeze({
    dot: "#38bdf8",
    edge: "#e0f2fe",
    glow: "rgba(56,189,248,0.65)",
  }),
  player2: Object.freeze({
    dot: "#fb7185",
    edge: "#ffe4e6",
    glow: "rgba(251,113,133,0.65)",
  }),
});

export const ROUTE_COLORS = Object.freeze({
  safe: { stroke: "#34d399", soft: "rgba(52,211,153,0.16)", text: "#a7f3d0" },
  sprint: { stroke: "#38bdf8", soft: "rgba(56,189,248,0.16)", text: "#bae6fd" },
  risk: { stroke: "#fbbf24", soft: "rgba(251,191,36,0.16)", text: "#fde68a" },
});

/** Normalize any progress onto [0, 1). */
export function normalizeProgress(t) {
  const value = Number(t);
  if (!Number.isFinite(value)) return 0;
  return ((value % 1) + 1) % 1;
}

/** Radii for one route + seat. Unknown routes fall back to the Safe lane. */
export function laneRadii(route, seat = "player1") {
  const base = LANE_RADII[route] || LANE_RADII.safe;
  const offset = seat === "player2" ? -SEAT_RADIAL_OFFSET : SEAT_RADIAL_OFFSET;
  return { rx: base.rx + offset, ry: base.ry + offset };
}

/**
 * The normalized lap progress a car occupies while it is parked on the grid.
 * Grid slots sit just BEFORE the start/finish line, so a deployed car has not
 * "started" until the server resolves the round and the animation moves it.
 */
export function gridProgress(seat = "player1", index = 0) {
  const slot = Math.max(0, Math.floor(Number(index) || 0));
  const seatLag = seat === "player2" ? 0.006 : 0;
  return -(0.004 + seatLag + slot * 0.011);
}

function polar(x, y, theta) {
  return { x, y, theta };
}

/**
 * Point on one route lane at normalized lap progress `t`.
 *
 * `radialOffset` nudges the car across the lane band (never along it), so two
 * cars on the same route and seat stay readable without implying a different
 * position on the circuit.
 */
export function pointOnLane({
  route = "safe",
  seat = "player1",
  t = 0,
  radialOffset = 0,
} = {}) {
  const lane = laneRadii(route, seat);
  const shift = Number.isFinite(Number(radialOffset)) ? Number(radialOffset) : 0;
  const rx = lane.rx + shift;
  const ry = lane.ry + shift;
  const theta = Math.PI + normalizeProgress(t) * Math.PI * 2;
  return polar(
    TRACK_CENTER.x + rx * Math.cos(theta),
    TRACK_CENTER.y + ry * Math.sin(theta),
    theta,
  );
}

/** Point on the (route-hidden) rival grid ring. */
export function pointOnRivalRing({ seat = "player2", t = 0 } = {}) {
  const inset = seat === "player2" ? -8 : 8;
  const rx = RIVAL_RADII.rx + inset;
  const ry = RIVAL_RADII.ry + inset;
  const theta = Math.PI + normalizeProgress(t) * Math.PI * 2;
  return polar(
    TRACK_CENTER.x + rx * Math.cos(theta),
    TRACK_CENTER.y + ry * Math.sin(theta),
    theta,
  );
}

/** Screen-space tangent (degrees, clockwise) of an ellipse at `theta`. */
function ellipseHeading(rx, ry, theta) {
  const dx = -rx * Math.sin(theta);
  const dy = ry * Math.cos(theta);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Screen-space heading (degrees) of travel at progress `t`. */
export function headingOnLane({ route = "safe", seat = "player1", t = 0 } = {}) {
  const { rx, ry } = laneRadii(route, seat);
  const theta = Math.PI + normalizeProgress(t) * Math.PI * 2;
  return ellipseHeading(rx, ry, theta);
}

/**
 * Screen-space heading (degrees) on the (route-hidden) rival grid ring. The
 * grid is its own ellipse, so a parked rival car still faces along its ring
 * instead of a fixed direction.
 */
export function headingOnRivalRing({ seat = "player2", t = 0 } = {}) {
  const inset = seat === "player2" ? -8 : 8;
  const rx = RIVAL_RADII.rx + inset;
  const ry = RIVAL_RADII.ry + inset;
  const theta = Math.PI + normalizeProgress(t) * Math.PI * 2;
  return ellipseHeading(rx, ry, theta);
}

/** Where a DNF stops: deterministic from the server's authoritative roll. */
export function stallProgress(car = {}) {
  const roll = Number(car.roll);
  const safeRoll = Number.isFinite(roll) ? Math.min(0.999, Math.max(0, roll)) : 0.5;
  return 0.34 + safeRoll * 0.42;
}

/**
 * Presentation pacing for one resolved car. The roll makes the variance
 * deterministic (the same payload animates the same way); duration never
 * changes WHO finished — the outcome comes from the server.
 */
export function playbackDurationSeconds(car = {}) {
  const tier = Number(car.tier) || 1;
  const roll = Number(car.roll);
  const safeRoll = Number.isFinite(roll) ? roll : 0.5;
  const base = 1.7 - tier * 0.13 + safeRoll * 0.35;
  const duration = car.outcome === "dnf" ? base * 0.8 : base;
  return Math.round(Math.max(0.8, Math.min(2.2, duration)) * 100) / 100;
}

/**
 * Project a resolved round (the server's `lastResult`) into track animation
 * descriptors. Every field is copied from the payload; this adds only the
 * from/to lap progress and a deterministic duration.
 */
export function buildRacePlayback(lastResult) {
  if (!lastResult || !Array.isArray(lastResult.cars)) return null;
  const perSeatIndex = { player1: 0, player2: 0 };
  const cars = lastResult.cars.map((car, i) => {
    const seat = car.seat === "player2" ? "player2" : "player1";
    const index = perSeatIndex[seat]++;
    const dnf = car.outcome === "dnf";
    return {
      key: `r${lastResult.round}:${car.carId}`,
      round: Number(lastResult.round) || 0,
      carId: String(car.carId || ""),
      seat,
      tier: Number(car.tier) || 1,
      route: car.route || "safe",
      outcome: dnf ? "dnf" : "finished",
      points: Number(car.points) || 0,
      reward: car.reward ?? null,
      from: gridProgress(seat, index),
      to: dnf ? stallProgress(car) : 1,
      // Spread same-lane cars across the band (not along it).
      radialOffset: (index - 1.5) * 2.2,
      duration: playbackDurationSeconds(car),
      delay: Math.min(0.28, i * 0.04),
    };
  });
  return {
    round: Number(lastResult.round) || 0,
    cars,
    points: lastResult.points ?? { player1: 0, player2: 0 },
    totals: lastResult.totals ?? { player1: 0, player2: 0 },
    finished: cars.filter((car) => car.outcome === "finished").length,
    dnf: cars.filter((car) => car.outcome === "dnf").length,
  };
}

/**
 * Cars currently on the start grid, ordered deterministically (seat, then car
 * order) so a reconnect reconstructs the same picture.
 */
export function gridCars({ myCars = [], oppCars = [], mySeat = "player1" } = {}) {
  const seatOf = (car, fallback) => (car.owner === "player1" || car.owner === "player2" ? car.owner : fallback);
  const mine = (Array.isArray(myCars) ? myCars : []).filter((car) => car.status === "racing");
  const theirs = (Array.isArray(oppCars) ? oppCars : []).filter((car) => car.status === "racing");
  const out = [];
  mine.forEach((car, index) => {
    out.push({
      key: `grid:${car.id}`,
      carId: car.id,
      seat: seatOf(car, mySeat),
      tier: Number(car.tier) || 1,
      route: car.route || "safe",
      damaged: Boolean(car.damaged),
      mine: true,
      index,
      radialOffset: (index - 1.5) * 2.2,
      t: gridProgress(seatOf(car, mySeat), index),
    });
  });
  theirs.forEach((car, index) => {
    // The opponent's route is private mid-match (the view nulls it). Those
    // cars wait on the neutral rival ring instead of a route lane, so the
    // board never invents a route the player was not shown.
    const seat = seatOf(car, mySeat === "player1" ? "player2" : "player1");
    out.push({
      key: `rival:${car.id}`,
      carId: car.id,
      seat,
      tier: Number(car.tier) || 1,
      route: null,
      damaged: Boolean(car.damaged),
      mine: false,
      index,
      radialOffset: (index - 1.5) * 2.2,
      t: gridProgress(seat, index),
    });
  });
  return out;
}

const CHECKER_SQUARES = 6;

/** The start/finish checker segments (one per route lane, plus the rival ring). */
export function finishLineSegments() {
  const segments = [];
  const width = LANE_BAND_WIDTH;
  for (const route of LANE_ORDER) {
    const { rx } = laneRadii(route, "player1");
    const x = TRACK_CENTER.x - rx;
    segments.push({
      route,
      x,
      y: TRACK_CENTER.y,
      width,
      height: 9,
      columns: CHECKER_SQUARES,
    });
  }
  const rivalX = TRACK_CENTER.x - RIVAL_RADII.rx;
  segments.push({
    route: "rival",
    x: rivalX,
    y: TRACK_CENTER.y,
    width: 20,
    height: 9,
    columns: CHECKER_SQUARES,
  });
  return segments;
}

/** Static direction chevrons, proving the clockwise direction of travel. */
export function directionChevrons({ steps = [0.125, 0.375, 0.625, 0.875] } = {}) {
  const out = [];
  for (const route of LANE_ORDER) {
    for (const t of steps) {
      const point = pointOnLane({ route, seat: "player1", t });
      out.push({
        key: `chevron:${route}:${t}`,
        route,
        ...point,
        angle: headingOnLane({ route, seat: "player1", t }),
      });
    }
  }
  return out;
}

/** Small lane captions, placed just inside each band at the bottom of the oval. */
export function laneLabelAnchors() {
  return LANE_ORDER.map((route) => {
    const point = pointOnLane({ route, seat: "player1", t: 0.75 });
    return {
      route,
      x: point.x,
      y: point.y - (LANE_BAND_WIDTH / 2 + 11),
    };
  });
}

/** e.g. 1 -> "st", 2 -> "nd" (used for round captions). */
export function ordinalSuffix(value) {
  const n = Math.abs(Math.trunc(Number(value) || 0));
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
}
