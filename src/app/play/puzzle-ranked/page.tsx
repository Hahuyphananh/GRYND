import type { Metadata } from "next";

import PuzzleRankedLobby from "../../../components/play/PuzzleRankedLobby";
import { pageMetadata } from "../../../lib/seo";

const TITLE = "Puzzle Ranked — human vs human puzzles | GRYND";
const DESCRIPTION =
  "A rated Solitaire puzzle race against a real person: five verified positions, one shared clock, separate Puzzle Ranked Elo and trophies. No bots.";

export const metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/play/puzzle-ranked",
});

/**
 * The Puzzle Ranked lobby is its OWN route and its own experience. It talks to
 * the Puzzle Ranked queue only, so it can never fall through to the Solitaire
 * Duel ranked lobby at /play/ranked.
 */
export default function PuzzleRankedLobbyPage() {
  return <PuzzleRankedLobby />;
}
