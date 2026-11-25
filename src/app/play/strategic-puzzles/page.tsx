import type { Metadata } from "next";

import Footer from "../../../components/Footer";
import NavigationBar from "../../../components/navigation-bar";
import StrategicPuzzlePlayer from "../../../components/solitaire-duel/StrategicPuzzlePlayer";
import { puzzleLibraryPuzzles } from "../../../lib/solitaire-duel/puzzleLibrary";
import { toPlayerPuzzle } from "../../../lib/solitaire-duel/puzzlePlayerData";

export const metadata: Metadata = {
  title: "Strategic Solitaire puzzles | GRYND",
  description:
    "Curated multi-move Solitaire positions with a real objective: reveal buried cards, free a column, plan the stock or coordinate an endgame. Progressive hints and a short explanation after every solve.",
  alternates: { canonical: "/play/strategic-puzzles" },
};

export default function StrategicPuzzlesPage() {
  return (
    <div className="relative min-h-dvh bg-page pb-24 text-white md:pb-0">
      <NavigationBar currentPath="/play" />
      <div
        data-testid="strategic-puzzles-page"
        className="relative mx-auto max-w-6xl px-4 pt-6 sm:px-6 md:pt-8"
      >
        <StrategicPuzzlePlayer
          puzzles={puzzleLibraryPuzzles().map((puzzle) => toPlayerPuzzle(puzzle))}
        />
      </div>
      <Footer />
    </div>
  );
}
