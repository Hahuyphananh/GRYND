import type { Metadata } from "next";

import PlayHub from "../../components/play/PlayHub";
import { pageMetadata } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Play Solitaire — eight ways to play",
  description: "The central GRYND Solitaire hub: Solitaire Ranked, Puzzle Ranked, Play vs AI, Puzzle vs AI, Solo, Daily Challenge, the Daily Puzzle and Unlimited Puzzles. Competitive, practice and puzzle modes in one place.",
  path: "/play",
});

export default function PlayPage() {
  return <PlayHub />;
}
