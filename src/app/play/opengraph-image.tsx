// The Play hub's own social card.
//
// /play is the only page that answers "what can I play here", so its card has
// to show the five modes at a glance — a shared hub link should read as a menu,
// not as one of the five modes it links to.

import { SURFACE_CARD_SIZE, surfaceCardResponse } from "../../lib/surfaceCardImage";

export const alt =
  "GRYND Play hub — five ways to play Solitaire: Solo, Daily Challenge, Play vs AI, Ranked and the Daily Puzzle";
export const size = SURFACE_CARD_SIZE;
export const contentType = "image/png";

export default function PlayHubCard() {
  return surfaceCardResponse({
    kicker: "PLAY",
    title: "Five ways to play.",
    subtitle: "Solo, Daily Challenge, Play vs AI, Ranked and the Daily Puzzle.",
    points: ["Competitive", "Casual", "Puzzles"],
    accent: "#00e5ff",
  });
}
