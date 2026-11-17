import type { Metadata } from "next";

import LobbyStatus from "../../../components/play/LobbyStatus";
import ModeLobby from "../../../components/play/ModeLobby";
import { pageMetadata } from "../../../lib/seo";

const PUZZLE_TITLE = "Daily Solitaire Puzzle lobby | GRYND";
const PUZZLE_DESCRIPTION =
  "Three verified Solitaire positions from one winning deal, once per UTC day. One mistake ends the run. Free for everyone.";

export const metadata = pageMetadata({
  title: PUZZLE_TITLE,
  description: PUZZLE_DESCRIPTION,
  path: "/play/daily-puzzle",
});

export default function DailyPuzzleLobbyPage() {
  return (
    <ModeLobby mode="dailyPuzzle">
      <LobbyStatus mode="dailyPuzzle" />
    </ModeLobby>
  );
}
