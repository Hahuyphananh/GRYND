// The daily CHALLENGE's own social card.
//
// Distinct from the puzzle cards on purpose: this page is the full Klondike
// deal everyone shares, not a position with an answer. The card says so —
// "one deal", "the same cards for every player" — so a link to /daily can never
// be mistaken for a link to a puzzle.

import { SURFACE_CARD_SIZE, surfaceCardResponse } from "../../lib/surfaceCardImage";

export const alt =
  "GRYND daily challenge — the same Klondike deal for every player, one official result a day";
export const size = SURFACE_CARD_SIZE;
export const contentType = "image/png";

export default function DailyChallengeCard() {
  return surfaceCardResponse({
    kicker: "DAILY CHALLENGE",
    title: "One deal. Everyone. Every day.",
    subtitle: "A full Klondike game, fixed by the UTC date. Refreshing cannot reroll it.",
    points: ["First completion is official", "Streak + best time", "No opponent"],
    accent: "#f5ff3b",
  });
}
