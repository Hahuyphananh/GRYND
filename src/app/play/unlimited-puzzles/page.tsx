import type { Metadata } from "next";

import LobbyStatus from "../../../components/play/LobbyStatus";
import ModeLobby from "../../../components/play/ModeLobby";

export const metadata: Metadata = {
  title: "Unlimited Solitaire Puzzles lobby | GRYND",
  description:
    "Practice Solitaire puzzles: 5 free per UTC day, unlimited with GRYND Pro. The allowance is enforced server-side.",
  alternates: { canonical: "/play/unlimited-puzzles" },
};

export default function UnlimitedPuzzlesLobbyPage() {
  return (
    <ModeLobby mode="unlimited">
      <LobbyStatus mode="unlimited" />
    </ModeLobby>
  );
}
