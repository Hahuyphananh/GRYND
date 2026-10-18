// src/components/tower-arena/BlockArt.tsx
//
// TOWER ARENA'S CARTOON-2D BLOCK LANGUAGE.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
//
// The tower and the block picker used to draw a block twice: the scene had its
// own `BlockCell`, and the picker had a `BlockGlyph` that re-implemented the same
// slab/gloss/bevel with slightly different inset, radius and stroke numbers. Two
// copies drift — and the picker is a PROMISE about what will land, so a drifted
// icon misrepresents the piece.
//
// Every block in Tower Arena is now painted by the single `BlockCell` below:
// landed blocks, the aim cursor, the falling block, the shock-shed pieces and
// the picker icons. There is one palette, one outline weight, one corner radius
// and one three-value shading model, so an icon can only ever be a miniature of
// the real piece.
//
// ── THE ART RULES ─────────────────────────────────────────────────────────
//
//   silhouette  the block's real cell footprint (engine `blockCells`), drawn as
//               a rounded slab. The shape a player picks is exactly the shape
//               that lands — the renderer never redraws an approximation.
//   outline     ONE dark navy edge (`--gr-outline`, the shared cartoon outline
//               token) on every cell of every shape. Against the near-black sky
//               it separates neighbouring blocks; against another block it is
//               the seam that keeps the grid readable.
//   shading     three values per shape, never an overlay of white/black noise:
//                 base       the shape family's existing identity colour,
//                 highlight  the shape's light tint, along the top face,
//                 shadow     a darker tint of the same hue, along the underside.
//               The base hexes are UNCHANGED from the shipped seven-colour map,
//               so a player who knows "cyan = beam" still reads it at a glance.
//   radius      a generous cartoon corner (18% of the cell), not a pill.
//   depth       the shaded bands sit INSIDE the silhouette, so nothing spills
//               out of the cell and no hit area moves. There is no outer glow:
//               the drop animation's motion trail and the rumble already carry
//               the impact, and a glow would smear the silhouette.
//
// ── STATES ────────────────────────────────────────────────────────────────
//
// The picker needs three looks from the SAME art:
//   available    full art — the piece is in the pool and it is your turn
//   selected     the same art with the shared selection keyline (the brand
//                yellow `--gr-selected`, drawn inside the dark outline)
//   unavailable  desaturated and dimmed — the piece is visible for reference
//                while it is not your turn, but it clearly cannot be picked.
// A placed piece is just `available` art in the tower, which is what makes the
// tray truthful.
//
// The module is pure presentation: no hooks, no state, no game rules, no
// browser globals. `TowerScene` and the picker are the only callers.

import type { CSSProperties } from "react";

import {
  blockCells,
  type BlockShape,
} from "../../lib/tower-arena/engine";

/** The three values a cartoon block is shaded with. */
export type BlockPalette = {
  /** The shape family's identity colour (unchanged from the shipped map). */
  base: string;
  /** The light value, along the top face. */
  highlight: string;
  /** The dark value, along the underside. */
  shadow: string;
};

/**
 * The seven-colour shape map, now carrying all three values per shape.
 *
 * `base` is byte-for-byte the fill the game has always used, so the mapping a
 * player learned ("cyan beam", "rose spire") is preserved. `highlight` is the
 * light edge tint the old renderer used as its stroke, now doing the job it
 * reads as. `shadow` is a darker tone of the same hue, chosen so the underside
 * stays in the shape's colour family instead of turning grey.
 */
export const BLOCK_PALETTE: Record<BlockShape, BlockPalette> = {
  short: { base: "#a5f3fc", highlight: "#e0fcff", shadow: "#3d97ad" }, // ice
  square: { base: "#f5ff3b", highlight: "#ffffd1", shadow: "#8f9b12" }, // neon
  I: { base: "#00e5ff", highlight: "#9df6ff", shadow: "#007c93" }, // cyan beam
  L: { base: "#ff5c8a", highlight: "#ffb8cd", shadow: "#a3244a" }, // rose spire
  T: { base: "#a78bfa", highlight: "#d9ccff", shadow: "#5c3cb0" }, // violet post
  long: { base: "#7cf29c", highlight: "#c9ffe1", shadow: "#2c8f50" }, // mint slab
  big: { base: "#ff9f43", highlight: "#ffdcb0", shadow: "#a6520c" }, // amber block
};

/** The doom palette: a drop that will breach the ceiling / fall into the void. */
export const BLOCK_DANGER_PALETTE: BlockPalette = {
  base: "#ff4d6d",
  highlight: "#ff8fa3",
  shadow: "#8c1230",
};

/** Used when a shape is unknown (an old match record, a stripped payload). */
export const BLOCK_FALLBACK_PALETTE: BlockPalette = BLOCK_PALETTE.short;

/** The shared dark edge. Falls back to the token's own value outside the app. */
export const BLOCK_OUTLINE = "var(--gr-outline, #05101f)";

/** The shared selection keyline (the app's brand yellow). */
export const BLOCK_SELECTED = "var(--gr-selected, #f5ff3b)";

/** Resolve a palette from a shape string on a payload, with a safe fallback. */
export function blockPaletteFor(shape?: string | null): BlockPalette {
  if (shape && Object.prototype.hasOwnProperty.call(BLOCK_PALETTE, shape)) {
    return BLOCK_PALETTE[shape as BlockShape];
  }
  return BLOCK_FALLBACK_PALETTE;
}

/** How a block is being presented. Placed pieces are `solid`. */
export type BlockCellState = "solid" | "selected" | "unavailable";

export type BlockCellProps = {
  x: number;
  y: number;
  /** The cell edge length, in the caller's own coordinate space. */
  size?: number;
  palette?: BlockPalette;
  opacity?: number;
  state?: BlockCellState;
  /**
   * Outline weight override, in the caller's units. The scene wants the
   * proportional default (a 2-3px edge that scales with the board); the tiny
   * picker icons need a minimum weight or the edge disappears below a pixel.
   */
  strokeWidth?: number;
  "data-testid"?: string;
};

/**
 * One cell of a block.
 *
 * `x`/`y`/`size` are in the caller's units — SVG user units in `TowerScene`
 * (where a cell is 1 unit), pixels in the picker glyph. Every proportion inside
 * is a fraction of `size`, so the same code renders the 6px picker cell and the
 * 55px board cell with identical geometry.
 *
 * The FIRST `<rect>` is always the flat base fill, on purpose: the drop/trail QA
 * checks identify a block's colour by reading the first rect, and the base is
 * the value that must stay identical to the picker icon.
 */
export function BlockCell({
  x,
  y,
  size = 0.96,
  palette = BLOCK_FALLBACK_PALETTE,
  opacity = 1,
  state = "solid",
  strokeWidth,
  "data-testid": testId,
}: BlockCellProps) {
  // Proportions, all resolved from the cell edge.
  const radius = size * 0.18;
  const edge = strokeWidth ?? size * 0.052;
  const bandInset = size * 0.1;
  const bandWidth = size - bandInset * 2;
  const bandRadius = radius * 0.42;
  const highlightY = y + size * 0.1;
  const highlightHeight = size * 0.22;
  const shadowY = y + size * 0.7;
  const shadowHeight = size * 0.2;

  const dimmed = state === "unavailable";
  const groupStyle: CSSProperties | undefined = dimmed
    ? { filter: "grayscale(0.7)" }
    : undefined;

  return (
    <g
      opacity={dimmed ? opacity * 0.55 : opacity}
      style={groupStyle}
      data-block-state={state}
      data-testid={testId}
    >
      {/* Base value — the shape's identity colour, unchanged. */}
      <rect x={x} y={y} width={size} height={size} rx={radius} fill={palette.base} />
      {/* Highlight value — the top face catching light. */}
      <rect
        x={x + bandInset}
        y={highlightY}
        width={bandWidth}
        height={highlightHeight}
        rx={bandRadius}
        fill={palette.highlight}
        opacity={0.72}
      />
      {/* Shadow value — the grounded underside. */}
      <rect
        x={x + bandInset}
        y={shadowY}
        width={bandWidth}
        height={shadowHeight}
        rx={bandRadius}
        fill={palette.shadow}
        opacity={0.9}
      />
      {/* The one shared dark edge, drawn last so the shading can never eat it. */}
      <rect
        x={x}
        y={y}
        width={size}
        height={size}
        rx={radius}
        fill="none"
        stroke={BLOCK_OUTLINE}
        strokeWidth={edge}
        strokeLinejoin="round"
      />
      {/* Selection: the shared yellow keyline, INSIDE the dark edge so the
          silhouette stays dark and the state reads on top of it. */}
      {state === "selected" && (
        <rect
          x={x + edge * 1.15}
          y={y + edge * 1.15}
          width={size - edge * 2.3}
          height={size - edge * 2.3}
          rx={Math.max(0, radius - edge)}
          fill="none"
          stroke={BLOCK_SELECTED}
          strokeWidth={Math.max(0.4, size * 0.035)}
        />
      )}
    </g>
  );
}

export type BlockGlyphState = "available" | "selected" | "unavailable";

/**
 * The picker's icon for one block shape.
 *
 * It is not a separate drawing: it lays the real `blockCells` footprint out at
 * pixel scale and paints every cell with `BlockCell`, so the icon is a truthful
 * miniature of the piece that lands. The inset keeps the outer edge of the dark
 * outline inside the glyph's own viewBox (the scene does not need it because the
 * stage is wider than the board).
 */
export function BlockGlyph({
  shape,
  size = 26,
  state = "available",
}: {
  shape: BlockShape;
  size?: number;
  state?: BlockGlyphState;
}) {
  const cells = blockCells(shape, 0);
  const maxX = Math.max(...cells.map(([x]) => x));
  const maxZ = Math.max(...cells.map(([, z]) => z));
  const w = maxX + 1;
  const h = maxZ + 1;
  // Lay the icon out in real pixels (cell ≈ 6-8px) so the edge and the shading
  // bands read crisply at button size.
  const cell = size / Math.max(w, h);
  const gap = Math.max(0.7, cell * 0.05);
  const cellSize = Math.max(1, cell - gap * 2);
  const palette = blockPaletteFor(shape);
  const cellState: BlockCellState = state === "selected" ? "selected" : state === "unavailable" ? "unavailable" : "solid";

  return (
    <svg
      width={w * cell}
      height={h * cell}
      viewBox={`0 0 ${w * cell} ${h * cell}`}
      className="shrink-0"
      aria-hidden
      focusable="false"
    >
      {cells.map(([x, z], i) => (
        <BlockCell
          key={i}
          x={x * cell + gap}
          y={(h - 1 - z) * cell + gap}
          size={cellSize}
          palette={palette}
          state={cellState}
          // A minimum weight: below ~0.7px the dark edge stops reading and the
          // icon turns into a soft blob.
          strokeWidth={Math.max(0.7, cell * 0.08)}
        />
      ))}
    </svg>
  );
}

export default BlockGlyph;
