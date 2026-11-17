import type { Metadata } from "next";

import SolitaireLobby from "../../../components/solitaire-duel/SolitaireLobby";
import { pageMetadata } from "../../../lib/seo";

const RANKED_TITLE = "Ranked Solitaire lobby | GRYND";
const RANKED_DESCRIPTION =
  "Rated 1v1 Solitaire against real human players. One shared deal, both seats, Elo and trophies on the line.";

export const metadata = pageMetadata({
  title: RANKED_TITLE,
  description: RANKED_DESCRIPTION,
  path: "/play/ranked",
});

/**
 * Reuse the existing ranked lobby. The bot shortcut was removed from that
 * lobby; AI is reachable through /play/ai, so ranked is humans only.
 */
export default function RankedLobbyPage() {
  return <SolitaireLobby variant="page" />;
}
