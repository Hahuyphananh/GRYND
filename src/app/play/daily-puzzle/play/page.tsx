import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";

import Footer from "../../../../components/Footer";
import NavigationBar from "../../../../components/navigation-bar";
import SolitairePuzzle from "../../../../components/solitaire-duel/SolitairePuzzle";

export const metadata: Metadata = {
  title: "Today's Solitaire puzzle | GRYND",
  description:
    "Play today's verified Solitaire puzzle on a real board. One official move per UTC day; the winning move and the reason are revealed after you play.",
  alternates: { canonical: "/play/daily-puzzle/play" },
  robots: { index: false, follow: false },
};

export default function DailyPuzzlePlayPage() {
  return (
    <div className="relative min-h-screen bg-[#040712] pb-24 text-white md:pb-0">
      <NavigationBar currentPath="/play" />
      <main className="relative mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
        <Link
          href="/play/daily-puzzle"
          className="inline-flex items-center gap-2 text-xs font-bold text-white/55 underline-offset-4 hover:text-white hover:underline"
        >
          <IconArrowLeft size={15} aria-hidden="true" />
          Back to the Daily Puzzle lobby
        </Link>
        <div className="mt-4">
          <SolitairePuzzle kind="daily" />
        </div>
        {/* The three daily surfaces are separate pages, so each one has to say
            where the others are — otherwise separating them just makes the
            others harder to find. */}
        <p className="mt-4 text-xs text-white/50" data-testid="daily-puzzle-cross-link">
          Solved it — or want another position?{" "}
          <Link
            href="/play/unlimited-puzzles/play"
            className="font-semibold text-fuchsia-300 underline-offset-4 hover:text-fuchsia-200 hover:underline"
          >
            Play unlimited puzzles →
          </Link>{" "}
          <Link
            href="/daily"
            className="font-semibold text-[#f5ff3b] underline-offset-4 hover:text-[#fff9b0] hover:underline"
          >
            or today&apos;s challenge →
          </Link>
        </p>
      </main>
      <Footer />
    </div>
  );
}
