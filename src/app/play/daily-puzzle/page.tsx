import type { Metadata } from "next";

import LobbyStatus from "../../../components/play/LobbyStatus";
import ModeLobby from "../../../components/play/ModeLobby";

const PUZZLE_TITLE = "Daily Solitaire Puzzle lobby | GRYND";
const PUZZLE_DESCRIPTION =
  "Three verified Solitaire positions from one winning deal, once per UTC day. One mistake ends the run. Free for everyone.";

export const metadata: Metadata = {
  title: PUZZLE_TITLE,
  description: PUZZLE_DESCRIPTION,
  alternates: { canonical: "/play/daily-puzzle" },
  openGraph: {
    title: PUZZLE_TITLE,
    description: PUZZLE_DESCRIPTION,
    url: "/play/daily-puzzle",
    type: "website",
  },
  // Card: ./opengraph-image.tsx — deliberately different from the daily
  // challenge card.
  twitter: {
    card: "summary_large_image",
    title: PUZZLE_TITLE,
    description: PUZZLE_DESCRIPTION,
  },
};

export default function DailyPuzzleLobbyPage() {
  return (
    <ModeLobby mode="dailyPuzzle">
      <LobbyStatus mode="dailyPuzzle" />
    </ModeLobby>
  );
}
