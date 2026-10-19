// src/lib/practicePauseKeys.ts
//
// The games that expose a free-play Pause control on their match page. Kept in
// its own module (no DB imports) so the client hook can use the same union the
// server validates against without pulling server-only code into the bundle.

export const PRACTICE_PAUSE_GAMES = [
  "chess",
  "dice-flush",
  "dots-and-boxes",
  "hex-duel",
  "keno-pvp",
  "lane-rush-duel",
  "memory-grid",
  "mines-pvp",
  "mini-golf",
  "pool",
  "precision",
  "solitaire-duel",
  "speed-typing",
  "sudoku-duel",
  "tic-tac-toe",
  "uno",
] as const;

export type PracticePauseGame = (typeof PRACTICE_PAUSE_GAMES)[number];

export function isPracticePauseGame(value: unknown): value is PracticePauseGame {
  return typeof value === "string" && (PRACTICE_PAUSE_GAMES as readonly string[]).includes(value);
}
