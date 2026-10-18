// src/lib/tic-tac-toe/marks.ts
//
// The practice-match mark picker's vocabulary, and its per-device memory.
//
// `X` opens in Ultimate Tic-Tac-Toe, so this is really "who starts": picking X
// seats the human in player1, picking O seats the bot there and hands it the
// first move, and `random` leaves the roll to the SERVER (see
// `resolveHumanMark` in the store). The client never rolls it: the seat the row
// records and the mark the board shows have to be the same decision.
//
// Client-safe on purpose — no database import — so the lobby can read and write
// the preference without pulling the match store into the browser bundle.

export type AiMark = "X" | "O" | "random";

/** The three choices, in the order the dialog offers them. */
export const AI_MARKS: readonly AiMark[] = Object.freeze(["X", "O", "random"]);

/** One line per choice, shown under the segmented control. */
export const AI_MARK_HINTS: Readonly<Record<AiMark, string>> = Object.freeze({
  X: "You hold X and make the opening move.",
  O: "The bot holds X and opens — you answer.",
  random: "The server rolls who opens when the match starts.",
});

const STORAGE_KEY = "grynd:tic-tac-toe:ai-mark";

/** Coerce anything (storage, a stale value) to a legal choice. */
export function coerceAiMark(raw: unknown): AiMark {
  return raw === "X" || raw === "O" || raw === "random" ? raw : "random";
}

/**
 * The mark the player last picked on this device, or `random`.
 *
 * Wrapped in try/catch because storage can be unavailable (private mode, a
 * disabled cookie jar) and a preference is never worth breaking the lobby over.
 */
export function readStoredAiMark(): AiMark {
  try {
    return coerceAiMark(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "random";
  }
}

/** Remember the pick for the next visit. Best effort, like the read. */
export function storeAiMark(mark: AiMark): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, coerceAiMark(mark));
  } catch {
    // Storage unavailable — the choice still applies to this match.
  }
}
