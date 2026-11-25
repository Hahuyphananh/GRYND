// The ranked lobby's own social card.
//
// Ranked is the only surface where a result moves a rating, so the card says
// exactly that: 1v1, humans, one shared deal, Elo. It must not promise bots —
// the bot shortcut was removed from this lobby and lives at /play/ai.

import { SURFACE_CARD_SIZE, surfaceCardResponse } from "../../../lib/surfaceCardImage";

export const alt =
  "GRYND Ranked Solitaire lobby — rated 1v1 Solitaire against real players, one shared deal, Elo on the line";
export const size = SURFACE_CARD_SIZE;
export const contentType = "image/png";

export default function RankedLobbyCard() {
  return surfaceCardResponse({
    kicker: "RANKED",
    title: "One deal. Two seats.",
    subtitle: "Rated 1v1 Solitaire against real humans. Same cards for both players.",
    points: ["Elo on the line", "One shared deal", "Humans only"],
    accent: "#f59e0b",
  });
}
