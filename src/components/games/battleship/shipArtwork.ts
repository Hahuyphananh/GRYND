// src/components/games/battleship/shipArtwork.ts
//
// THE artwork registry for Battleship ships.
//
// Five ships have art; the FRIGATE deliberately does not (no illustration was
// generated for it), so it keeps the CSS-block rendering. `ShipVisual` asks this
// module first and falls back to blocks whenever it answers null — no <img>
// element is ever created for an unregistered ship, so a missing file can never
// become a broken-image icon or a failed request.
//
// The files live in `public/images/battleship/ships/`. They were generated as
// PORTRAIT, top-down illustrations (bow UP, stern DOWN) on an opaque white
// backdrop; the committed copies are the same art with that backdrop keyed to
// transparency and trimmed to the hull, which is what lets `ShipVisual` lay them
// over the board's cells without painting a white box across them.
//
// ── HOW TO ADD / REPLACE ART ──────────────────────────────────────────────
//
//   1. Drop the file into `public/images/battleship/ships/` using the name in
//      `SHIP_ARTWORK_FILE_NAMES`.
//   2. Map the ship to its public URL in `SHIP_ARTWORK` below.
//   3. That is the whole change. Nothing outside `ShipVisual` reads this
//      registry, so the block rendering and the board geometry are untouched —
//      the component keeps sizing the artwork into the same cell footprint.
//
// Do NOT add a URL here before the file exists: `shipArtworkFor` returns only
// entries that are present, and an entry pointing at a missing file is exactly
// the broken-image case this design avoids.

import type { ShipKey } from "../../../lib/battleship/types";

/** Where ship art lives (documentation + tests). */
export const SHIP_ARTWORK_DIRECTORY = "public/images/battleship/ships";

/** The file name each ship uses (documentation + tests). */
export const SHIP_ARTWORK_FILE_NAMES: Readonly<Record<ShipKey, string>> = {
  carrier: "carrier.png",
  battleship: "battleship.png",
  cruiser: "cruiser.png",
  submarine: "submarine.png",
  frigate: "frigate.png",
  destroyer: "destroyer.png",
};

/**
 * Ship → public image URL. A ship missing here renders as CSS blocks, which is
 * how the Frigate (no artwork yet) is handled as well as any future ship whose
 * file has not landed.
 */
export const SHIP_ARTWORK: Partial<Record<ShipKey, string>> = {
  carrier: "/images/battleship/ships/carrier.png",
  battleship: "/images/battleship/ships/battleship.png",
  cruiser: "/images/battleship/ships/cruiser.png",
  submarine: "/images/battleship/ships/submarine.png",
  destroyer: "/images/battleship/ships/destroyer.png",
  // frigate: no illustration yet — stays on the CSS-block fallback.
};

/** The artwork URL for a ship, or null when it should render as CSS blocks. */
export function shipArtworkFor(ship: ShipKey): string | null {
  return SHIP_ARTWORK[ship] ?? null;
}
