// src/components/games/battleship/shipArtwork.ts
//
// THE opt-in artwork registry for Battleship ships.
//
// It is EMPTY on purpose. There is no Battleship ship artwork in the repository
// yet, and the visuals must not depend on files that do not exist: a missing
// image would render a broken-image icon and issue a failed request. `ShipVisual`
// therefore asks THIS module first and falls back to the block rendering when it
// answers null — no <img> element is ever created for an unregistered ship.
//
// ── HOW TO ADD ARTWORK LATER ──────────────────────────────────────────────
//
//   1. Drop the files into `public/images/battleship/ships/` using exactly these
//      names: carrier.png, battleship.png, cruiser.png, submarine.png,
//      destroyer.png.
//   2. Map the ship to its public URL below, e.g.
//        carrier: "/images/battleship/ships/carrier.png",
//   3. That is the whole change. Nothing outside `ShipVisual` reads this
//      registry, so the block rendering and the board geometry are untouched —
//      the component keeps sizing the artwork into the same cell footprint.
//
// Do NOT add a URL here before the file exists: `shipArtworkFor` returns only
// entries that are present, and an entry pointing at a missing file is exactly
// the broken-image case this design avoids.

import type { ShipKey } from "../../../lib/battleship/types";

/** Where future ship art belongs (documentation + tests). */
export const SHIP_ARTWORK_DIRECTORY = "public/images/battleship/ships";

/** The file name each ship will use once art exists (documentation + tests). */
export const SHIP_ARTWORK_FILE_NAMES: Readonly<Record<ShipKey, string>> = {
  carrier: "carrier.png",
  battleship: "battleship.png",
  cruiser: "cruiser.png",
  submarine: "submarine.png",
  destroyer: "destroyer.png",
};

/**
 * Ship → public image URL. Deliberately empty; see the header. Filling a key is
 * the single switch that turns block visuals into artwork for that ship.
 */
export const SHIP_ARTWORK: Partial<Record<ShipKey, string>> = {};

/** The artwork URL for a ship, or null when it should render as CSS blocks. */
export function shipArtworkFor(ship: ShipKey): string | null {
  return SHIP_ARTWORK[ship] ?? null;
}
