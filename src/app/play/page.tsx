import type { Metadata } from "next";

import PlayHub from "../../components/play/PlayHub";

export const metadata: Metadata = {
  title: "Play Solitaire — six ways to play | GRYND",
  description:
    "The central GRYND Solitaire hub: Solo, Daily Challenge, Play vs AI, Ranked, Daily Puzzle and Unlimited Puzzles. Competitive, casual and puzzle modes in one place.",
  alternates: { canonical: "/play" },
  openGraph: {
    title: "Play Solitaire — six ways to play",
    description:
      "Solo, Daily Challenge, Play vs AI, Ranked, Daily Puzzle and Unlimited Puzzles.",
    url: "/play",
    type: "website",
  },
  // Card: ./opengraph-image.tsx — the twenty-four-pixel-wide menu, not a mode.
  twitter: {
    card: "summary_large_image",
    title: "Play Solitaire — six ways to play",
    description:
      "Solo, Daily Challenge, Play vs AI, Ranked, Daily Puzzle and Unlimited Puzzles.",
  },
};

export default function PlayPage() {
  return <PlayHub />;
}
