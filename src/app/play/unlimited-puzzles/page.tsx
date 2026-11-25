import type { Metadata } from "next";

import LobbyStatus from "../../../components/play/LobbyStatus";
import ModeLobby from "../../../components/play/ModeLobby";
import { pageMetadata } from "../../../lib/seo";

const UNLIMITED_TITLE = "Unlimited Solitaire Puzzles lobby | GRYND";
const UNLIMITED_DESCRIPTION =
  "Practice Solitaire puzzles: one best move per puzzle, 5 free per UTC day and unlimited with GRYND Pro. The allowance is enforced server-side.";

export const metadata = pageMetadata({
  title: UNLIMITED_TITLE,
  description: UNLIMITED_DESCRIPTION,
  path: "/play/unlimited-puzzles",
});

export default function UnlimitedPuzzlesLobbyPage() {
  return (
    <ModeLobby mode="unlimited">
      <LobbyStatus mode="unlimited" />
    </ModeLobby>
  );
}
