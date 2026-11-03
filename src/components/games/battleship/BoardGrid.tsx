"use client";

// src/components/games/battleship/BoardGrid.tsx
//
// A 10×10 Battleship board with A–J / 1–10 labels, fluid sizing and ONE rule
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

import { BOARD_CELL, COLUMNS, ROWS, SHIP_LENGTHS } from "../../../lib/battleship/constants";
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

      <div
        className="grid w-full touch-manipulation select-none gap-[2px]"
        style={{ gridTemplateColumns: "1.1rem repeat(10, minmax(0, 1fr))" }}
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
            <span className="flex items-center justify-center text-[9px] font-bold leading-none text-white/45 sm:text-[10px]">
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
                  className={`relative aspect-square min-h-7 w-full rounded-[3px] border transition sm:min-h-8 ${
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

        {ships.map(({ placement, damaged = [] }) => (
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
            <ShipVisual ship={placement.ship} orientation={placement.orientation} damaged={damaged} />
          </div>
        ))}

        {preview ? (
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

      {footnote ? <p className="mt-2 text-[10px] leading-snug text-white/40">{footnote}</p> : null}
    </figure>
  );
}
