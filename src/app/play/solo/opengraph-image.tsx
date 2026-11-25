// The Solo lobby's own social card.
//
// Solo is the unpressured surface: unrated, undo, personal statistics. The card
// leads with that so a shared /play/solo link does not read as a ranked match.

import { SURFACE_CARD_SIZE, surfaceCardResponse } from "../../../lib/surfaceCardImage";

export const alt =
  "GRYND Solo Solitaire lobby — unrated Klondike at your own pace, with undo and personal statistics";
export const size = SURFACE_CARD_SIZE;
export const contentType = "image/png";

export default function SoloLobbyCard() {
  return surfaceCardResponse({
    kicker: "SOLO",
    title: "Just you and the deck.",
    subtitle: "Unrated Klondike at your own pace. Undo freely; your stats stay yours.",
    points: ["Unrated", "Undo any move", "Never touches ranked Elo"],
    accent: "#34d399",
  });
}
