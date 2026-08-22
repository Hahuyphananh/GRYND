import type { Metadata } from "next";
import UnoMultiplayerPage from "../../casino/uno/multiplayer/page";
import { OG_BASE_URL } from "../../../lib/ogImages";

export const metadata: Metadata = {
  title: "Uno Multiplayer — GoonBet",
  description:
    "Play Uno multiplayer on GoonBet — challenge other players in real-time card duels.",
  alternates: {
    // Alias route — consolidate indexing on the canonical /games/uno/multiplayer
    // (/casino/uno/multiplayer 308-redirects to it; see next.config.js).
    canonical: `${OG_BASE_URL}/games/uno/multiplayer`,
  },
};

export default function Page() {
  return <UnoMultiplayerPage />;
}
