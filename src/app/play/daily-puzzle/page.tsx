import type { Metadata } from "next";

import LobbyStatus from "../../../components/play/LobbyStatus";
import ModeLobby from "../../../components/play/ModeLobby";

export const metadata: Metadata = {
  title: "Daily Solitaire Puzzle lobby | GRYND",
  description:
    "One verified Solitaire position per UTC day. One official attempt: submitting an answer spends it, right or wrong. Free for everyone.",
  alternates: { canonical: "/play/daily-puzzle" },
};

export default function DailyPuzzleLobbyPage() {
  return (
    <ModeLobby mode="dailyPuzzle">
      <LobbyStatus mode="dailyPuzzle" />
    </ModeLobby>
  );
}
