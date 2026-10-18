// src/components/game-ui/GameCell.tsx
//
// A SHARED BOARD CELL.
//
// ── ONE CELL, OPT-IN STATES ───────────────────────────────────────────────
//
// A game passes only the states its OWN rules have. Tic-Tac-Toe passes
// `legalMove` + `owned`; Sudoku passes `selected` + `disabled`; Memory Grid
// passes `occupied` and nothing else. Every state is a separate optional prop,
// so a game that never shows a legal-move hint never renders one, and a game
// with no ownership concept never gets an ownership ring.
//
//   default    a recessed socket in the panel token, hairline edge
//   hover      cyan-tinted edge + raised fill (interactive cells only)
//   focus      the focus ring token, 2px, offset — keyboard only
//   selected   the brand-yellow DASHED outline (a shape cue, not just a colour)
//   legal      the hollow `.gr-legal-move` ring: 17.57:1 on the dark ground and
//              7.15:1 on the light one, so it survives both themes
//   occupied   raised fill, still outlined
//   disabled   the disabled ink/surface tokens, no interaction at all
//
// ── INTERACTION, AND WHY IT IS NOT A NATIVE `disabled` ────────────────────
//
// A cell with an `onSelect` renders a real <button>, so Tab reaches it and
// Enter/Space fire it, exactly like the existing tic-tac-toe board. A cell
// that is NOT offered by the game keeps `aria-disabled="true"` and stays
// FOCUSABLE rather than going `disabled`: a keyboard or screen-reader player
// must still be able to travel across every cell and hear what is in it. The
// click handler is guarded too, so a click on an unofferable cell does nothing
// at all — it must not even reach the caller.
//
// Ownership is never colour alone: `owner` (1 | 2) draws the seat's SHAPE cue
// (a circle pip or a diamond pip, from `--gr-seat-1-shape` / `--gr-seat-2-shape`
// via .gr-seat-pip--invert) and the inset ownership ring, and `ownerLabel` can
// add the owner to the accessible name for a player who cannot see either.

import type { ReactNode } from "react";

import type { GameBoardShape } from "./GameBoardFrame";

/** Who owns the cell: seat 1, seat 2, or nobody. */
export type GameSeat = 1 | 2 | null;

export type GameCellProps = {
  children?: ReactNode;
  /** The game's selection state (a move source, a highlighted cell). */
  selected?: boolean;
  /** The game will not accept an interaction here. */
  disabled?: boolean;
  /** This cell holds something (a mark, a tile, a revealed card). */
  occupied?: boolean;
  /** This cell is a legal destination and should advertise it. */
  legalMove?: boolean;
  /** The owning seat — drives the ownership ring AND the shape cue. */
  owner?: GameSeat;
  /** Accessible name, e.g. "Row 2, column 3 — empty. Press to place X." */
  label?: string;
  /**
   * Owner's name, appended to the accessible label. Colour and shape convey
   * ownership visually; this is the third, non-visual cue.
   */
  ownerLabel?: string;
  /** Grid semantics. Omit outside a role="grid"/"list" parent. */
  role?: "gridcell" | "listitem" | "button" | "presentation";
  /** 1-based grid coordinates, for `aria-rowindex` / `aria-colindex`. */
  rowIndex?: number;
  colIndex?: number;
  /** Presence makes the cell interactive (a real <button>). */
  onSelect?: () => void;
  /** Cell corner rendering. `sharp` matches the Four-In-A-Row HUD language. */
  shape?: GameBoardShape;
  /**
   * Square cells, ON by default.
   *
   * A grid cell with no ratio collapses to its border height (measured: a
   * 9-column board at 320px gave 22×2px), which is never what a board wants.
   * This is a per-CELL ratio and says nothing about the board: the FRAME still
   * imposes no ratio, and a game whose cells are oblong (a card slot, a wide
   * bar) passes `square={false}` and sizes them itself.
   */
  square?: boolean;
  /**
   * OPT-IN 44px floor for boards with the room for it (3×3 lattices, Keno
   * grids). Off by default: a 9×9 grid at 320px does not have 44px per cell and
   * a forced floor would overflow the board.
   */
  touchTarget?: boolean;
  title?: string;
  className?: string;
  "data-testid"?: string;
};

const RADIUS: Record<GameBoardShape, string> = {
  rounded: "rounded-[calc(var(--gr-cell-radius)*0.6)] sm:rounded-[var(--gr-cell-radius)]",
  sharp: "rounded-[3px]",
};

export function GameCell({
  children,
  selected = false,
  disabled = false,
  occupied = false,
  legalMove = false,
  owner = null,
  label,
  ownerLabel,
  role,
  rowIndex,
  colIndex,
  onSelect,
  shape = "rounded",
  square = true,
  touchTarget = false,
  title,
  className = "",
  "data-testid": testId,
}: GameCellProps) {
  const interactive = typeof onSelect === "function";
  const inert = interactive && !disabled;
  const accessibleLabel =
    label === undefined ? undefined : ownerLabel ? `${label} — ${ownerLabel}` : label;

  // Priority: the game's own disabled state wins; then selection; then a legal
  // destination; then an occupied cell; then the plain socket. A cell can be
  // `selected` AND `legalMove`, which is why these compose rather than switch.
  const look = disabled
    ? "gr-disabled border-transparent"
    : selected
      ? "gr-selected border-brand-cyan/40 bg-state-selected/10"
      : legalMove
        ? "gr-legal-move border-dashed border-[color:var(--gr-border)] bg-surface-raised/40"
        : occupied
          ? "border-[color:var(--gr-hairline)] bg-surface-raised/60"
          : "border-[color:var(--gr-hairline)] bg-surface-panel";

  const interaction = inert
    ? "cursor-pointer hover:border-brand-cyan/60 hover:bg-surface-raised focus-visible:border-brand-cyan active:scale-95"
    : disabled
      ? "cursor-not-allowed"
      : "cursor-default";

  // The SEAT SCOPE belongs on the cell root, not on the pip. `.gr-seat--N` is
  // what sets `--gr-seat-color` (which the ownership ring reads) and what shapes
  // the pip through the descendant rule `.gr-seat--2 .gr-seat-pip`. Without the
  // scope on an ancestor, seat 2's ring and pip render as seat 1's.
  const seatScope = owner === 1 ? "gr-seat gr-seat--1" : owner === 2 ? "gr-seat gr-seat--2" : "";

  const shared = {
    "data-gr-cell": "",
    "data-state": disabled
      ? "disabled"
      : selected
        ? "selected"
        : legalMove
          ? "legal"
          : occupied
            ? "occupied"
            : "default",
    "data-owner": owner ?? "",
    "data-interactive": inert ? "true" : "false",
    "data-testid": testId,
    title,
    // A cell never clips its own content: a piece, a marker or a label may
    // overhang it by design.
    className: `gr-cell ${seatScope} gr-focusable relative flex items-center justify-center border transition-colors duration-fast ease-standard ${RADIUS[shape]} ${look} ${interaction} ${
      square ? "aspect-square" : ""
    } ${touchTarget ? "min-h-11 min-w-11" : ""} ${className}`.replace(/\s+/g, " "),
    style: { touchAction: "manipulation" as const, color: seatInk(owner) },
  };

  // Ownership: the inset ring plus the seat's shape cue. Both are drawn from
  // tokens, and the pip carries the SHAPE so the owner is readable in greyscale.
  const ownership = owner !== null && (
    <>
      <span
        aria-hidden="true"
        data-gr-owner-ring=""
        className="gr-owned pointer-events-none absolute inset-0 rounded-[inherit]"
      />
      <span
        aria-hidden="true"
        data-gr-owner-pip={owner}
        className="gr-seat gr-seat-pip gr-seat-pip--invert absolute bottom-0.5 right-0.5 z-[2] opacity-90 [--gr-seat-pip-size:0.5em]"
      />
    </>
  );

  if (!interactive) {
    return (
      <div
        {...shared}
        role={role === "presentation" ? undefined : role}
        aria-label={accessibleLabel}
        aria-rowindex={rowIndex}
        aria-colindex={colIndex}
        aria-disabled={disabled ? true : undefined}
      >
        {ownership}
        {children}
      </div>
    );
  }

  return (
    <button
      {...shared}
      type="button"
      role={role === "presentation" ? undefined : role}
      aria-label={accessibleLabel}
      aria-rowindex={rowIndex}
      aria-colindex={colIndex}
      // Deliberately NOT the native attribute: a cell that is not offered stays
      // reachable by keyboard, and the guard below is what blocks the action.
      aria-disabled={inert ? undefined : true}
      onClick={() => {
        if (!inert) return;
        onSelect?.();
      }}
    >
      {ownership}
      {children}
    </button>
  );
}

/**
 * The seat's ink, for content drawn inside an owned cell.
 *
 * Seat colour is only ever used here as `currentColor` for the cell's own
 * children, so a game can draw a mark that matches its owner without importing
 * the palette. `--gr-seat-neutral` is the neutral third party the existing
 * `seatColor()` helpers already fall back to.
 */
function seatInk(owner: GameSeat): string {
  if (owner === 1) return "var(--gr-player-1)";
  if (owner === 2) return "var(--gr-player-2)";
  return "var(--gr-ink)";
}

export default GameCell;
