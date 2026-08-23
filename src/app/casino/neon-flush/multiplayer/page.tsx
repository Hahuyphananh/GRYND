import type { Metadata } from "next";
import NeonFlushMultiplayerPage from "../../uno/multiplayer/page";
import { OG_BASE_URL } from "../../../../lib/ogImages";

export const metadata: Metadata = {
  title: "Neon Flush Multiplayer | GRYND",
  description:
    "Play Neon Flush multiplayer on GRYND. Challenge other players in real-time card duels.",
  alternates: {
    // Alias route — consolidate indexing on the canonical /games/uno/multiplayer
    // (/casino/uno/multiplayer 308-redirects to it; see next.config.js).
    canonical: `${OG_BASE_URL}/games/uno/multiplayer`,
  },
};

export default function Page() {
  return <NeonFlushMultiplayerPage />;
}
