"use client";

// src/components/games/battleship/ShipVisual.tsx
//
// ONE ship, drawn as CSS blocks. This is the only component that knows what a
// ship looks like, which is what keeps future artwork isolated: when
// `./shipArtwork` gains a URL for a ship, this component renders an <img> in the
// same footprint and everything else (the shelf, the placement preview, the
// fleet board) keeps working untouched.
//
// BLOCK MODE (today)
//   One block per occupied cell, in ship order. Undamaged cells are blue
//   (#2f6bff), damaged cells red (#ef4444). The strip is horizontal or vertical
//   with the ship, so it lines up with the cells it covers — the same element is
//   used as an overlay across the board's occupied cells and as a compact row in
//   the fleet list.
//
// ARTWORK MODE (later)
//   Only reachable when the registry actually has a URL. No URL → no <img> at
//   all, so the game can never issue a request for a file that does not exist and
//   can never show a broken-image icon.

import { SHIP_LENGTHS } from "../../../lib/battleship/constants";
import type { Orientation, ShipKey } from "../../../lib/battleship/types";
import { shipArtworkFor } from "./shipArtwork";

export interface ShipVisualProps {
  ship: ShipKey;
  orientation?: Orientation;
  /** Per-cell damage, indexed from the ship's FIRST cell. */
  damaged?: readonly boolean[];
  /** Ghost styling for a placement preview. */
  preview?: boolean;
  /** `sm` is the fleet-list size; `md` fills the space it is given. */
  size?: "sm" | "md";
  className?: string;
}

export default function ShipVisual({
  ship,
  orientation = "horizontal",
  damaged = [],
  preview = false,
  size = "md",
  className = "",
}: ShipVisualProps) {
  const artwork = shipArtworkFor(ship);
  const length = SHIP_LENGTHS[ship];
  const vertical = orientation === "vertical";

  if (artwork) {
    return (
      <img
        src={artwork}
        alt=""
        aria-hidden="true"
        draggable={false}
        data-testid={`ship-visual-${ship}`}
        data-variant="artwork"
        data-orientation={orientation}
        className={`${vertical ? "rotate-90" : ""} h-full w-full object-contain ${preview ? "opacity-70" : ""} ${className}`}
      />
    );
  }

  return (
    <div
      data-testid={`ship-visual-${ship}`}
      data-variant="blocks"
      data-ship={ship}
      data-orientation={orientation}
      aria-hidden="true"
      className={`flex ${vertical ? "flex-col" : "flex-row"} h-full w-full gap-[2px] ${preview ? "opacity-70" : ""} ${className}`}
    >
      {Array.from({ length }, (_, index) => {
        const isDamaged = damaged[index] === true;
        return (
          <span
            key={index}
            data-cell={index}
            data-damaged={isDamaged ? "true" : "false"}
            className={`flex-1 rounded-[3px] border ${
              isDamaged
                ? "border-red-200 bg-[#ef4444]"
                : "border-[#8ab4ff]/70 bg-[#2f6bff]"
            } ${size === "sm" ? "min-h-2.5 min-w-2.5" : "min-h-0 min-w-0"}`}
          />
        );
      })}
    </div>
  );
}
