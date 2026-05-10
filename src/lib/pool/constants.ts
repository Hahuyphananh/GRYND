export const TABLE_W = 900;
export const TABLE_H = 500;
export const BALL_R = 11;
export const RAIL = 42;
export const POCKET_R = 30;
export const FRICTION = 0.994;
export const RAIL_DAMPING = 0.92;
export const STOP_EPSILON = 0.03;
export const MAX_PULL = 110;

export const POCKETS: [number, number][] = [
  [34, 34], [TABLE_W / 2, 28], [TABLE_W - 34, 34],
  [34, TABLE_H - 34], [TABLE_W / 2, TABLE_H - 28], [TABLE_W - 34, TABLE_H - 34],
];

export const BALL_LAYOUT = [
  { n: 1, c: "#facc15", s: false }, { n: 2, c: "#2563eb", s: false }, { n: 3, c: "#dc2626", s: false },
  { n: 4, c: "#7c3aed", s: false }, { n: 5, c: "#f97316", s: false }, { n: 6, c: "#16a34a", s: false },
  { n: 7, c: "#a16207", s: false }, { n: 8, c: "#111827", s: false }, { n: 9, c: "#facc15", s: true },
  { n: 10, c: "#2563eb", s: true }, { n: 11, c: "#dc2626", s: true }, { n: 12, c: "#7c3aed", s: true },
  { n: 13, c: "#f97316", s: true }, { n: 14, c: "#16a34a", s: true }, { n: 15, c: "#a16207", s: true },
];
