// src/components/lane-rush/carSprites.js
//
// PURE presentation data for the Lane Rush car artwork.
//
// Tier and damage status select one of the public sprite assets; nothing here
// reads or writes game state. The artwork is drawn nose-up (towards the top
// edge of the image), so `carSpriteRotation` converts the screen-space heading
// returned by ./ovalGeometry.js into the SVG rotation the sprite needs.
//
// FRAMING. Each 256 × 256 PNG is a photo-real top-down car that only fills part
// of its canvas: the body spans ~42–57% of the width and ~91% of the height,
// because the source render is square and a car is not. Drawing the raw square
// into a square sprite box therefore painted a car roughly a third of the box
// wide — the "dot" the track used to show. Every asset entry below carries the
// measured CONTENT FRAME (the alpha bounding box of the file, in source pixels)
// so the sprite can crop the transparent margins away and scale the car itself
// to the box, at its true aspect ratio.
//
// The frames are not hand-tuned: `tests/lane-rush-oval-track.test.mjs`
// re-measures the alpha bounding box of every PNG and fails if a frame drifts
// away from its asset.
//
// Kept free of React so the mapping can be unit-tested without a browser, and
// so the track, the garage and the merge animation all speak one vocabulary.

/** Public directory that holds the car artwork. */
export const CAR_SPRITE_DIR = "/images/lane-rush/cars";

/** Natural size of every sprite asset, in source pixels. */
export const CAR_SPRITE_CANVAS = Object.freeze({ width: 256, height: 256 });

/** Tier → sprite asset pair, each with its measured content frame. */
export const CAR_SPRITES = Object.freeze({
  1: Object.freeze({
    name: "Compact",
    src: `${CAR_SPRITE_DIR}/compact.png`,
    frame: Object.freeze({ x: 58, y: 12, width: 139, height: 232 }),
    damagedSrc: `${CAR_SPRITE_DIR}/compact-damaged.png`,
    damagedFrame: Object.freeze({ x: 57, y: 12, width: 141, height: 232 }),
  }),
  2: Object.freeze({
    name: "Sport",
    src: `${CAR_SPRITE_DIR}/sport.png`,
    frame: Object.freeze({ x: 70, y: 12, width: 116, height: 232 }),
    damagedSrc: `${CAR_SPRITE_DIR}/sport-damaged.png`,
    damagedFrame: Object.freeze({ x: 70, y: 12, width: 116, height: 232 }),
  }),
  3: Object.freeze({
    name: "Supercar",
    src: `${CAR_SPRITE_DIR}/supercar.png`,
    frame: Object.freeze({ x: 73, y: 12, width: 109, height: 232 }),
    damagedSrc: `${CAR_SPRITE_DIR}/supercar-damaged.png`,
    damagedFrame: Object.freeze({ x: 55, y: 12, width: 146, height: 232 }),
  }),
  4: Object.freeze({
    name: "Hypercar",
    src: `${CAR_SPRITE_DIR}/hypercar.png`,
    frame: Object.freeze({ x: 66, y: 12, width: 123, height: 232 }),
    damagedSrc: `${CAR_SPRITE_DIR}/hypercar-damaged.png`,
    damagedFrame: Object.freeze({ x: 57, y: 12, width: 142, height: 232 }),
  }),
});

/**
 * Rendered box WIDTH per tier, in the track's viewBox units (and in CSS pixels
 * as a `size` in the garage). This is the car's across-the-lane footprint and
 * the board is framed around it: the tier order still reads as a class
 * difference, and the widest car (29.5 units from the lane axis once the 6.5
 * seat offset is added) still sits inside the 60-unit lane band, 66 units from
 * the neighbouring route's axis.
 */
export const CAR_SPRITE_SIZE = Object.freeze({ 1: 34, 2: 38, 3: 42, 4: 46 });

/** Rotation that turns nose-up artwork towards a screen-space heading. */
export const CAR_SPRITE_ROTATION_OFFSET = 90;

function normalizeTier(tier) {
  const value = Number(tier);
  return Number.isInteger(value) && CAR_SPRITES[value] ? value : 1;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** Resolve the sprite for a tier/damage pair. Unknown tiers fall back to Tier 1. */
export function carSpriteFor({ tier = 1, damaged = false } = {}) {
  const resolvedTier = normalizeTier(tier);
  const isDamaged = Boolean(damaged);
  const sprite = CAR_SPRITES[resolvedTier];
  return {
    tier: resolvedTier,
    damaged: isDamaged,
    name: sprite.name,
    src: isDamaged ? sprite.damagedSrc : sprite.src,
    frame: isDamaged ? sprite.damagedFrame : sprite.frame,
    alt: `${sprite.name}${isDamaged ? " (damaged)" : ""}`,
  };
}

/** Sprite box WIDTH for a tier, falling back to Tier 1's size. */
export function carSpriteSize(tier) {
  return CAR_SPRITE_SIZE[normalizeTier(tier)];
}

/**
 * Aspect-true sprite box for one car, in viewBox units.
 *
 * The height comes from the artwork's own content frame, so the drawn car fills
 * the box instead of sitting inside a square with empty margins, and it is
 * never stretched to fit one. The box is WIDTH-led because the width is the
 * dimension that has to respect the lane band.
 */
export function carSpriteBox({ tier = 1, damaged = false } = {}) {
  const width = carSpriteSize(tier);
  const { frame } = carSpriteFor({ tier, damaged });
  return {
    width,
    height: round1((width * frame.height) / frame.width),
  };
}

/**
 * SVG rotation for a screen-space heading in degrees. The artwork points up
 * (-90°), so a heading of 0° (rightwards) needs +90°, a heading of -90° (up)
 * needs 0°, and a full lap keeps increasing in the clockwise SVG direction.
 */
export function carSpriteRotation(heading) {
  const value = Number(heading);
  return (Number.isFinite(value) ? value : 0) + CAR_SPRITE_ROTATION_OFFSET;
}
