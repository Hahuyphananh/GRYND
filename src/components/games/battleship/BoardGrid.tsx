"use client";

// src/components/games/battleship/BoardGrid.tsx
//
// A 14×10 landscape Battleship board with A–N / 1–10 labels, fluid sizing and ONE rule
// about hidden information: ship sprites are only ever drawn when the caller
// passes `ships`, and only the viewer's own fleet ever passes them. The enemy
// board is therefore structurally incapable of showing a ship.
//
// The grid is a single CSS grid of 11 columns (a label column + ten cells) and
// 11 rows (a label row + ten cells), so labels line up with their cells at every
// width without measuring anything. Ship strips and the placement preview are
// grid items placed with `gridColumn` / `gridRow`, which is why a ship renders as
// ONE element spanning its occupied cells rather than as disconnected per-cell
// blocks.
//
// MOBILE: cells are `aspect-square` with a minimum touch height, the board is
// width-limited by its container (never a fixed pixel width), and every cell is a
// real <button> with an accessible label — so the Android WebView gets the same
// reliable tap target Chrome does.

import { Fragment } from "react";
import { motion } from "framer-motion";

import {
  BOARD_CELL,
  BOARD_COLUMNS,
  BOARD_ROWS,
  COLUMNS,
  ROWS,
  SHIP_LENGTHS,
} from "../../../lib/battleship/constants";
import type { BoardCell, Coordinate, ShipPlacement } from "../../../lib/battleship/types";
import ShipVisual from "./ShipVisual";

/** A ship drawn over the board's own cells. */
export interface BoardShipSprite {
  placement: ShipPlacement;
  /** Per-cell damage, indexed from the ship's first cell. */
  damaged?: readonly boolean[];
}

export interface BoardGridProps {
  title: string;
  subtitle?: string | null;
  /** `cells[y][x]` — only revealed attack results, never ship positions. */
  cells: readonly (readonly BoardCell[])[];
  /** The VIEWER's own fleet only. Omitted entirely on the enemy board. */
  ships?: readonly BoardShipSprite[];
  selected?: Coordinate | null;
  /** Cell labels to flash — the two attacks of a just-resolved round. */
  highlight?: readonly string[];
  preview?: { readonly placement: ShipPlacement; readonly valid: boolean } | null;
  onCellClick?: (coordinate: Coordinate) => void;
  onCellDrop?: (coordinate: Coordinate) => void;
  onCellHover?: (coordinate: Coordinate | null) => void;
  isCellDisabled?: (coordinate: Coordinate) => boolean;
  testId?: string;
  footnote?: string | null;
}

const CELL_MARK_CLASS: Readonly<Record<BoardCell, string>> = {
  unknown: "bg-[#0a1a3d] border-white/10 hover:border-[#ffec08]/60",
  miss: "bg-white border-white",
  hit: "bg-[#ef4444] border-red-300",
  sunk: "bg-[#991b1b] border-red-400",
};

/** How many cells a ship spans along its own axis. */
function shipSpan(placement: ShipPlacement): number {
  return SHIP_LENGTHS[placement.ship];
}

/**
 * True when every cell of the sprite is on the board.
 *
 * A sprite is a grid item spanning the cells it covers, so one whose run leaves
 * the board would create implicit grid tracks: the board would grow past its
 * container, the cells would shrink, and the pointer would land on a different
 * cell — which is exactly the violent layout oscillation this guard prevents.
 * A placement that does not fit is simply not drawn.
 */
function fitsOnBoard(placement: ShipPlacement): boolean {
  const span = shipSpan(placement);
  const lastX = placement.orientation === "vertical" ? placement.x : placement.x + span - 1;
  const lastY = placement.orientation === "vertical" ? placement.y + span - 1 : placement.y;
  return (
    placement.x >= 0 && placement.y >= 0 && lastX < BOARD_COLUMNS && lastY < BOARD_ROWS
  );
}

export default function BoardGrid({
  title,
  subtitle = null,
  cells,
  ships = [],
  selected = null,
  highlight = [],
  preview = null,
  onCellClick,
  onCellDrop,
  onCellHover,
  isCellDisabled,
  testId,
  footnote = null,
}: BoardGridProps) {
  return (
    <figure data-testid={testId} className="w-full min-w-0">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#ffec08]">{title}</span>
        {subtitle ? <span className="text-[10px] text-white/40">{subtitle}</span> : null}
      </figcaption>

      {/* A phone cannot give fourteen columns a tappable target inside its own
          width: at 320px each cell would be ~16px. The board therefore keeps a
          MINIMUM WIDTH at phone sizes and the strip scrolls sideways instead of
          shrinking every cell into a sliver. From `sm` up the board fits its
          card, the floor is released, and nothing scrolls. */}
      <div
        data-testid={testId ? `${testId}-scroll` : undefined}
        className="w-full overflow-x-auto overflow-y-hidden pb-1"
      >
      <div
        className="grid w-full min-w-[28rem] touch-manipulation select-none gap-[2px] sm:min-w-0"
        style={{ gridTemplateColumns: `1.1rem repeat(${BOARD_COLUMNS}, minmax(0, 1fr))` }}
      >
        <span aria-hidden="true" />
        {COLUMNS.map((column) => (
          <span
            key={`column-${column}`}
            className="text-center text-[9px] font-bold leading-none text-white/45 sm:text-[10px]"
          >
            {column}
          </span>
        ))}

        {ROWS.map((row, y) => (
          <Fragment key={`row-${row}`}>
            {/* Labels, cells and ship sprites are ALL placed explicitly. Ships are
                definite grid items, so the CSS auto-placement algorithm lays them
                out first and then flows auto-placed cells around them — which
                pushed cells and row numbers out of their rows as soon as a fleet
                was on the board. Giving every item its own slot makes the layout
                independent of DOM order and of what is drawn on top. */}
            <span
              data-testid={testId ? `${testId}-row-${row}` : undefined}
              style={{ gridColumn: 1, gridRow: y + 2 }}
              className="sticky left-0 z-30 flex items-center justify-center bg-[#050f24] text-[9px] font-bold leading-none text-white/45 sm:text-[10px]"
            >
              {row}
            </span>
            {COLUMNS.map((column, x) => {
              const coordinate = { x, y };
              const mark = cells[y]?.[x] ?? BOARD_CELL.UNKNOWN;
              const isSelected = selected?.x === x && selected?.y === y;
              const disabled = isCellDisabled ? isCellDisabled(coordinate) : false;
              const label = `${column}${row}`;
              const highlighted = highlight.includes(label);

              return (
                <button
                  key={`cell-${label}`}
                  type="button"
                  data-testid={testId ? `${testId}-cell-${label}` : undefined}
                  data-mark={mark}
                  data-reveal={highlighted ? "true" : "false"}
                  aria-label={mark === BOARD_CELL.UNKNOWN ? label : `${label} ${mark}`}
                  aria-pressed={isSelected}
                  disabled={disabled}
                  onClick={onCellClick ? () => onCellClick(coordinate) : undefined}
                  onDragOver={
                    onCellDrop
                      ? (event) => {
                          event.preventDefault();
                        }
                      : undefined
                  }
                  onDrop={
                    onCellDrop
                      ? (event) => {
                          event.preventDefault();
                          onCellDrop(coordinate);
                        }
                      : undefined
                  }
                  onMouseEnter={onCellHover ? () => onCellHover(coordinate) : undefined}
                  onMouseLeave={onCellHover ? () => onCellHover(null) : undefined}
                  style={{ gridColumn: x + 2, gridRow: y + 2 }}
                  className={`relative aspect-square min-h-4 w-full rounded-[3px] border transition sm:min-h-6 ${
                    CELL_MARK_CLASS[mark]
                  } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  {isSelected ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0.5 rounded-[2px] border-2 border-[#ffec08] bg-[#ffec08]/20"
                    />
                  ) : null}
                  {highlighted ? (
                    <motion.span
                      key={`reveal-${label}`}
                      aria-hidden="true"
                      initial={{ opacity: 0.9, scale: 0.5 }}
                      animate={{ opacity: 0, scale: 1.5 }}
                      transition={{ duration: 0.9, ease: "easeOut" }}
                      className="pointer-events-none absolute inset-0 rounded-[3px] ring-2 ring-[#ffec08]"
                    />
                  ) : null}
                </button>
              );
            })}
          </Fragment>
        ))}

        {ships.map(({ placement, damaged = [] }) =>
          fitsOnBoard(placement) ? (
            <div
              key={`ship-${placement.ship}`}
              aria-hidden="true"
              data-testid={`board-ship-${placement.ship}`}
              className="pointer-events-none z-10 p-[2px]"
              style={{
                gridColumn: `${placement.x + 2} / span ${
                  placement.orientation === "vertical" ? 1 : shipSpan(placement)
                }`,
                gridRow: `${placement.y + 2} / span ${
                  placement.orientation === "vertical" ? shipSpan(placement) : 1
                }`,
              }}
            >
              <ShipVisual
                ship={placement.ship}
                orientation={placement.orientation}
                damaged={damaged}
              />
            </div>
          ) : null,
        )}

        {preview && fitsOnBoard(preview.placement) ? (
          <div
            aria-hidden="true"
            data-testid="board-preview"
            data-valid={preview.valid ? "true" : "false"}
            className="pointer-events-none z-20 p-[2px]"
            style={{
              gridColumn: `${preview.placement.x + 2} / span ${
                preview.placement.orientation === "vertical" ? 1 : shipSpan(preview.placement)
              }`,
              gridRow: `${preview.placement.y + 2} / span ${
                preview.placement.orientation === "vertical" ? shipSpan(preview.placement) : 1
              }`,
            }}
          >
            <div
              className={`h-full w-full rounded-[4px] border-2 ${
                preview.valid ? "border-[#ffec08]/70" : "border-red-400"
              }`}
            >
              <ShipVisual
                ship={preview.placement.ship}
                orientation={preview.placement.orientation}
                preview
              />
            </div>
          </div>
        ) : null}
      </div>
      </div>

      {/* The strip scrolls on phones, so say so — and only on phones, because
          from `sm` up the whole board is already visible. */}
      <p className="mt-1 text-[10px] leading-snug text-white/35 sm:hidden">
        Swipe the board sideways for the far columns.
      </p>

      {/* A fixed height keeps the card from resizing when the footnote changes
          between the hint and a rejection message. */}
      {footnote ? (
        <p className="mt-2 min-h-9 text-[10px] leading-snug text-white/40">{footnote}</p>
      ) : null}
    </figure>
  );
}
