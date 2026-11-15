import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";

import Footer from "../../../../components/Footer";
import NavigationBar from "../../../../components/navigation-bar";
import SolitairePuzzle from "../../../../components/solitaire-duel/SolitairePuzzle";

export const metadata: Metadata = {
  title: "Practice Solitaire puzzle | GRYND",
  description:
    "Practice verified Solitaire puzzles. Free players get 5 per UTC day; GRYND Pro is unlimited. The server enforces the allowance.",
  alternates: { canonical: "/play/unlimited-puzzles/play" },
  robots: { index: false, follow: false },
};

export default function UnlimitedPuzzlePlayPage() {
  return (
    <div className="relative min-h-screen bg-[#040712] pb-24 text-white md:pb-0">
      <NavigationBar currentPath="/play" />
      <main className="relative mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
        <Link
          href="/play/unlimited-puzzles"
          className="inline-flex items-center gap-2 text-xs font-bold text-white/55 underline-offset-4 hover:text-white hover:underline"
        >
          <IconArrowLeft size={15} aria-hidden="true" />
          Back to Unlimited Puzzles
        </Link>
        <div className="mt-4">
          <SolitairePuzzle kind="unlimited" />
        </div>
        {/* The three daily surfaces are separate pages, so each one has to say
            where the others are — otherwise separating them just makes the
            others harder to find. */}
        <p className="mt-4 text-xs text-white/50" data-testid="unlimited-puzzles-cross-link">
          Want the day&apos;s official position?{" "}
          <Link
            href="/play/daily-puzzle/play"
            className="font-semibold text-sky-300 underline-offset-4 hover:text-sky-200 hover:underline"
          >
            Play the daily puzzle →
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
