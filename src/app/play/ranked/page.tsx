import type { Metadata } from "next";

import SolitaireLobby from "../../../components/solitaire-duel/SolitaireLobby";

export const metadata: Metadata = {
  title: "Ranked Solitaire lobby | GRYND",
  description:
    "Rated 1v1 Solitaire against real human players. One shared deal, both seats, Elo and trophies on the line.",
  alternates: { canonical: "/play/ranked" },
};

/**
 * Reuse the existing ranked lobby. The bot shortcut was removed from that
 * lobby; AI is reachable through /play/ai, so ranked is humans only.
 */
export default function RankedLobbyPage() {
  return <SolitaireLobby variant="page" />;
}
