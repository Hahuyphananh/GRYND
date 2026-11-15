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
      <main className="relative mx-auto max-w-4xl px-4 pt-24 sm:px-6 md:pt-28">
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
      </main>
      <Footer />
    </div>
  );
}
