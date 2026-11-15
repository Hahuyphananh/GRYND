// The daily PUZZLE's own social card.
//
// Three positions, one run — the card leads with that, because "daily" alone is
// ambiguous now that the challenge and the daily puzzle each have a page.

import { SURFACE_CARD_SIZE, surfaceCardResponse } from "../../../lib/surfaceCardImage";

export const alt =
  "GRYND daily puzzle — three verified Solitaire positions from one deal, free for everyone";
export const size = SURFACE_CARD_SIZE;
export const contentType = "image/png";

export default function DailyPuzzleCard() {
  return surfaceCardResponse({
    kicker: "DAILY PUZZLE",
    title: "Three steps. One run.",
    subtitle: "Three verified positions from one deal per UTC day, free for every player.",
    points: ["Best move at each step", "One mistake ends it", "New run at midnight UTC"],
    accent: "#38bdf8",
  });
}
