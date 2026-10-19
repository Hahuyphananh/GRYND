// src/lib/practicePauseKeys.ts
//
// The games that expose a free-play Pause control on their match page. Kept in
// its own module (no DB imports) so the client hook can use the same union the
// server validates against without pulling server-only code into the bundle.

// Server-backed matches: the pause row is keyed by (game, matchId) and the
// game's own store is frozen/clock-shifted on resume.
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

// Client-only practice boards. They have no persisted match row, so the pause
// is local: the page stops its own AI loop and shows the same chip/overlay.
// These keys are deliberately NOT accepted by /api/practice/pause — there is
// nothing on the server to freeze.
export const LOCAL_PRACTICE_PAUSE_GAMES = [
  "barrier-blitz",
  "four-in-a-row",
  "odds",
  "rps",
] as const;

export type ServerPracticePauseGame = (typeof PRACTICE_PAUSE_GAMES)[number];
export type LocalPracticePauseGame =
  (typeof LOCAL_PRACTICE_PAUSE_GAMES)[number];
export type PracticePauseGame =
  | ServerPracticePauseGame
  | LocalPracticePauseGame;

/** Server-route guard: only games with a persisted match may be toggled. */
export function isPracticePauseGame(
  value: unknown,
): value is ServerPracticePauseGame {
  return (
    typeof value === "string" &&
    (PRACTICE_PAUSE_GAMES as readonly string[]).includes(value)
  );
}

/** Client-only keys, for the hook's `local` mode. */
export function isLocalPracticePauseGame(
  value: unknown,
): value is LocalPracticePauseGame {
  return (
    typeof value === "string" &&
    (LOCAL_PRACTICE_PAUSE_GAMES as readonly string[]).includes(value)
  );
}
