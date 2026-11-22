// src/lib/solitaire-duel/puzzlePlayerData.ts
//
// THE PLAYER PAYLOAD — a deliberate projection of a validated library puzzle.
//
// The strategic player needs a start position, an objective, its hints and its
// explanation. It does NOT need the accepted solution paths, the verification
// record, or the authoring metadata. Shipping those to the browser would put the
// answers in the page, so the server page builds the library, maps every puzzle
// through `toPlayerPuzzle`, and passes only this shape to the client component.
//
// TYPE-ONLY IMPORTS: this module is imported by the server page for the mapper
// and by the client for the type. The type-only imports below are erased, so the
// client never pulls the library data module into its bundle.
//
// Hidden information disclosure is still bounded by the client-side rules: the
// start state necessarily contains the face-down identities and the stock order
// because moves are applied locally. That is documented as a known limitation;
// the accepted answers are NOT part of this payload.

import type {
  LibraryExplanation,
  LibraryHint,
  LibraryPuzzle,
  PuzzleLibraryCategory,
  PuzzleLibraryLevelId,
} from "./puzzleLibrary";
import type { PuzzleConstraints, PuzzleObjective } from "./puzzleValidation";
import type { SolitaireState } from "./types";

export type PlayerPuzzle = {
  id: string;
  category: PuzzleLibraryCategory;
  level: PuzzleLibraryLevelId;
  levelNumber: number;
  levelKey: string;
  /** The curated line's length, shown as "par". */
  par: number;
  /** How many verified lines reach the objective. */
  solutionCount: number;
  hints: LibraryHint[];
  explanation: LibraryExplanation;
  spec: {
    id: string;
    version: number;
    objective: PuzzleObjective;
    startState: SolitaireState;
    constraints?: PuzzleConstraints;
  };
};

/** Strip everything a browser does not need — above all, the answer paths. */
export function toPlayerPuzzle(puzzle: LibraryPuzzle): PlayerPuzzle {
  return {
    id: puzzle.id,
    category: puzzle.category,
    level: puzzle.level,
    levelNumber: puzzle.levelNumber,
    levelKey: puzzle.levelKey,
    par: puzzle.spec.constraints?.maxMoves ?? puzzle.spec.solutions[0]?.length ?? 0,
    solutionCount: puzzle.solutionCount,
    hints: puzzle.hints,
    explanation: puzzle.explanation,
    spec: {
      id: puzzle.spec.id,
      version: puzzle.spec.version,
      objective: puzzle.spec.objective,
      startState: puzzle.spec.startState,
      ...(puzzle.spec.constraints ? { constraints: puzzle.spec.constraints } : {}),
    },
  };
}
