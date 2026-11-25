// src/app/api/solitaire-puzzle/ai/bots/route.ts
//
// GET — the six Puzzle vs AI opponents.
//
// This is the SAME roster the Solitaire Duel lobby uses
// (`publicSolitaireBots`), not a puzzle-specific copy: ids, names,
// descriptions, ratings, difficulty labels, audience and avatars are all read
// from `../solitaire-duel/bots.ts`. A picker built on this route therefore
// cannot drift from the identities the rest of the platform shows.
//
// Read-only, no auth required for the list, nothing mutable in the payload.

import { NextResponse } from "next/server";
import { publicSolitaireBots } from "../../../../../lib/solitaire-duel/bots";
import { PUZZLE_LIBRARY_LEVELS } from "../../../../../lib/solitaire-duel/puzzleVocabulary";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    success: true,
    data: {
      // `kind: "ai"` is the explicit "this opponent is not a human" marker.
      opponentKind: "ai" as const,
      bots: publicSolitaireBots(),
      levels: PUZZLE_LIBRARY_LEVELS,
    },
  });
}
