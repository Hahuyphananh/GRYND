// src/components/game-ui/GameBoardFrame.tsx
//
// THE SHARED BOARD FRAME.
//
// ── WHY IT EXISTS ─────────────────────────────────────────────────────────
//
// Twenty games each draw their own board box, so the navy ground, the hairline,
// the corner radius and the depth are re-decided in every page. This is the one
// place a board's frame is decided; a game swaps its own wrapper for this and
// nothing else about its layout changes.
//
// ── WHAT IT DOES NOT DO (deliberately) ────────────────────────────────────
//
//   • It imposes NO aspect ratio. `aspect` is opt-in and unset by default,
//     because the boards in this app are square, 7:6, 9:9, hex and free-form —
//     a default ratio would fight every one of them.
//   • It does NOT lay out the grid. The caller keeps its own columns, rows,
//     gaps and per-board `clamp()` sizing (the load-bearing geometry guarded by
//     tests/board-fit-desktop.test.mjs and qa/games-mobile-audit.mjs); it passes
//     its layout through `contentClassName`.
//   • It NEVER clips. There is no `overflow: hidden` anywhere: a legal-move
//     marker, a label or a piece that overhangs its cell must stay visible.
//     This is the bug the shared frame exists to make impossible.
//   • It holds no state and reads no game data. Rendering it twice with the
//     same props gives the same HTML, so it is safe in a server component, in a
//     client component, and across hydration.
//
// ── THE TWO SHAPES ────────────────────────────────────────────────────────
//
//   shape="rounded" (default) — the app's usual soft panel: hairline border,
//     the raised surface token, subtle top-lit depth.
//
//   shape="sharp" — Four-In-A-Row's HUD board, D2. It is an EXPLICIT, supported
//     variant, not an exception: same geometry language as the game's own
//     stylesheet block (src/app/globals.css, "Four-In-A-Row: sharp HUD board" —
//     3px corners, a 1px cyan edge, an inset cyan haze and the corner brackets),
//     reproduced here from the same tokens so any game may adopt it.
//
// ── RESPONSIVE ────────────────────────────────────────────────────────────
//
// `maxWidth` takes any CSS length (a plain number is read as rem), so the frame
// can cap itself per breakpoint with the utilities the caller already uses, and
// `padding` scales down on small screens the same way the rest of the app does.

import type { CSSProperties, ReactNode } from "react";

/** The two frame languages. `sharp` is Four-In-A-Row's documented HUD look. */
export type GameBoardShape = "rounded" | "sharp";

/** How much surface the frame paints behind the board. */
export type GameBoardSurface = "solid" | "recessed" | "flat";

export type GameBoardFrameProps = {
  children: ReactNode;
  /**
   * Accessible name for the board. Setting it also sets `role` (default
   * `"group"`), so a screen reader announces the region rather than listing
   * loose buttons.
   */
  label?: string;
  /** Overrides the role; `"presentation"` also drops the label. */
  role?: "group" | "grid" | "list" | "region" | "presentation";
  shape?: GameBoardShape;
  surface?: GameBoardSurface;
  /**
   * OPT-IN aspect ratio (`aspect-ratio`). Unset by default — the frame must not
   * force one on boards whose shape is their own.
   */
  aspect?: CSSProperties["aspectRatio"];
  /** Width cap: a number is rem, a string is used as-is (`min(100%, 36rem)`). */
  maxWidth?: number | string;
  /** Inner padding. `sm`/`md` shrink at phone widths, like the rest of the app. */
  padding?: "none" | "sm" | "md";
  /** The caller's board layout (grid, columns, gaps) for the content area. */
  contentClassName?: string;
  /** Adds the HUD corner brackets (the sharp frame accent). Decorative. */
  accent?: "none" | "corners";
  className?: string;
  style?: CSSProperties;
  id?: string;
  "data-testid"?: string;
};

const SHAPE_CLASS: Record<GameBoardShape, string> = {
  // Soft panel: hairline edge, generous radius.
  rounded: "rounded-2xl border border-[color:var(--gr-hairline)]",
  // Four-In-A-Row's HUD edge: 3px corners, a 1px cyan edge, no glow at rest.
  // (The inset haze that goes with it is part of the shadow composition below,
  // so every shadow on the frame is declared in ONE place.)
  sharp: "rounded-[3px] border border-brand-cyan/55",
};

/**
 * The frame's depth, composed from tokens only.
 *
 * `sharp` restates Four-In-A-Row's HUD inset haze (a 1px cyan keyline and a
 * 44px cyan wash, both at low alpha) using the brand-cyan token rather than the
 * literal rgba() in the game's own stylesheet block.
 */
function frameShadow(shape: GameBoardShape): string {
  if (shape === "sharp") {
    return (
      "var(--gr-frame-shadow), " +
      "inset 0 0 0 1px rgb(var(--gr-brand-cyan-rgb) / 0.07), " +
      "inset 0 0 44px rgb(var(--gr-brand-cyan-rgb) / 0.05)"
    );
  }
  return "var(--gr-frame-shadow), var(--gr-frame-inset)";
}

const SURFACE_CLASS: Record<GameBoardSurface, string> = {
  solid: "bg-surface-raised",
  recessed: "bg-surface-panel",
  flat: "bg-transparent",
};

const PADDING_CLASS: Record<NonNullable<GameBoardFrameProps["padding"]>, string> = {
  none: "",
  sm: "p-1.5 sm:p-2",
  md: "p-2.5 sm:p-4",
};

/** The HUD corner brackets — eight gradient arms, the same geometry the
 *  Four-In-A-Row stylesheet paints in its `::before`. Decorative only. */
const CORNERS = (
  [
    "left top / 14px 2px",
    "left top / 2px 14px",
    "right top / 14px 2px",
    "right top / 2px 14px",
    "left bottom / 14px 2px",
    "left bottom / 2px 14px",
    "right bottom / 14px 2px",
    "right bottom / 2px 14px",
  ] as const
)
  .map((arm) => `linear-gradient(var(--gr-brand-cyan), var(--gr-brand-cyan)) ${arm} no-repeat`)
  .join(", ");

export function GameBoardFrame({
  children,
  label,
  role,
  shape = "rounded",
  surface = "solid",
  aspect,
  maxWidth,
  padding = "md",
  contentClassName = "",
  accent = "none",
  className = "",
  style,
  id,
  "data-testid": testId,
}: GameBoardFrameProps) {
  const resolvedRole = role ?? (label ? "group" : undefined);

  return (
    <div
      id={id}
      role={resolvedRole === "presentation" ? undefined : resolvedRole}
      aria-label={resolvedRole === "presentation" ? undefined : label}
      data-gr-board-frame=""
      data-shape={shape}
      data-surface={surface}
      data-accent={accent}
      data-testid={testId}
      style={{
        maxWidth: typeof maxWidth === "number" ? `${maxWidth}rem` : maxWidth,
        // Only ever set when the caller asked for it.
        aspectRatio: aspect,
        // Depth: a soft drop, plus the shape's own inset treatment.
        boxShadow: frameShadow(shape),
        ...style,
      }}
      className={`relative ${SHAPE_CLASS[shape]} ${SURFACE_CLASS[surface]} ${PADDING_CLASS[padding]} ${className}`}
    >
      {accent === "corners" && (
        <span
          aria-hidden="true"
          data-gr-frame-accent="corners"
          className="pointer-events-none absolute -inset-px z-[3]"
          style={{
            background: CORNERS,
            backgroundRepeat: "no-repeat",
            filter: "drop-shadow(0 0 4px rgb(var(--gr-brand-cyan-rgb) / 0.8))",
          }}
        />
      )}
      <div className={contentClassName}>{children}</div>
    </div>
  );
}

export default GameBoardFrame;
