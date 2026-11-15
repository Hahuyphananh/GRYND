// The Play hub's own social card.
//
// /play is the only page that answers "what can I play here", so its card has
// to show the six modes at a glance — a shared hub link should read as a menu,
// not as one of the six modes it links to.

import { SURFACE_CARD_SIZE, surfaceCardResponse } from "../../lib/surfaceCardImage";

export const alt =
  "GRYND Play hub — six ways to play Solitaire: Solo, Daily Challenge, Play vs AI, Ranked, Daily Puzzle and Unlimited Puzzles";
export const size = SURFACE_CARD_SIZE;
export const contentType = "image/png";

export default function PlayHubCard() {
  return surfaceCardResponse({
    kicker: "PLAY",
    title: "Six ways to play.",
    subtitle: "Solo, Daily Challenge, Play vs AI, Ranked, Daily Puzzle and Unlimited Puzzles.",
    points: ["Competitive", "Casual", "Puzzles"],
    accent: "#00e5ff",
  });
}
