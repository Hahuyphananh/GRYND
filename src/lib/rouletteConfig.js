// Shared roulette constants — used by both frontend (page.jsx) and backend (save-game/route.js)
// European roulette wheel layout

export const ROULETTE_NUMBERS = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

export const RED_NUMBERS = [
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
];

export const BLACK_NUMBERS = ROULETTE_NUMBERS.filter(
  (n) => n !== 0 && !RED_NUMBERS.includes(n),
);

// Bet types and their payout multipliers
export const PAYOUTS = {
  single: 35,      // Straight-up (single number)
  split: 17,       // Not currently offered on this layout
  street: 11,      // Not currently offered
  corner: 8,       // Not currently offered
  sixLine: 5,      // Not currently offered
  dozen: 3,        // 1-12, 13-24, 25-36
  column: 2,       // Not currently offered
  evenMoney: 2,    // Red, Black, Even, Odd, 1-18, 19-36
  zero: 35,        // Green (0) — same as single number
};

// Color constants
export const COLORS = {
  red: "#c0392b",
  redGlow: "rgba(192, 57, 43, 0.6)",
  black: "#1a1a2e",
  blackGlow: "rgba(30, 30, 50, 0.5)",
  green: "#0d5e2e",
  greenGlow: "rgba(13, 94, 46, 0.6)",
  gold: "#FFD700",
  goldDark: "#B8860B",
  goldAccent: "#FFFF33",
  wheelBg: "#2c1810",
  wheelRim: "#8B6914",
  pocketDivider: "#c0a060",
};

// Chip quick-select values
export const CHIP_VALUES = [1, 5, 10, 25, 50, 100, 500];
