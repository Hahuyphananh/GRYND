import type { Metadata } from "next";

import LobbyStatus from "../../../components/play/LobbyStatus";
import ModeLobby from "../../../components/play/ModeLobby";

const UNLIMITED_TITLE = "Unlimited Solitaire Puzzles lobby | GRYND";
const UNLIMITED_DESCRIPTION =
  "Practice Solitaire puzzles: 5 free per UTC day, unlimited with GRYND Pro. The allowance is enforced server-side.";

export const metadata: Metadata = {
  title: UNLIMITED_TITLE,
  description: UNLIMITED_DESCRIPTION,
  alternates: { canonical: "/play/unlimited-puzzles" },
  openGraph: {
    title: UNLIMITED_TITLE,
    description: UNLIMITED_DESCRIPTION,
    url: "/play/unlimited-puzzles",
    type: "website",
  },
  // Card: ./opengraph-image.tsx — the allowance is the distinguishing fact.
  twitter: {
    card: "summary_large_image",
    title: UNLIMITED_TITLE,
    description: UNLIMITED_DESCRIPTION,
  },
};

export default function UnlimitedPuzzlesLobbyPage() {
  return (
    <ModeLobby mode="unlimited">
      <LobbyStatus mode="unlimited" />
    </ModeLobby>
  );
}
