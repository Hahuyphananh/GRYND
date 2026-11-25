// src/lib/solitaire-duel/puzzleVocabulary.ts
//
// The player-facing puzzle vocabulary, split out from the library builder so a
// client component can render category and difficulty filters WITHOUT importing
// the library data (and therefore without shipping accepted solution paths).
//
// Browser-safe and server-safe: constants and one pure lookup only.

export const PUZZLE_LIBRARY_CATEGORIES = Object.freeze([
  {
    id: "tableau",
    nameKey: "puzzleLibrary.categories.tableau.name",
    descriptionKey: "puzzleLibrary.categories.tableau.description",
  },
  {
    id: "foundation",
    nameKey: "puzzleLibrary.categories.foundation.name",
    descriptionKey: "puzzleLibrary.categories.foundation.description",
  },
  {
    id: "stock",
    nameKey: "puzzleLibrary.categories.stock.name",
    descriptionKey: "puzzleLibrary.categories.stock.description",
  },
  {
    id: "sequence",
    nameKey: "puzzleLibrary.categories.sequence.name",
    descriptionKey: "puzzleLibrary.categories.sequence.description",
  },
  {
    id: "endgame",
    nameKey: "puzzleLibrary.categories.endgame.name",
    descriptionKey: "puzzleLibrary.categories.endgame.description",
  },
] as const);

export type PuzzleLibraryCategory = (typeof PUZZLE_LIBRARY_CATEGORIES)[number]["id"];

/** Five player-facing levels. The number is the Phase 2 difficulty band. */
export const PUZZLE_LIBRARY_LEVELS = Object.freeze([
  { level: 1, id: "beginner", key: "puzzleLibrary.levels.beginner" },
  { level: 2, id: "intermediate", key: "puzzleLibrary.levels.intermediate" },
  { level: 3, id: "advanced", key: "puzzleLibrary.levels.advanced" },
  { level: 4, id: "expert", key: "puzzleLibrary.levels.expert" },
  { level: 5, id: "master", key: "puzzleLibrary.levels.master" },
] as const);

export type PuzzleLibraryLevelId = (typeof PUZZLE_LIBRARY_LEVELS)[number]["id"];

export function levelForBand(band: number): (typeof PUZZLE_LIBRARY_LEVELS)[number] {
  return (
    PUZZLE_LIBRARY_LEVELS.find((entry) => entry.level === Math.round(band)) ??
    PUZZLE_LIBRARY_LEVELS[0]
  );
}
