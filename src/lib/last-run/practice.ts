// src/lib/last-run/practice.ts
//
// THE PRACTICE AI'S ONE CONFIGURATION SURFACE.
//
// The level ids and labels live here — not in the registry — because the lobby
// and the match screen import them into the browser, and the registry imports
// `node:crypto` and must never leak into a client bundle. Both sides read this
// same table, so the menu can never promise a bot the server does not build.
//
// A level changes exactly two things: how often the AI runs the course clean,
// and how early it is allowed to miss. It never changes the course, the engine,
// the seed or the collision rules — a harder bot is a more consistent runner,
// not a faster one.

export const PRACTICE_LEVELS = ["easy", "normal", "hard"] as const;
export type PracticeLevel = (typeof PRACTICE_LEVELS)[number];
export const DEFAULT_PRACTICE_LEVEL: PracticeLevel = "normal";

export type PracticeLevelConfig = {
  /** Menu label. */
  label: string;
  /** One line under the menu, so the choice is not a guess. */
  blurb: string;
  /** Chance this course is run clean; otherwise the AI misses one obstacle. */
  cleanRunChance: number;
  /** The AI never fumbles earlier than this obstacle id. */
  fumbleFromId: number;
  /** Latest fumble, as a fraction of the course's obstacles (1 = the last). */
  fumbleWindow: number;
};

export const PRACTICE_LEVELS_CONFIG: Record<PracticeLevel, PracticeLevelConfig> = {
  easy: {
    label: "Easy",
    blurb: "Fumbles early and often — it usually crashes before the track speeds up.",
    cleanRunChance: 0.05,
    fumbleFromId: 2,
    fumbleWindow: 0.45,
  },
  normal: {
    label: "Normal",
    blurb: "One miss somewhere in the course; beatable if you last long enough.",
    cleanRunChance: 0.25,
    fumbleFromId: 4,
    fumbleWindow: 0.85,
  },
  hard: {
    label: "Hard",
    blurb: "Rarely misses — outlasting it means holding the whole track.",
    cleanRunChance: 0.65,
    fumbleFromId: 8,
    fumbleWindow: 1,
  },
};

export function isPracticeLevel(value: unknown): value is PracticeLevel {
  return typeof value === "string" && (PRACTICE_LEVELS as readonly string[]).includes(value);
}

/**
 * Server-side acceptance: case-insensitive, and anything unknown falls back to
 * `normal` rather than failing. A difficulty picker is a preference, not an
 * input that can be malformed into an error the player cannot act on.
 */
export function sanitizePracticeLevel(value: unknown): PracticeLevel {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isPracticeLevel(candidate) ? candidate : DEFAULT_PRACTICE_LEVEL;
}

/** Display label for a (possibly untrusted) level value. */
export function practiceLevelLabel(value: unknown): string {
  return PRACTICE_LEVELS_CONFIG[sanitizePracticeLevel(value)].label;
}
