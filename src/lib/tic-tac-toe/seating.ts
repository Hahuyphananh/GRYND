// src/lib/tic-tac-toe/seating.ts
//
// WHO OPENS: the small, pure policy behind a Tic-Tac-Toe match's seats.
//
// Ultimate Tic-Tac-Toe has one fixed rule — X (`player1`) moves first — and that
// rule is NOT what these helpers change. What they decide is which USER takes
// the X seat:
//
//   • a practice match asks the player (`mark: "X" | "O" | "random"`), and the
//     server resolves `random` so the row and the board cannot disagree;
//   • a 1v1 duel ROLLS it, like chess colours, instead of handing the opening
//     move to whoever opened the lobby.
//
// Kept free of database imports so the roll can be pinned in a unit test and so
// the lobby can share the vocabulary without pulling the match store into the
// browser bundle.

/** The mark a player asked to hold in a practice match, before the server rolls
 *  a `random` request. */
export type MarkChoice = "X" | "O" | "random";

/**
 * Parse the untrusted `mark` field of a create-practice request.
 *
 * Anything absent, unknown or of the wrong type means `random` — the default the
 * game uses when nobody expressed a preference. The server never trusts a client
 * to have chosen a seat consistently with the row.
 */
export function parseMarkChoice(raw: unknown): MarkChoice {
  if (typeof raw !== "string") return "random";
  const value = raw.trim().toUpperCase();
  if (value === "X" || value === "O") return value;
  return "random";
}

/**
 * Resolve which mark the HUMAN holds, rolling `random` exactly once.
 *
 * Pure on its `random` so the roll is testable without a database; the store
 * passes `Math.random`. X is the seat that opens (`player1`), which is the one
 * engine invariant this feature does NOT change — what is randomized (or
 * chosen) is which USER takes that seat.
 */
export function resolveHumanMark(
  choice: MarkChoice,
  random: () => number = Math.random,
): "X" | "O" {
  if (choice === "X" || choice === "O") return choice;
  return Number(random()) < 0.5 ? "X" : "O";
}

/**
 * Roll which seat opens a HUMAN duel: the lobby host (true) or the joiner.
 *
 * Like chess colours, the opening move is not a host privilege. Pure on its
 * `random`, so the roll can be pinned in a test; the store passes `Math.random`.
 */
export function openingSeatIsHost(random: () => number = Math.random): boolean {
  return Number(random()) < 0.5;
}
