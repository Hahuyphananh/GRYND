import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";

import Footer from "../../../../components/Footer";
import NavigationBar from "../../../../components/navigation-bar";
import SolitairePuzzle from "../../../../components/solitaire-duel/SolitairePuzzle";

export const metadata: Metadata = {
  title: "Today's Solitaire puzzle | GRYND",
  description:
    "Play today's three-step Solitaire puzzle on a real board. Find the best move at each step; one mistake ends the run and a new run arrives at UTC midnight.",
  alternates: { canonical: "/play/daily-puzzle/play" },
  robots: { index: false, follow: false },
};

export default function DailyPuzzlePlayPage() {
  return (
    <div className="relative min-h-screen bg-page pb-24 text-white md:pb-0">
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
        <p className="mt-4 text-xs text-white/50" data-testid="daily-puzzle-cross-link">
          Want the full deal instead?{" "}
          <Link
            href="/daily"
            className="font-semibold text-[#f5ff3b] underline-offset-4 hover:text-[#fff9b0] hover:underline"
          >
            Play today&apos;s challenge →
          </Link>
        </p>
      </main>
      <Footer />
    </div>
  );
}
