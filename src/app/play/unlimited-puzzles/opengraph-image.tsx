// The UNLIMITED PUZZLES surface's own social card.
//
// The distinguishing fact is the allowance, so the card states it: five free
// puzzles per UTC day, unlimited on GRYND PRO, enforced server-side.

import { SURFACE_CARD_SIZE, surfaceCardResponse } from "../../../lib/surfaceCardImage";

export const alt =
  "GRYND unlimited Solitaire puzzles — 5 free per day, unlimited with GRYND PRO";
export const size = SURFACE_CARD_SIZE;
export const contentType = "image/png";

export default function UnlimitedPuzzlesCard() {
  return surfaceCardResponse({
    kicker: "UNLIMITED PUZZLES",
    title: "Practise all day.",
    subtitle: "Fresh verified Solitaire positions with no daily cap on PRO.",
    points: ["5 free per UTC day", "Unlimited on PRO", "Server-enforced allowance"],
    accent: "#e879f9",
  });
}
