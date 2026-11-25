import type { Metadata } from "next";

import LobbyStatus from "../../../components/play/LobbyStatus";
import ModeLobby from "../../../components/play/ModeLobby";
import { pageMetadata } from "../../../lib/seo";

const SOLO_TITLE = "Solo Solitaire lobby | GRYND";
const SOLO_DESCRIPTION =
  "Play Solo Klondike at your own pace. Unrated, with undo and personal statistics that never affect ranked Elo.";

export const metadata = pageMetadata({
  title: SOLO_TITLE,
  description: SOLO_DESCRIPTION,
  path: "/play/solo",
});

export default function SoloLobbyPage() {
  return (
    <ModeLobby mode="solo">
      <LobbyStatus mode="solo" />
    </ModeLobby>
  );
}
