// The UNLIMITED PUZZLES surface's own social card.
//
// The distinguishing facts are the one-move format and the allowance, so the
// card states both: one best move per puzzle, five free per UTC day, unlimited
// on GRYND PRO and enforced server-side.

import { SURFACE_CARD_SIZE, surfaceCardResponse } from "../../../lib/surfaceCardImage";

export const alt =
  "GRYND unlimited Solitaire puzzles — one move each, 5 free per day, unlimited with GRYND PRO";
export const size = SURFACE_CARD_SIZE;
export const contentType = "image/png";

export default function UnlimitedPuzzlesCard() {
  return surfaceCardResponse({
    kicker: "UNLIMITED PUZZLES",
    title: "Practise all day.",
    subtitle: "One best move per puzzle, and no daily cap on PRO.",
    points: ["One move per puzzle", "5 free per UTC day", "Unlimited on PRO"],
    accent: "#e879f9",
  });
}
