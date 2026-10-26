// src/components/lane-rush/carSprites.js
//
// PURE presentation data for the Lane Rush car artwork.
//
// Tier and damage status select one of the public sprite assets; nothing here
// reads or writes game state. The artwork is drawn nose-up (towards the top
// edge of the image), so `carSpriteRotation` converts the screen-space heading
// returned by ./ovalGeometry.js into the SVG rotation the sprite needs.
//
// Kept free of React so the mapping can be unit-tested without a browser, and
// so the track, the garage and the merge animation all speak one vocabulary.

/** Public directory that holds the car artwork. */
export const CAR_SPRITE_DIR = "/images/lane-rush/cars";

/** Tier → sprite asset pair. Tier 1 is the fallback for an unknown tier. */
export const CAR_SPRITES = Object.freeze({
  1: Object.freeze({
    name: "Compact",
    src: `${CAR_SPRITE_DIR}/compact.png`,
    damagedSrc: `${CAR_SPRITE_DIR}/compact-damaged.png`,
  }),
  2: Object.freeze({
    name: "Sport",
    src: `${CAR_SPRITE_DIR}/sport.png`,
    damagedSrc: `${CAR_SPRITE_DIR}/sport-damaged.png`,
  }),
  3: Object.freeze({
    name: "Supercar",
    src: `${CAR_SPRITE_DIR}/supercar.png`,
    damagedSrc: `${CAR_SPRITE_DIR}/supercar-damaged.png`,
  }),
  4: Object.freeze({
    name: "Hypercar",
    src: `${CAR_SPRITE_DIR}/hypercar.png`,
    damagedSrc: `${CAR_SPRITE_DIR}/hypercar-damaged.png`,
  }),
});

/**
 * Rendered sprite box per tier, in the track's viewBox units (and in CSS
 * pixels in the garage). Modest growth keeps every car inside its own lane
 * band (34 wide, 44 apart) while still reading as a different class of car.
 */
export const CAR_SPRITE_SIZE = Object.freeze({ 1: 24, 2: 28, 3: 32, 4: 36 });

/** Rotation that turns nose-up artwork towards a screen-space heading. */
export const CAR_SPRITE_ROTATION_OFFSET = 90;

function normalizeTier(tier) {
  const value = Number(tier);
  return Number.isInteger(value) && CAR_SPRITES[value] ? value : 1;
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
    alt: `${sprite.name}${isDamaged ? " (damaged)" : ""}`,
  };
}

/** Square sprite box for a tier, falling back to Tier 1's size. */
export function carSpriteSize(tier) {
  return CAR_SPRITE_SIZE[normalizeTier(tier)];
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
