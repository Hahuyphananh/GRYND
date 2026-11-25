import type { Metadata } from "next";

import LobbyStatus from "../../../components/play/LobbyStatus";
import ModeLobby from "../../../components/play/ModeLobby";

export const metadata: Metadata = {
  title: "Daily Solitaire Challenge lobby | GRYND",
  description:
    "Today's deterministic Solitaire deal, identical for every player. One official result per UTC day, with streak and best time.",
  alternates: { canonical: "/play/daily" },
};

export default function DailyLobbyPage() {
  return (
    <ModeLobby mode="daily">
      <LobbyStatus mode="daily" />
    </ModeLobby>
  );
}
