import type { Metadata } from "next";

import SolitaireLobby from "../../../components/solitaire-duel/SolitaireLobby";

const RANKED_TITLE = "Ranked Solitaire lobby | GRYND";
const RANKED_DESCRIPTION =
  "Rated 1v1 Solitaire against real human players. One shared deal, both seats, Elo and trophies on the line.";

export const metadata: Metadata = {
  title: RANKED_TITLE,
  description: RANKED_DESCRIPTION,
  alternates: { canonical: "/play/ranked" },
  openGraph: {
    title: RANKED_TITLE,
    description: RANKED_DESCRIPTION,
    url: "/play/ranked",
    type: "website",
  },
  // Card: ./opengraph-image.tsx — humans only; bots live at /play/ai.
  twitter: {
    card: "summary_large_image",
    title: RANKED_TITLE,
    description: RANKED_DESCRIPTION,
  },
};

/**
 * Reuse the existing ranked lobby. The bot shortcut was removed from that
 * lobby; AI is reachable through /play/ai, so ranked is humans only.
 */
export default function RankedLobbyPage() {
  return <SolitaireLobby variant="page" />;
}
