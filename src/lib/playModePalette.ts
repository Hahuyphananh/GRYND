// src/lib/playModePalette.ts
//
// ONE palette for the six Solitaire modes, shared by the Play hub cards and by
// each mode lobby. Colour is how the modes separate at a glance, so it must not
// drift between the card that advertises a mode and the lobby it opens.
//
// Each entry carries:
//   accent  — the mode's hue (CTA text, icon, tag chip, focus ring)
//   line    — the same hue at border/glow alpha
//   surface — the card/lobby background gradient
//   glow    — the hover shadow tint
//
// Pure data: no React, no browser APIs, so both the hub and the lobby (client
// components) and the tests can import it.

export type PlayModeId =
  | "solo"
  | "daily"
  | "ai"
  | "ranked"
  | "puzzleRanked"
  | "puzzleAi"
  | "dailyPuzzle"
  | "unlimited";

export type PlayModeGroup = "ranked" | "practice" | "casual" | "puzzle";

export type PlayModePalette = {
  accent: string;
  line: string;
  surface: string;
  glow: string;
};

export const PLAY_MODE_PALETTE: Record<PlayModeId, PlayModePalette> = {
  ranked: {
    accent: "#00ffa3",
    line: "rgba(0, 255, 163, 0.34)",
    surface:
      "linear-gradient(155deg, rgba(0, 255, 163, 0.16) 0%, rgba(6, 30, 22, 0.92) 46%, rgba(4, 9, 15, 0.98) 100%)",
    glow: "rgba(0, 255, 163, 0.16)",
  },
  // The second Ranked mode: same emerald family, a cooler teal so the pair reads
  // as ONE competitive row without the two cards looking like a copy.
  puzzleRanked: {
    accent: "#5eead4",
    line: "rgba(94, 234, 212, 0.36)",
    surface:
      "linear-gradient(155deg, rgba(94, 234, 212, 0.16) 0%, rgba(8, 34, 32, 0.92) 46%, rgba(4, 9, 15, 0.98) 100%)",
    glow: "rgba(94, 234, 212, 0.16)",
  },
  solo: {
    accent: "#00e5ff",
    line: "rgba(0, 229, 255, 0.30)",
    surface:
      "linear-gradient(155deg, rgba(0, 229, 255, 0.14) 0%, rgba(5, 26, 40, 0.9) 46%, rgba(4, 9, 15, 0.98) 100%)",
    glow: "rgba(0, 229, 255, 0.14)",
  },
  ai: {
    accent: "#a78bfa",
    line: "rgba(167, 139, 250, 0.34)",
    surface:
      "linear-gradient(155deg, rgba(167, 139, 250, 0.16) 0%, rgba(26, 20, 48, 0.92) 46%, rgba(6, 6, 14, 0.98) 100%)",
    glow: "rgba(167, 139, 250, 0.16)",
  },
  // The second AI mode: the same violet family as Vs AI, one step brighter.
  puzzleAi: {
    accent: "#c4b5fd",
    line: "rgba(196, 181, 253, 0.36)",
    surface:
      "linear-gradient(155deg, rgba(196, 181, 253, 0.16) 0%, rgba(30, 24, 54, 0.92) 46%, rgba(6, 6, 14, 0.98) 100%)",
    glow: "rgba(196, 181, 253, 0.16)",
  },
  daily: {
    accent: "#fbbf24",
    line: "rgba(251, 191, 36, 0.32)",
    surface:
      "linear-gradient(155deg, rgba(251, 191, 36, 0.15) 0%, rgba(42, 32, 10, 0.9) 46%, rgba(10, 8, 4, 0.98) 100%)",
    glow: "rgba(251, 191, 36, 0.15)",
  },
  dailyPuzzle: {
    accent: "#38bdf8",
    line: "rgba(56, 189, 248, 0.32)",
    surface:
      "linear-gradient(155deg, rgba(56, 189, 248, 0.15) 0%, rgba(9, 32, 50, 0.9) 46%, rgba(4, 9, 16, 0.98) 100%)",
    glow: "rgba(56, 189, 248, 0.15)",
  },
  unlimited: {
    accent: "#e879f9",
    line: "rgba(232, 121, 249, 0.32)",
    surface:
      "linear-gradient(155deg, rgba(232, 121, 249, 0.16) 0%, rgba(38, 16, 48, 0.92) 46%, rgba(10, 5, 16, 0.98) 100%)",
    glow: "rgba(232, 121, 249, 0.16)",
  },
};

/**
 * The hub's zones, in display order.
 *
 * Ranked is a ROW OF TWO (Solitaire Ranked and Puzzle Ranked); Practice is the
 * AI pair. Solo and the daily challenge stay casual, and the puzzle surfaces
 * keep their own zone — unrelated modes are not forced into a category that
 * does not describe them.
 */
export const PLAY_MODE_GROUPS: readonly {
  id: PlayModeGroup;
  modes: readonly PlayModeId[];
}[] = [
  { id: "ranked", modes: ["ranked", "puzzleRanked"] },
  { id: "practice", modes: ["ai", "puzzleAi"] },
  { id: "casual", modes: ["solo", "daily"] },
  { id: "puzzle", modes: ["dailyPuzzle", "unlimited"] },
];
