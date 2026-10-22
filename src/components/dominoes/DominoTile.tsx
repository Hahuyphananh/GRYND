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
// VALUES, NOT PIPS. A real domino shows pips, but a pip grid needs ~9 dots per
// half and, at the size a fourteen-tile chain forces on a phone, six dots stop
// being countable. The numeral is legible at every size in the clamp, it is what
// a screen reader announces, and it survives a high-contrast or zoomed display.
// The halves are still drawn apart by the divider, and a double is marked so it
// reads crosswise-in-spirit without rotating out of the chain's line.
//
// ACCESSIBILITY: interactive tiles are real `<button>`s, so they are focusable,
// announce as buttons, and activate with Enter/Space (and tap, since touch fires
// a click). A non-interactive tile in the shared chain is a `<div>` inside an
// ordered list instead — it is not a control and must not pretend to be one.

import type { CSSProperties, KeyboardEvent } from "react";

/** Which way the tile is drawn. Chain tiles lie along the line; hand tiles too. */
export type DominoTileOrientation = "horizontal" | "vertical";

export type DominoTileProps = {
  /** Canonical tile id (`"6-3"`). Anything malformed renders as given. */
  tile: string;
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
  orientation = "horizontal",
  selected = false,
  playable = false,
  isNew = false,
  interactive = false,
  disabled = false,
  onClick,
  className = "",
  style,
  label,
  seat = null,
  testId,
}: DominoTileProps) {
  const parts = halves(tile);
  const high = parts ? parts[0] : String(tile ?? "");
  const low = parts ? parts[1] : "";
  const isDouble = Boolean(parts) && high === low;
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
    "data-testid": testId ?? "domino-tile",
    "data-tile": String(tile ?? ""),
    "data-selected": selected ? "true" : "false",
    "data-playable": playable ? "true" : "false",
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
      onKeyDown={handleKeyDown}
    >
      {body}
    </button>
  );
}
