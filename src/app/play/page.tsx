import type { Metadata } from "next";

import PlayHub from "../../components/play/PlayHub";
import { pageMetadata } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Play Solitaire — six ways to play",
  description: "The central GRYND Solitaire hub: Solo, Daily Challenge, Play vs AI, Ranked, the Daily Puzzle and Unlimited Puzzles. Competitive, casual and puzzle modes in one place.",
  path: "/play",
});

export default function PlayPage() {
  return <PlayHub />;
}
