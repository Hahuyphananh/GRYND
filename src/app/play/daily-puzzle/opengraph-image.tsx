// The daily PUZZLE's own social card.
//
// One position, one answer, one official attempt — the card leads with that,
// because "daily" alone is ambiguous now that the challenge, the daily puzzle
// and the unlimited puzzles each have a page.

import { SURFACE_CARD_SIZE, surfaceCardResponse } from "../../../lib/surfaceCardImage";

export const alt =
  "GRYND daily puzzle — one verified Solitaire position a day, free for everyone";
export const size = SURFACE_CARD_SIZE;
export const contentType = "image/png";

export default function DailyPuzzleCard() {
  return surfaceCardResponse({
    kicker: "DAILY PUZZLE",
    title: "One position. One answer.",
    subtitle: "A verified Solitaire position per UTC day, free for every player.",
    points: ["One official attempt", "Submitting spends it", "New position at midnight UTC"],
    accent: "#38bdf8",
  });
}
