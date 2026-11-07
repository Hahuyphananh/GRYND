"use client";

// src/components/games/battleship/ShipVisual.tsx
//
// ONE ship. This is the only component that knows what a ship looks like, which
// is what keeps the artwork isolated: the fleet shelf, the placement preview and
// both boards all render this component, so a ship looks the same everywhere.
//
// ARTWORK MODE (carrier, battleship, cruiser, submarine, destroyer)
//   The illustrations are PORTRAIT — a tall, narrow top-down ship with the bow
//   UP — so the two orientations are handled differently on purpose:
//
//     * VERTICAL: the image is drawn as-is, filling the tall footprint.
//     * HORIZONTAL: the same image is rotated 90° onto the run (bow left).
//       Rotating an `h-full w-full object-contain` image inside a wide box does
//       NOT work: `object-contain` fits the sprite to the box's HEIGHT, so a
//       5-cell carrier would shrink to roughly one cell wide. Instead the inner
//       box is given the footprint's dimensions SWAPPED (one cell wide, N cells
//       long — via container query units) and that box is rotated onto the run.
//       After the rotation it measures exactly the footprint, so the sprite
//       fills it, keeps its proportions, and `overflow-hidden` guarantees it
//       cannot spill into a neighbouring cell, label or attack marker.
//
//   The PNGs have a transparent background, so the cells, grid lines and hit
//   colours stay visible around the hull. A damaged cell is still marked with a
//   red pip on top of the art, because an opaque ship sprite would otherwise
//   hide the board's hit state under it.
//
// BLOCK MODE (the Frigate, or any ship without a URL)
//   One block per occupied cell, in ship order. Undamaged cells are blue
//   (#2f6bff), damaged cells red (#ef4444). No URL → no <img> at all, so the
//   game can never request a file that does not exist.

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
      <span
        data-testid={`ship-visual-${ship}`}
        data-variant="artwork"
        data-ship={ship}
        data-orientation={orientation}
        aria-hidden="true"
        className={`relative block h-full w-full overflow-hidden ${preview ? "opacity-70" : ""} ${className}`}
        // A size container is what gives the sprite the footprint's own
        // measurements, so the rotation needs no JavaScript and survives a
        // resize (phone rotation, split view, a tablet turning).
        style={{ containerType: "size" }}
      >
        <img
          src={artwork}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          // Scaled so the ship's LENGTH is the footprint (its height when
          // vertical, the run when horizontal) and the other axis follows the
          // file's own proportions — so every ship spans exactly its cells and
          // nothing is distorted. (`object-contain` would instead fit the widest
          // sprite — the submarine — to one cell and shrink it below two cells.)
          // The container-query units keep that length definite: a percentage
          // height resolves against the auto-sized grid row and stretches the
          // whole board. `max-w-none` defeats Tailwind's global
          // `img { max-width: 100% }`, which would re-introduce the shrink.
          className={
            vertical
              ? "mx-auto block w-auto max-w-none"
              : "absolute left-1/2 top-1/2 w-auto max-w-none -translate-x-1/2 -translate-y-1/2 rotate-90"
          }
          // Anything wider than one cell is clipped by the wrapper's
          // `overflow-hidden`, so a sprite never paints over a neighbour.
          style={{ height: vertical ? "100cqh" : "100cqw", maxWidth: "none" }}
        />
        {damaged.some(Boolean) ? (
          <span className="pointer-events-none absolute inset-0">
            {Array.from({ length }, (_, index) =>
              damaged[index] === true ? (
                <span
                  key={index}
                  data-hit-cell={index}
                  className="absolute rounded-[2px] bg-[#ef4444] ring-1 ring-red-200"
                  style={
                    vertical
                      ? {
                          left: "22%",
                          right: "22%",
                          top: `${(index / length) * 100}%`,
                          height: `${100 / length}%`,
                        }
                      : {
                          top: "22%",
                          bottom: "22%",
                          left: `${(index / length) * 100}%`,
                          width: `${100 / length}%`,
                        }
                  }
                />
              ) : null,
            )}
          </span>
        ) : null}
      </span>
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
