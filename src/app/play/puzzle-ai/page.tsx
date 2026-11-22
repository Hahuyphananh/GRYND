import type { Metadata } from "next";

import PuzzleAiLobby from "../../../components/play/PuzzleAiLobby";
import { pageMetadata } from "../../../lib/seo";

const TITLE = "Puzzle vs AI — six Solitaire opponents | GRYND";
const DESCRIPTION =
  "Practise Solitaire puzzles against Rookie, Felix, Ace, Professor, Grandmaster or Perfect. Unrated practice: no trophies, no rating, and the opponent is always labelled AI.";

export const metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/play/puzzle-ai",
});

/**
 * Puzzle vs AI is a separate practice route. It does not replace `/play/ai`
 * (the regular Vs AI mode), and it does not touch matchmaking.
 */
export default function PuzzleAiLobbyPage() {
  return <PuzzleAiLobby />;
}
