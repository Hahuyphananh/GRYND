// src/lib/creator-mode/layout.ts
//
// Pure, dependency-free layout helpers for the Creator Mode recording
// frame. The shared visual shell (src/components/creator-mode/
// CreatorModeLayout.jsx) uses these to adapt the game presentation area
// to the selected recording aspect ratio — portrait 9:16 vs landscape
// 16:9 vs square 1:1. Keeping them pure here means they are trivially
// testable and reusable by any game without importing React.

/** Geometry of the selected recording frame. */
export type CreatorOrientation = "portrait" | "landscape" | "square";

/** Derive the frame orientation from width/height (in px). */
export function orientationOf(width: number, height: number): CreatorOrientation {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "square";
  }
  if (width > height) return "landscape";
  if (height > width) return "portrait";
  return "square";
}