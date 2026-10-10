export const TABLE_W = 900;
export const TABLE_H = 500;
export const BALL_R = 11;
export const RAIL = 42;
export const POCKET_R = 30;
export const FRICTION = 0.982;
export const RAIL_DAMPING = 0.82;
export const STOP_EPSILON = 0.1;
export const MAX_PULL = 120;

/**
 * Largest distance (in table units) a ball may cross in ONE physics substep.
 *
 * Velocities are table units per 60 Hz tick and a full-power shot carries a
 * ball ~25 units — further than a ball diameter (2 × BALL_R) and further than a
 * pocket mouth. Integrating that as a single jump per tick let fast balls
 * tunnel through each other and skip the pocket mouths (the rail clamp then
 * bounced them back out, so pots "didn't go in"). `tickPhysics` therefore
 * splits every tick into substeps of at most this distance, so contact and pot
 * capture are tested against positions a ball really crossed.
 *
 * 3 units is small against both windows a ball can skip over: the 2 × BALL_R
 * contact window (so a contact is never jumped) and the ≈5-unit pocket-jaw band
 * between `POCKET_R` and the capture radius (so a pot is never jumped). It
 * costs a full-power shot ~9 substeps, the same order as the platform's other
 * authoritative simulations (`SUBSTEP_MAX_PX` in mini-golf / plinko).
 */
export const MAX_SUBSTEP_PX = 3;

export const POCKETS: [number, number][] = [
  [34, 34],
  [TABLE_W / 2, 28],
  [TABLE_W - 34, 34],
  [34, TABLE_H - 34],
  [TABLE_W / 2, TABLE_H - 28],
  [TABLE_W - 34, TABLE_H - 34],
];

export const BALL_LAYOUT = [
  { n: 1, c: "#facc15", s: false },
  { n: 2, c: "#2563eb", s: false },
  { n: 3, c: "#dc2626", s: false },
  { n: 4, c: "#7c3aed", s: false },
  { n: 5, c: "#f97316", s: false },
  { n: 6, c: "#16a34a", s: false },
  { n: 7, c: "#a16207", s: false },
  { n: 8, c: "#111827", s: false },
  { n: 9, c: "#facc15", s: true },
  { n: 10, c: "#2563eb", s: true },
  { n: 11, c: "#dc2626", s: true },
  { n: 12, c: "#7c3aed", s: true },
  { n: 13, c: "#f97316", s: true },
  { n: 14, c: "#16a34a", s: true },
  { n: 15, c: "#a16207", s: true },
];
