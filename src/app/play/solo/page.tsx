import type { Metadata } from "next";

import LobbyStatus from "../../../components/play/LobbyStatus";
import ModeLobby from "../../../components/play/ModeLobby";

export const metadata: Metadata = {
  title: "Solo Solitaire lobby | GRYND",
  description:
    "Play Solo Klondike at your own pace. Unrated, with undo and personal statistics that never affect ranked Elo.",
  alternates: { canonical: "/play/solo" },
};

export default function SoloLobbyPage() {
  return (
    <ModeLobby mode="solo">
      <LobbyStatus mode="solo" />
    </ModeLobby>
  );
}
