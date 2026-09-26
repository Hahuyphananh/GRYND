// src/lib/mini-golf/courseTemplates.ts
//
// The controlled hole-template library for Mini Golf.
//
// Generation NEVER produces arbitrary geometry: every hole is one of these
// hand-designed primitives, and the only freedom is a set of *bounded*
// randomized parameters (tee/cup offset, wall lengths, corridor width, gap
// placement, obstacle count/size/position) drawn from the match's seeded PRNG.
// That is what makes the output varied but never ridiculous.
//
// Contract:
//   • `build(ctx)` is pure and deterministic: same context → same layout.
//   • Builders emit geometry in the CANONICAL frame (tee at the bottom, cup at
//     the top, no mirroring). The generator applies a single horizontal mirror
//     via `mirrorLayoutX`, so builders must never mirror themselves.
//   • Every builder aims to produce a layout that passes `validateHole`. It is
//     allowed to fail — the generator re-rolls and counts the rejection — but
//     builders should stay inside the channel-width and clearance budgets so
//     rejection is rare.
//
// Frames: x grows right, y grows DOWN (screen-like). The playable area is the
// rectangle [0,width] × [0,height]; the ball radius is BALL_RADIUS.

import {
  BALL_RADIUS,
  CUP_INSET_Y,
  CUP_RADIUS,
  MIN_OBSTACLE_GAP,
  TEE_INSET_Y,
  type HoleTemplate as HoleTemplateName,
} from "./constants";
import type { Bumper, Sand, Segment, Vec2, Water } from "./types";

export type TemplateContext = {
  /** Seeded PRNG. The only source of randomness in the whole generator. */
  rand: () => number;
  width: number;
  height: number;
  /** Target difficulty level (1–5) — lets a template scale its density. */
  level: number;
};

export type TemplateLayout = {
  tee: Vec2;
  cup: Vec2;
  walls: Segment[];
  bumpers: Bumper[];
  sand: Sand[];
  water: Water[];
};

export type MiniGolfTemplate = {
  name: HoleTemplateName;
  label: string;
  /** Intrinsic difficulty level (1 = easiest, 5 = hardest). */
  level: 1 | 2 | 3 | 4 | 5;
  build: (ctx: TemplateContext) => TemplateLayout;
};

// ── Deterministic helpers ─────────────────────────────────────────────────

/** Symmetric jitter in [-amp, +amp]. */
export function jitter(rand: () => number, amp: number): number {
  return (rand() * 2 - 1) * amp;
}

/** Uniform value in [min, max]. */
export function range(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min);
}

/** Integer in [min, max] inclusive. */
export function randInt(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/** Pick one element of a non-empty array. */
export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
}

const segment = (ax: number, ay: number, bx: number, by: number): Segment => ({
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});

const circle = (x: number, y: number, r: number) => ({ x, y, r });

/** Mirror a whole layout across the vertical centre line (orientation flip). */
export function mirrorLayoutX(layout: TemplateLayout, width: number): TemplateLayout {
  const mx = (x: number) => width - x;
  return {
    tee: { x: mx(layout.tee.x), y: layout.tee.y },
    cup: { x: mx(layout.cup.x), y: layout.cup.y },
    walls: layout.walls.map((w) => ({
      a: { x: mx(w.a.x), y: w.a.y },
      b: { x: mx(w.b.x), y: w.b.y },
    })),
    bumpers: layout.bumpers.map((b) => ({ x: mx(b.x), y: b.y, r: b.r })),
    sand: layout.sand.map((s) => ({ x: mx(s.x), y: s.y, r: s.r })),
    water: layout.water.map((w) => ({ x: mx(w.x), y: w.y, r: w.r })),
  };
}

/** Tee placement: centred on the bottom edge with a controlled lateral spread. */
function teeAt(rand: () => number, width: number, height: number, spread = 26): Vec2 {
  return {
    x: width / 2 + jitter(rand, spread),
    y: height - TEE_INSET_Y + jitter(rand, 8),
  };
}

/** Cup placement: near the top edge with a controlled lateral spread. */
function cupAt(
  rand: () => number,
  width: number,
  spread = 60,
  yBase = CUP_INSET_Y,
  yJitter = 8,
): Vec2 {
  return { x: width / 2 + jitter(rand, spread), y: yBase + jitter(rand, yJitter) };
}

/**
 * Greedy legal scatter for circular obstacles.
 *
 * Each obstacle is drawn up to `tries` times and kept only if it clears every
 * already-placed obstacle and every point in `avoid` by MIN_OBSTACLE_GAP. This
 * guarantees "obstacles are not overlapping illegally" by construction, so the
 * validator only has to double-check it.
 */
export function scatterCircles(
  rand: () => number,
  {
    count,
    minR,
    maxR,
    xMin,
    xMax,
    yMin,
    yMax,
    avoid = [],
    tries = 16,
  }: {
    count: number;
    minR: number;
    maxR: number;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    avoid?: { x: number; y: number; r: number }[];
    tries?: number;
  },
): { x: number; y: number; r: number }[] {
  const placed: { x: number; y: number; r: number }[] = [];
  const clears = (candidate: { x: number; y: number; r: number }, others: typeof placed) =>
    others.every(
      (other) =>
        Math.hypot(other.x - candidate.x, other.y - candidate.y) >=
        other.r + candidate.r + MIN_OBSTACLE_GAP,
    );

  for (let i = 0; i < count; i += 1) {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const candidate = circle(range(rand, xMin, xMax), range(rand, yMin, yMax), range(rand, minR, maxR));
      if (clears(candidate, placed) && clears(candidate, avoid)) {
        placed.push(candidate);
        break;
      }
    }
  }
  return placed;
}

// ── Templates ─────────────────────────────────────────────────────────────
//
// Every template keeps its clearances well above the validator's budgets
// (MIN_CHANNEL_WIDTH = 4 × ball radius, cup clearance = cup radius + ball
// radius) so a valid hole is the norm, not the exception.

/** Canonical, parameter-free straight hole. Also the generator's fallback. */
export function canonicalLayout(width: number, height: number): TemplateLayout {
  const gateY = height * 0.52;
  const gap = 160;
  return {
    tee: { x: width / 2, y: height - TEE_INSET_Y },
    cup: { x: width / 2, y: CUP_INSET_Y },
    walls: [
      segment(0, gateY, width / 2 - gap / 2, gateY),
      segment(width / 2 + gap / 2, gateY, width, gateY),
    ],
    bumpers: [],
    sand: [],
    water: [],
  };
}

const straight: MiniGolfTemplate = {
  name: "straight",
  label: "Straight",
  level: 1,
  build: ({ rand, width, height }) => {
    // A single gated wall with a wide opening, plus an optional sand patch
    // low on the fairway (decoration that never blocks the route).
    const gateY = height * 0.52 + jitter(rand, 18);
    const gap = range(rand, 140, 190);
    const gapCentre = width / 2 + jitter(rand, 34);
    const gapLeft = Math.max(BALL_RADIUS * 6, gapCentre - gap / 2);
    const gapRight = Math.min(width - BALL_RADIUS * 6, gapCentre + gap / 2);

    const sand =
      rand() < 0.55
        ? [circle(width / 2 + jitter(rand, 70), height * 0.74, range(rand, 24, 34))]
        : [];

    return {
      tee: teeAt(rand, width, height, 30),
      cup: cupAt(rand, width, 42),
      walls: [
        segment(0, gateY, gapLeft, gateY),
        segment(gapRight, gateY, width, gateY),
      ],
      bumpers: [],
      sand,
      water: [],
    };
  },
};

const longDistance: MiniGolfTemplate = {
  name: "long-distance",
  label: "Long Distance",
  level: 2,
  build: ({ rand, width, height }) => {
    // No walls at all: the challenge is pace and line over maximum distance.
    const bumper = [circle(width / 2 + jitter(rand, 80), height * 0.42 + jitter(rand, 30), range(rand, 10, 16))];
    const water =
      rand() < 0.5
        ? [
            circle(
              width / 2 + (rand() < 0.5 ? -1 : 1) * range(rand, 90, 135),
              height * 0.55,
              range(rand, 26, 34),
            ),
          ]
        : [];
    return {
      tee: teeAt(rand, width, height, 34),
      cup: cupAt(rand, width, 70),
      walls: [],
      bumpers: bumper,
      sand: [],
      water,
    };
  },
};

const centralObstacle: MiniGolfTemplate = {
  name: "central-obstacle",
  label: "Central Obstacle",
  level: 2,
  build: ({ rand, width, height }) => ({
    tee: teeAt(rand, width, height, 28),
    cup: cupAt(rand, width, 44),
    walls: [],
    // One large disc the player must route around; the side channels stay
    // far wider than a ball.
    bumpers: [circle(width / 2 + jitter(rand, 35), height * 0.5 + jitter(rand, 30), range(rand, 30, 44))],
    sand: rand() < 0.4 ? [circle(width / 2 + jitter(rand, 110), height * 0.74, range(rand, 22, 30))] : [],
    water: [],
  }),
};

const lShape: MiniGolfTemplate = {
  name: "l-shape",
  label: "L-Shape",
  level: 2,
  build: ({ rand, width, height }) => {
    // A horizontal wall from the left edge into the fairway, turning up into a
    // vertical wall. The cup sits behind the vertical wall, so the ball must
    // travel around the corner (right of the turn, up, then back left over the
    // wall's open top end).
    const cornerX = range(rand, 245, 300);
    const cornerY = range(rand, height * 0.44, height * 0.56);
    const wallTopY = range(rand, height * 0.14, height * 0.2);

    const cup: Vec2 = {
      x: Math.max(CUP_RADIUS + BALL_RADIUS + 30, cornerX - range(rand, 60, 130)),
      y: CUP_INSET_Y + jitter(rand, 10),
    };

    return {
      tee: teeAt(rand, width, height, 30),
      cup,
      walls: [
        segment(0, cornerY, cornerX, cornerY),
        segment(cornerX, cornerY, cornerX, wallTopY),
      ],
      bumpers: [],
      sand: [],
      water: [],
    };
  },
};

const multipleObstacles: MiniGolfTemplate = {
  name: "multiple-obstacles",
  label: "Multiple Obstacles",
  level: 3,
  build: ({ rand, width, height, level }) => {
    // Denser clusters as the tier rises, but every disc is placed with a legal
    // clearance by the greedy scatter.
    const count = level >= 4 ? randInt(rand, 4, 5) : randInt(rand, 3, 4);
    const tee = teeAt(rand, width, height, 30);
    const cup = cupAt(rand, width, 60);
    const avoid = [
      { x: tee.x, y: tee.y, r: BALL_RADIUS * 3 },
      { x: cup.x, y: cup.y, r: CUP_RADIUS + BALL_RADIUS },
    ];
    const bumpers = scatterCircles(rand, {
      count,
      minR: 12,
      maxR: 22,
      xMin: 80,
      xMax: width - 80,
      yMin: height * 0.2,
      yMax: height * 0.78,
      avoid,
    });
    const sand = scatterCircles(rand, {
      count: randInt(rand, 1, 2),
      minR: 22,
      maxR: 32,
      xMin: 80,
      xMax: width - 80,
      yMin: height * 0.24,
      yMax: height * 0.76,
      avoid: [...avoid, ...bumpers],
    });
    return { tee, cup, walls: [], bumpers, sand, water: [] };
  },
};

const narrowCorridor: MiniGolfTemplate = {
  name: "narrow-corridor",
  label: "Narrow Corridor",
  level: 3,
  build: ({ rand, width, height }) => {
    // Two long parallel walls form a corridor the ball must thread. The width
    // is bounded well above MIN_CHANNEL_WIDTH so the passage is always legal.
    const corridorWidth = range(rand, BALL_RADIUS * 4.2, BALL_RADIUS * 5.5);
    const centreX = width / 2 + jitter(rand, 50);
    const leftX = centreX - corridorWidth / 2;
    const rightX = centreX + corridorWidth / 2;
    const fromY = height * 0.3 + jitter(rand, 24);
    const toY = height * 0.86 + jitter(rand, 18);

    return {
      // The tee sits ON the corridor centreline, inside its mouth, so the wall
      // clearance (corridorWidth / 2) always exceeds the tee's minimum and the
      // hole is valid on the first attempt.
      tee: { x: centreX, y: height - TEE_INSET_Y + jitter(rand, 6) },
      cup: { x: centreX + jitter(rand, 44), y: CUP_INSET_Y + jitter(rand, 8) },
      walls: [
        segment(leftX, fromY, leftX, toY),
        segment(rightX, fromY, rightX, toY),
      ],
      bumpers: [],
      sand: [],
      water: [],
    };
  },
};

const splitPath: MiniGolfTemplate = {
  name: "split-path",
  label: "Split Path",
  level: 4,
  build: ({ rand, width, height }) => {
    // One full-width wall with TWO gaps, so the player picks a lane; a central
    // bumper above the wall punishes the lazy line.
    const wallY = height * 0.46 + jitter(rand, 16);
    const gap1 = range(rand, 46, 60);
    const gap2 = range(rand, 46, 60);
    const g1Left = 58 + jitter(rand, 14);
    const g1Right = g1Left + gap1;
    const g2Right = width - 58 + jitter(rand, 14);
    const g2Left = g2Right - gap2;

    return {
      tee: teeAt(rand, width, height, 80),
      cup: cupAt(rand, width, 80),
      walls: [
        segment(0, wallY, g1Left, wallY),
        segment(g1Right, wallY, g2Left, wallY),
        segment(g2Right, wallY, width, wallY),
      ],
      bumpers: [circle(width / 2 + jitter(rand, 30), height * 0.26 + jitter(rand, 20), range(rand, 16, 24))],
      sand: [],
      water: [],
    };
  },
};

const uShape: MiniGolfTemplate = {
  name: "u-shape",
  label: "U-Shape",
  level: 4,
  build: ({ rand, width, height }) => {
    // A U opening toward the tee, with the cup in its mouth. The ball enters
    // between the arms and must settle inside; overshoot hits the closed end.
    const centreX = width / 2 + jitter(rand, 30);
    const halfWidth = range(rand, 84, 98);
    const topY = height * 0.12 + jitter(rand, 8);
    const bottomY = height * 0.4 + jitter(rand, 18);
    const leftX = centreX - halfWidth;
    const rightX = centreX + halfWidth;

    return {
      tee: { x: centreX + jitter(rand, 30), y: height - TEE_INSET_Y + jitter(rand, 8) },
      cup: { x: centreX + jitter(rand, 20), y: topY + range(rand, 40, 60) },
      walls: [
        segment(leftX, topY, leftX, bottomY),
        segment(rightX, topY, rightX, bottomY),
        segment(leftX, topY, rightX, topY),
      ],
      bumpers: [],
      sand: [],
      water: [],
    };
  },
};

const zigZag: MiniGolfTemplate = {
  name: "zig-zag",
  label: "Zig-Zag",
  level: 5,
  build: ({ rand, width, height }) => {
    // Three alternating stubs attach to opposite side walls, so the ball has
    // to change direction twice with a controlled gap each time.
    const centre = width / 2 + jitter(rand, 12);
    const reach = range(rand, 190, 216);
    const y1 = height * 0.66 + jitter(rand, 14);
    const y2 = height * 0.5 + jitter(rand, 14);
    const y3 = height * 0.34 + jitter(rand, 14);

    return {
      tee: teeAt(rand, width, height, 40),
      cup: cupAt(rand, width, 44),
      walls: [
        segment(0, y1, centre - reach * 0.5, y1),
        segment(width, y2, centre + reach * 0.5, y2),
        segment(0, y3, centre - reach * 0.5, y3),
      ],
      bumpers: [],
      sand: [],
      water: [],
    };
  },
};

const wallBounce: MiniGolfTemplate = {
  name: "wall-bounce",
  label: "Wall Bounce",
  level: 5,
  build: ({ rand, width, height }) => {
    // A full-width wall with ONE narrow offset gap: the direct line is blocked,
    // and a bumper below the wall makes the bank shot the natural answer.
    const wallY = height * 0.42 + jitter(rand, 14);
    const gap = range(rand, 46, 58);
    const gapLeft = 92 + jitter(rand, 30);
    const gapRight = gapLeft + gap;

    return {
      tee: teeAt(rand, width, height, 60),
      cup: cupAt(rand, width, 70),
      walls: [
        segment(0, wallY, gapLeft, wallY),
        segment(gapRight, wallY, width, wallY),
      ],
      bumpers: [
        circle(width / 2 + jitter(rand, 90), height * 0.62 + jitter(rand, 24), range(rand, 12, 18)),
      ],
      sand: rand() < 0.4 ? [circle(width / 2 + jitter(rand, 120), height * 0.8, range(rand, 22, 30))] : [],
      water: [],
    };
  },
};

/** The registry. Order is easy → hard; lookup is by name. */
export const TEMPLATES: readonly MiniGolfTemplate[] = [
  straight,
  longDistance,
  centralObstacle,
  lShape,
  multipleObstacles,
  narrowCorridor,
  splitPath,
  uShape,
  zigZag,
  wallBounce,
];

/** Every template's intrinsic difficulty level (1–5). */
export const TEMPLATE_LEVELS: Record<string, number> = Object.fromEntries(
  TEMPLATES.map((template) => [template.name, template.level]),
);

const BY_NAME = new Map<string, MiniGolfTemplate>(
  TEMPLATES.map((template) => [template.name, template]),
);

/** Look a template up by name; throws on an unknown name (never silent). */
export function templateByName(name: string): MiniGolfTemplate {
  const found = BY_NAME.get(name);
  if (!found) {
    throw new RangeError(`mini-golf templates: unknown template "${name}"`);
  }
  return found;
}

/** Par for a difficulty level (informational only — scoring is stroke count). */
export function parForLevel(level: number): number {
  if (level >= 5) return 4;
  if (level >= 3) return 3;
  return 2;
}
