// src/components/game-ui/GamePiece.tsx
//
// A SHARED BOARD PIECE.
//
// ── ONE ART LANGUAGE, DIFFERENT SILHOUETTES ───────────────────────────────
//
// The frame, the outline, the shading and the depth are shared; the SILHOUETTE
// is not. A Pool ball, a Mines tile, a Hex-Duel tile, a Tower-Arena slab, a
// Solitaire card and a chess pawn must not become the same rounded blob, so
// `silhouette` picks the shape while everything else comes from the tokens:
//
//   disc     circular counter          — Pool discs, Four-In-A-Row counters
//   tile     square, soft corners      — number tiles, revealed Memory tiles
//   diamond  rotated square            — Mines markers, direction markers
//   hex      flat-top hexagon          — Hex Duel tiles
//   bar      long slab                 — Tower-Arena blocks, Barricade walls
//   card     portrait card             — Solitaire / Neon Flush cards
//   spike    eight-point hazard star   — mines, traps, "do not click" cells
//   glyph    caller-supplied art       — chess pieces, set-specific drawings
//
// `glyph` draws nothing itself: the game passes its own SVG/glyph as children
// and only inherits the container, the seat cue and the accessible name.
//
// ── THE ART RULES, FROM THE TOKENS ────────────────────────────────────────
//
//   outline   one stroke, `--gr-outline` at `--gr-outline-width`, drawn with
//             `vector-effect="non-scaling-stroke"` so it is the SAME 2px edge at
//             every size (a 24px piece and a 64px piece match).
//   shading   three values, all tokens: the seat fill, `--gr-piece-highlight`
//             (a restrained top gloss) and `--gr-piece-shade` (the underside).
//   depth     the silhouette repeated behind itself, offset 4 units, in the
//             shade token — a hard cartoon drop, not a blur.
//
// ── OWNERSHIP IS NEVER COLOUR ALONE ───────────────────────────────────────
//
// A piece owned by seat 1 carries a circular pip; seat 2 carries a diamond
// (`.gr-seat-pip--invert`, whose SHAPE comes from --gr-seat-1-shape /
// --gr-seat-2-shape). The pip is drawn in the outline colour, so it reads on
// top of either seat fill in either theme. A greyscale screenshot still shows
// who owns what. `label` is the non-visual third cue.

import type { CSSProperties, ReactNode } from "react";

import type { GameBoardShape } from "./GameBoardFrame";
import type { GameSeat } from "./GameCell";

/** The shape a piece is drawn as. See the header for the mechanic mapping. */
export type GamePieceSilhouette =
  | "disc"
  | "tile"
  | "diamond"
  | "hex"
  | "bar"
  | "card"
  | "spike"
  | "glyph";

export type GamePieceSize = "fill" | "sm" | "md" | "lg" | number | string;

export type GamePieceProps = {
  /** Silhouette for this game's pieces. Defaults to a plain counter. */
  silhouette?: GamePieceSilhouette;
  /** The owning seat, or null for a neutral piece (boards, hazards, stock). */
  seat?: GameSeat;
  /**
   * `fill` (default) stretches to the parent cell — the usual case. `sm`/`md`/
   * `lg` are fixed sizes for trays, legends and pickers; a number is px; a
   * string is any CSS length.
   */
  size?: GamePieceSize;
  /** Art drawn on top of the silhouette: a number, an icon, a chess glyph. */
  children?: ReactNode;
  /** Accessible name. Without one the piece is decorative (aria-hidden). */
  label?: string;
  /** Corner family, matching the frame or cell the piece sits in. */
  shape?: GameBoardShape;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
};

/**
 * Silhouettes in a 100×100 box, inset ~6 units so a 2px non-scaling stroke can
 * never be clipped by the viewBox.
 */
const SILHOUETTE_PATH: Record<Exclude<GamePieceSilhouette, "glyph">, string> = {
  disc: "M50 6a44 44 0 1 0 0 88 44 44 0 1 0 0-88z",
  tile: "M16 8h68a8 8 0 0 1 8 8v68a8 8 0 0 1-8 8H16a8 8 0 0 1-8-8V16a8 8 0 0 1 8-8z",
  diamond: "M50 6 94 50 50 94 6 50z",
  hex: "M50 5 89 27 89 73 50 95 11 73 11 27z",
  bar: "M16 30h68a6 6 0 0 1 6 6v28a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6V36a6 6 0 0 1 6-6z",
  card: "M22 6h56a8 8 0 0 1 8 8v72a8 8 0 0 1-8 8H22a8 8 0 0 1-8-8V14a8 8 0 0 1 8-8z",
  spike:
    "M50 6 57 30 80 17 67 40 94 50 67 60 80 83 57 70 50 94 43 70 20 83 33 60 6 50 33 40 20 17 43 30z",
};

/** The gloss, kept well inside each silhouette so it never breaks the edge. */
const HIGHLIGHT_PATH: Record<Exclude<GamePieceSilhouette, "glyph">, string> = {
  disc: "M50 14a36 36 0 0 0-30 16 30 30 0 0 1 60 0 36 36 0 0 0-30-16z",
  tile: "M18 12h64a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z",
  diamond: "M50 26 74 50 50 74 26 50z",
  hex: "M50 17 79 33 79 43 50 27 21 43 21 33z",
  bar: "M18 32h64a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4z",
  card: "M24 12h52a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z",
  spike: "M50 22a22 22 0 0 0-16 7 26 26 0 0 1 32 0 22 22 0 0 0-16-7z",
};

const SIZE_CLASS: Record<"fill" | "sm" | "md" | "lg", string> = {
  fill: "h-full w-full",
  sm: "h-6 w-6",
  md: "h-9 w-9",
  lg: "h-[3.25rem] w-[3.25rem]",
};

const CORNER_CLASS: Record<GameBoardShape, string> = {
  rounded: "rounded-[var(--gr-piece-radius)]",
  sharp: "rounded-[3px]",
};

export function GamePiece({
  silhouette = "disc",
  seat = null,
  size = "fill",
  children,
  label,
  shape = "rounded",
  className = "",
  style,
  "data-testid": testId,
}: GamePieceProps) {
  const path = silhouette === "glyph" ? null : SILHOUETTE_PATH[silhouette];
  const highlight = silhouette === "glyph" ? null : HIGHLIGHT_PATH[silhouette];

  const sizeClass = typeof size === "string" ? (SIZE_CLASS[size as "fill"] ?? "") : "";
  const inlineSize: CSSProperties =
    typeof size === "number"
      ? { width: `${size}px`, height: `${size}px` }
      : typeof size === "string" && size in SIZE_CLASS
        ? {}
        : typeof size === "string"
          ? { width: size, height: size }
          : {};

  const seatClass = seat === 1 ? "gr-seat gr-seat--1" : seat === 2 ? "gr-seat gr-seat--2" : "";

  return (
    <span
      data-gr-piece=""
      data-silhouette={silhouette}
      data-seat={seat ?? ""}
      data-testid={testId}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      style={{
        color:
          seat === 1
            ? "var(--gr-player-1)"
            : seat === 2
              ? "var(--gr-player-2)"
              : "var(--gr-seat-neutral)",
        ...inlineSize,
        ...style,
      }}
      className={`${seatClass} relative inline-flex aspect-square items-center justify-center ${
        sizeClass || "aspect-square"
      } ${CORNER_CLASS[shape]} ${className}`}
    >
      {path && (
        <svg
          viewBox="0 0 100 100"
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
          focusable="false"
        >
          {/* depth: the silhouette behind itself, in the shade token */}
          <path d={path} transform="translate(0 4)" fill="var(--gr-piece-shade)" />
          {/* base fill + the one shared outline weight */}
          <path
            d={path}
            fill="currentColor"
            stroke="var(--gr-outline)"
            strokeWidth="var(--gr-outline-width)"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* restrained highlight, inside the silhouette */}
          {highlight && <path d={highlight} fill="var(--gr-piece-highlight)" />}
        </svg>
      )}

      {/* Ownership cue: the seat's SHAPE in the outline colour, so it reads on
          top of either seat fill, in either theme, and in greyscale. */}
      {seat !== null && (
        <span
          aria-hidden="true"
          data-gr-owner-pip={seat}
          className="gr-seat-pip gr-seat-pip--invert absolute bottom-0 right-0 z-[3] [--gr-seat-pip-size:0.42em]"
        />
      )}

      {children && (
        <span className="relative z-[2] flex h-[62%] w-[62%] items-center justify-center">
          {children}
        </span>
      )}

      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

export default GamePiece;
