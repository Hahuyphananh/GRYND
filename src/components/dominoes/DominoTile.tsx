"use client";

// src/components/dominoes/DominoTile.tsx
//
// ONE domino, drawn as its two halves with their values.
//
// The tile is presentational: it renders the id it is given and reports a click.
// It does not know whether the tile is legal, whose hand it is in, or what the
// open ends are — the board decides what to offer and the server decides what is
// accepted.
//
// ── FACING ────────────────────────────────────────────────────────────────
//
// A tile id is canonical (`"6-3"`, high half first), but a tile ON THE CHAIN has
// a facing: the engine resolved which half touches the chain on each side
// (`ChainTile.left` / `.right`). Drawing the canonical id there made adjacent
// tiles look mismatched — `6-3` next to an open 3 read as "6 | 3 | 3" — so the
// chain passes `left`/`right` and the tile renders them in that order. The id
// itself is untouched (`data-tile` stays canonical): only the picture turns.
//
// VALUES, NOT PIPS. A real domino shows pips, but a pip grid needs ~9 dots per
// half and, at the size a fourteen-tile chain forces on a phone, six dots stop
// being countable. The numeral is legible at every size in the clamp, it is what
// a screen reader announces, and it survives a high-contrast or zoomed display.
// The halves are still drawn apart by the divider, and a double is marked so it
// reads as special without rotating out of the chain's line.
//
// ACCESSIBILITY: interactive tiles are real `<button>`s, so they are focusable,
// announce as buttons, and activate with Enter/Space (and tap, since touch fires
// a click). A non-interactive tile in the shared chain is a `<div>` inside an
// ordered list instead — it is not a control and must not pretend to be one.
//
// DRAGGING: a tile may also be a DRAG SOURCE (`draggable` + the two handlers),
// which is how a pointer device carries it onto an end of the chain. The tile
// still only reports what happened — who may drag, and whether the end it was
// dropped on accepts it, are the board's decisions. `draggable` is written out on
// every tile (true or false) so a chain tile can never begin a native text drag
// of its own numeral.

import type { CSSProperties, DragEvent, KeyboardEvent } from "react";

/** Which way the tile is drawn. Chain tiles lie along the line; hand tiles too. */
export type DominoTileOrientation = "horizontal" | "vertical";

export type DominoTileProps = {
  /** Canonical tile id (`"6-3"`). Anything malformed renders as given. */
  tile: string;
  /**
   * The value facing the LEFT-hand side of the line, as the engine resolved it.
   * When both halves are given the tile is drawn in that facing; a hand tile has
   * no facing and keeps the canonical order.
   */
  left?: number | null;
  /** The value facing the RIGHT-hand side of the line. */
  right?: number | null;
  orientation?: DominoTileOrientation;
  /** The viewer's currently selected tile (hand only). */
  selected?: boolean;
  /** The tile currently has a legal placement. */
  playable?: boolean;
  /** The tile was just played — the restrained placement animation hook. */
  isNew?: boolean;
  /** Rendered as a button and clickable. */
  interactive?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Pointer devices: this tile can be picked up and dropped on an end. */
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: () => void;
  /** Extra class hooks from the caller (sizing, mostly). */
  className?: string;
  style?: CSSProperties;
  /** Overrides the accessible name, e.g. to include the ends it fits. */
  label?: string;
  /** Identifies the seat that played a chain tile (styling only). */
  seat?: "player1" | "player2" | null;
  testId?: string;
};

/** `"6-3"` → `["6", "3"]`, or null. Kept local: the tile draws, it does not rule. */
function halves(tile: string): [string, string] | null {
  const match = /^([0-6])-([0-6])$/.exec(String(tile ?? ""));
  if (!match) return null;
  return [match[1], match[2]];
}

export default function DominoTile({
  tile,
  left = null,
  right = null,
  orientation = "horizontal",
  selected = false,
  playable = false,
  isNew = false,
  interactive = false,
  disabled = false,
  onClick,
  draggable = false,
  onDragStart,
  onDragEnd,
  className = "",
  style,
  label,
  seat = null,
  testId,
}: DominoTileProps) {
  const parts = halves(tile);
  // A facing is only used when BOTH halves are real values, so a partial
  // projection still draws the tile instead of half of one.
  const facing =
    typeof left === "number" && typeof right === "number" ? [String(left), String(right)] : null;
  const high = facing ? facing[0] : parts ? parts[0] : String(tile ?? "");
  const low = facing ? facing[1] : parts ? parts[1] : "";
  const isDouble = Boolean(parts) && parts![0] === parts![1];
  const accessibleName = label ?? (parts ? `${high} ${low}` : String(tile ?? "tile"));

  const classes = [
    "dominoes-tile",
    `is-${orientation}`,
    selected ? "is-selected" : "",
    playable ? "is-playable" : "",
    isDouble ? "is-double" : "",
    isNew ? "is-new" : "",
    seat ? `seat-${seat}` : "",
    disabled ? "is-disabled" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <span className="dominoes-tile-half" aria-hidden="true">
        {high}
      </span>
      <span className="dominoes-tile-divider" aria-hidden="true" />
      <span className="dominoes-tile-half" aria-hidden="true">
        {low}
      </span>
    </>
  );

  const shared = {
    className: classes,
    style,
    // Always stated, never omitted: `true` makes this tile a drag source, and an
    // explicit `false` is what keeps a chain tile from dragging its own numeral.
    draggable,
    "data-testid": testId ?? "domino-tile",
    "data-tile": String(tile ?? ""),
    "data-selected": selected ? "true" : "false",
    "data-playable": playable ? "true" : "false",
    "data-draggable": draggable ? "true" : "false",
  } as const;

  if (!interactive) {
    return (
      <span {...shared} role="img" aria-label={accessibleName}>
        {body}
      </span>
    );
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Left/Right walk the hand, so a keyboard player does not have to Tab
    // through every tile to reach the last one. Tab still works normally.
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const row = event.currentTarget.parentElement;
    if (!row) return;
    const tiles = Array.from(
      row.querySelectorAll<HTMLButtonElement>('button[data-domino-tile="1"]'),
    );
    const index = tiles.indexOf(event.currentTarget);
    if (index === -1) return;
    const next = tiles[index + (event.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <button
      {...shared}
      type="button"
      data-domino-tile="1"
      aria-pressed={selected}
      aria-label={accessibleName}
      disabled={disabled}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={handleKeyDown}
    >
      {body}
    </button>
  );
}
