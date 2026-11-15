import type { Metadata } from "next";

import LobbyStatus from "../../../components/play/LobbyStatus";
import ModeLobby from "../../../components/play/ModeLobby";

const SOLO_TITLE = "Solo Solitaire lobby | GRYND";
const SOLO_DESCRIPTION =
  "Play Solo Klondike at your own pace. Unrated, with undo and personal statistics that never affect ranked Elo.";

export const metadata: Metadata = {
  title: SOLO_TITLE,
  description: SOLO_DESCRIPTION,
  alternates: { canonical: "/play/solo" },
  openGraph: {
    title: SOLO_TITLE,
    description: SOLO_DESCRIPTION,
    url: "/play/solo",
    type: "website",
  },
  // Card: ./opengraph-image.tsx — unrated, so it must not read as a ranked link.
  twitter: {
    card: "summary_large_image",
    title: SOLO_TITLE,
    description: SOLO_DESCRIPTION,
  },
};

export default function SoloLobbyPage() {
  return (
    <ModeLobby mode="solo">
      <LobbyStatus mode="solo" />
    </ModeLobby>
  );
}
