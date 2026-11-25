// The Play vs AI lobby's own social card.
//
// This lobby is the unrated bot picker: six named opponents from Rookie to
// Perfect. The card names the range so a shared link does not read as ranked,
// and says "unrated" because nothing here moves Elo.

import { SURFACE_CARD_SIZE, surfaceCardResponse } from "../../../lib/surfaceCardImage";

export const alt =
  "GRYND Play vs AI lobby — six unrated Solitaire opponents, from Rookie to Perfect";
export const size = SURFACE_CARD_SIZE;
export const contentType = "image/png";

export default function PlayAiLobbyCard() {
  return surfaceCardResponse({
    kicker: "PLAY VS AI",
    title: "Six opponents. No rating.",
    subtitle: "Rookie, Felix, Ace, Professor, Grandmaster and Perfect — unrated practice.",
    points: ["Unrated", "Six bots", "Rookie to Perfect"],
    accent: "#a78bfa",
  });
}
