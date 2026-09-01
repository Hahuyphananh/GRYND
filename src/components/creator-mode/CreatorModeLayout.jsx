"use client";

// src/components/creator-mode/CreatorModeLayout.jsx
//
// Shared Creator Mode visual layout. The goal is NOT to shrink the
// desktop game into a tiny rectangle — it is a dedicated, responsive
// game-presentation shell optimized for the selected recording aspect
// ratio.
//
// Design:
//   • <CreatorModeShell> is the only thing a game must mount to opt in.
//     It controls the recording frame: it fills the frame exactly
//     (w-full / h-full), is overflow-hidden (so captures are clean), and
//     exposes `data-creator-layout={portrait|landscape|square}`.
//   • It provides a layout context (useCreatorModeLayout) with the frame
//     orientation + geometry so each game can arrange ITS OWN content —
//     the shell does NOT force one identical layout on every game. Games
//     compose <ShellHeader> / <ShellMain> / <ShellAside> the way that
//     suits them, or lay content out entirely their own way.
//   • Portrait (9:16) prefers a vertical column: compact header on top
//     (branding + info), a large growing game area in the middle, and a
//     pinned aside/controls at the bottom — prioritizing actual gameplay
//     while keeping important info visible.// • Landscape (16:9) and square (1:1) prefer a horizontal row with the
//     game area growing and an aside on the side.
//
// Portrait (9:16) is the PHONE frame. <CreatorResponsiveLayout> renders
// the game inside a phone-width viewport (390px) that is zoomed up to
// fill the output frame edge-to-edge — so the game's own mobile-first
// responsive styles take over and the recorded video looks like a real
// phone screen at 1080×1920, never a shrunken desktop page.
//
// The recording engine captures the provider's `data-creator-recording`
// root; the shell renders INSIDE that root, so whatever a game arranges
// here is exactly what gets recorded. When Creator Mode is off the
// provider renders children directly and this shell never appears — the
// normal desktop game is unchanged.
//
// No game rules, controls, wagers, or logic are touched by the shell — it
// only arranges already-existing content.

import React, { createContext, useContext, useMemo } from "react";
import { useCreatorMode } from "../../lib/creator-mode/CreatorModeProvider";
import { orientationOf } from "../../lib/creator-mode/layout";

// ── Layout context ────────────────────────────────────────────────────

const LayoutContext = createContext({
  width: 0,
  height: 0,
  orientation: "square",
  isPortrait: false,
  isLandscape: false,
  isSquare: true,
});

/**
 * Read the recording frame's orientation/geometry so a game can arrange
 * its content for the selected aspect ratio. Only meaningful when
 * rendered under <CreatorModeShell /> (otherwise it returns the default).
 */
export function useCreatorModeLayout() {
  return useContext(LayoutContext);
}

/**
 * Wraps children in the layout context. <CreatorModeShell /> installs
 * this automatically from the provider's selected dimensions; an
 * explicit `dimensions` prop overrides those (for tests / static embeds).
 */
export function CreatorModeLayoutProvider({ dimensions, children }) {
  const providerDims = useCreatorMode().dimensions || { width: 0, height: 0 };
  const width = dimensions?.width || providerDims.width;
  const height = dimensions?.height || providerDims.height;
  const value = useMemo(() => {
    const orientation = orientationOf(width, height);
    return {
      width,
      height,
      orientation,
      isPortrait: orientation === "portrait",
      isLandscape: orientation === "landscape",
      isSquare: orientation === "square",
    };
  }, [width, height]);
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

// ── Shell + primitives ────────────────────────────────────────────────

/**
 * The Creator Mode recording-frame shell. Fills the frame exactly and
 * adapts its stacking direction to the selected aspect ratio:
 *   • portrait  → flex-col (header / game / aside stack vertically)
 *   • landscape → flex-row
 *   • square    → flex-row
 */
export function CreatorModeShell({ dimensions = undefined, className = "", children }) {
  return (
    <CreatorModeLayoutProvider dimensions={dimensions}>
      <ShellInner className={className}>{children}</ShellInner>
    </CreatorModeLayoutProvider>
  );
}

function ShellInner({ className = "", children }) {
  const { isPortrait, orientation } = useCreatorModeLayout();
  return (
    <div
      data-creator-layout={orientation}
      className={`flex h-full w-full overflow-hidden ${
        isPortrait ? "flex-col" : "flex-row"
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** Compact branding / status bar. In portrait it tops the column. */
export function ShellHeader({ className = "", children }) {
  const { isPortrait } = useCreatorModeLayout();
  return (
    <div
      data-creator-part="header"
      className={`shrink-0 ${
        isPortrait ? "w-full border-b border-[#00e5ff]/15 px-3 py-2" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** The growing gameplay area. Fill width/height as fits your game. */
export function ShellMain({ className = "", children }) {
  return (
    <div
      data-creator-part="main"
      className={`relative flex min-h-0 min-w-0 flex-1 items-center justify-center ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * A pinned region for secondary info/controls. In portrait it is a bottom
 * strip (so it never covers the gameplay above); in landscape/square it is
 * a right-hand column. Scrolls internally so it can hold more than fits.
 */
export function ShellAside({ className = "", children }) {
  const { isPortrait } = useCreatorModeLayout();
  return (
    <div
      data-creator-part="aside"
      className={`shrink-0 overflow-y-auto ${
        isPortrait
          ? "max-h-[44%] w-full border-t border-[#00e5ff]/15 px-3 py-2"
          : "h-full w-[300px] border-l border-[#00e5ff]/15 px-3 py-3"
      } ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * <CreatorView> is the single per-game mount point for the shared visual
 * layout. Games render it as the ONLY child of <CreatorModeHost /> so it
 * sits UNDER the provider and can read the true selected dimensions:
 *
 *   <CreatorModeHost autoStart={gameStarted} autoStop={gameEnded} gameLabel="...">
 *     <CreatorView normal={pageBody} portrait={portraitContent} landscape={landscapeContent} />
 *   </CreatorModeHost>
 *
 * Behaviour:
 *   • Creator mode OFF → renders `normal` byte-for-byte unchanged.
 *   • Portrait (9:16) → renders `portrait` (or falls back to `landscape`,
 *     then `normal`).
 *   • Landscape / square → renders `landscape` (or falls back to `normal`).
 *
 * IMPORTANT: it must be a child of <CreatorModeHost /> (i.e. be mounted
 * inside the provider). Do NOT call useCreatorMode from the page component
 * above the host to pick a layout — that reads the default context and the
 * creator shell would never show. This component exists precisely to move
 * that decision under the provider.
 */
export function CreatorView({ normal, portrait, landscape }) {
  const { isCreatorMode, dimensions } = useCreatorMode();
  if (!isCreatorMode || !dimensions) return normal ?? null;
  const orientation = orientationOf(dimensions.width, dimensions.height);
  if (orientation === "portrait" && portrait) return portrait;
  if (orientation !== "portrait" && landscape) return landscape;
  return normal ?? null;
}

/**
 * Phone-width layout viewport for the portrait (9:16) recording frame.
 * The game is laid out at a real phone width (so its mobile-first
 * responsive styles — wrapping, stacked panels, touch-sized controls —
 * are the ones that apply) and then `zoom`ed up to fill the output frame
 * exactly. `zoom` re-lays-out the subtree at the scaled size, so text
 * stays crisp in both the live frame and the composite-mode recording
 * (unlike `transform: scale`, which rasterizes at the layout size and
 * then upscales). Landscape/square frames keep the direct fill.
 */
export const PHONE_LAYOUT_WIDTH = 390;

/**
 * <CreatorResponsiveLayout> is the quick, uniform integration for games
 * that don't need a bespoke portrait arrangement: when Creator Mode is on
 * it drops the existing game content into the shared recording-frame shell
 * and the game page FILLS the frame edge-to-edge.
 *
 *   • Portrait (9:16) — the phone frame: the game is laid out at a real
 *     phone width (390px) and zoomed up to fill the whole output frame
 *     (1080×1920), so the game renders in phone mode — its own mobile
 *     responsive layout — and fills the frame edge-to-edge like a real
 *     phone screen. Scrolling stays internal when content is taller.
 *   • Landscape/square — the game page fills the frame directly (full
 *     width/height via the shared `[data-creator-fill]` CSS, which
 *     overrides the page's desktop max-width / centering inside the
 *     shell).
 *
 * The game is never shrunk into a tiny rectangle. When Creator Mode is
 * off it returns `children` byte-for-byte unchanged.
 *
 * Works hand-in-hand with <CreatorView>/<CreatorModeHost>: mount it as the
 * ONLY child of <CreatorModeHost /> so it reads the real provider context.
 */
export function CreatorResponsiveLayout({ children }) {
  const { isCreatorMode, dimensions } = useCreatorMode();
  if (!isCreatorMode) return children;

  // Portrait frames are the phone frame: lay the game out at a phone
  // width and zoom it up so it fills the output edge-to-edge.
  const isPortrait = Boolean(
    dimensions && dimensions.height > dimensions.width,
  );
  const phoneScale =
    isPortrait && dimensions.width > 0
      ? dimensions.width / PHONE_LAYOUT_WIDTH
      : 1;
  const phoneHeight = isPortrait ? dimensions.height / phoneScale : 0;

  const fill = (
    <div
      data-creator-fill
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      {children}
    </div>
  );

  return (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      {isPortrait ? (
        <div
          data-creator-phone
          className="relative flex min-h-0 min-w-0 flex-col self-start"
          style={{
            width: PHONE_LAYOUT_WIDTH,
            height: phoneHeight,
            zoom: phoneScale,
          }}
        >
          {fill}
        </div>
      ) : (
        fill
      )}
    </CreatorModeShell>
  );
}