// src/lib/mascot/glitchAssets.ts
//
// Client-safe catalog for GRYND's mascot, GLITCH.
//
// Same contract as src/lib/emoteAssets.ts: the artwork is resolved ONLY from
// this allow-list. Nothing here accepts a caller-supplied URL, filename or
// path — `GlitchExpression` is a closed union of six literals, so an arbitrary
// `src` cannot reach the component through the type system, and a value that
// slipped past it at runtime (JSON, a socket, an `any`) falls back to `idle`
// instead of rendering a broken image.
//
// The files themselves are produced by scripts/prepare-mascot-assets.mjs and
// documented in public/images/mascot/README.md. Each expression ships at two
// densities: 384 (2x) and 192 (1x). Both are square with transparent padding,
// so the artwork's proportions are never altered.
//
// TO CHANGE THE ARTWORK: drop new files at the paths below (or edit these
// definitions), then re-run the generator. Adding an expression means adding
// it to GLITCH_EXPRESSIONS, the ASSETS map AND the generator's ASSETS list —
// the three must stay in sync, exactly like the emote catalog and its
// migration seed.

/** The six official expressions. `idle` is the default. */
export const GLITCH_EXPRESSIONS = [
  "idle",
  "wink",
  "victory",
  "defeat",
  "surprised",
  "focused",
] as const;

/** The default expression when none is given, or when one is unrecognised. */
export const GLITCH_DEFAULT_EXPRESSION = "idle" satisfies GlitchExpression;

export const GLITCH_ASSET_DIR = "/images/mascot";

/** Intrinsic size of the 2x files (and of every file is square). */
export const GLITCH_INTRINSIC_SIZE = 384;
/** Intrinsic size of the 1x files. */
export const GLITCH_INTRINSIC_SIZE_1X = 192;

export type GlitchExpression = (typeof GLITCH_EXPRESSIONS)[number];

export type GlitchAsset = {
  readonly expression: GlitchExpression;
  /** 384 × 384 — the 2x asset. */
  readonly src: string;
  /** 192 × 192 — the 1x asset. */
  readonly src1x: string;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  /**
   * Alt text for the MEANINGFUL case. A decorative mascot (one whose bubble
   * already carries the meaning) passes `decorative` instead, so a screen
   * reader never hears the portrait and the sentence twice.
   */
  readonly alt: string;
};

const ASSETS: Record<GlitchExpression, GlitchAsset> = {
  idle: {
    expression: "idle",
    src: `${GLITCH_ASSET_DIR}/glitch-idle.webp`,
    src1x: `${GLITCH_ASSET_DIR}/glitch-idle-192.webp`,
    intrinsicWidth: GLITCH_INTRINSIC_SIZE,
    intrinsicHeight: GLITCH_INTRINSIC_SIZE,
    alt: "GLITCH, the GRYND mascot",
  },
  wink: {
    expression: "wink",
    src: `${GLITCH_ASSET_DIR}/glitch-wink.webp`,
    src1x: `${GLITCH_ASSET_DIR}/glitch-wink-192.webp`,
    intrinsicWidth: GLITCH_INTRINSIC_SIZE,
    intrinsicHeight: GLITCH_INTRINSIC_SIZE,
    alt: "GLITCH winking",
  },
  victory: {
    expression: "victory",
    src: `${GLITCH_ASSET_DIR}/glitch-victory.webp`,
    src1x: `${GLITCH_ASSET_DIR}/glitch-victory-192.webp`,
    intrinsicWidth: GLITCH_INTRINSIC_SIZE,
    intrinsicHeight: GLITCH_INTRINSIC_SIZE,
    alt: "GLITCH celebrating a win",
  },
  defeat: {
    expression: "defeat",
    src: `${GLITCH_ASSET_DIR}/glitch-defeat.webp`,
    src1x: `${GLITCH_ASSET_DIR}/glitch-defeat-192.webp`,
    intrinsicWidth: GLITCH_INTRINSIC_SIZE,
    intrinsicHeight: GLITCH_INTRINSIC_SIZE,
    alt: "GLITCH looking deflated",
  },
  surprised: {
    expression: "surprised",
    src: `${GLITCH_ASSET_DIR}/glitch-surprised.webp`,
    src1x: `${GLITCH_ASSET_DIR}/glitch-surprised-192.webp`,
    intrinsicWidth: GLITCH_INTRINSIC_SIZE,
    intrinsicHeight: GLITCH_INTRINSIC_SIZE,
    alt: "GLITCH looking surprised",
  },
  focused: {
    expression: "focused",
    src: `${GLITCH_ASSET_DIR}/glitch-focused.webp`,
    src1x: `${GLITCH_ASSET_DIR}/glitch-focused-192.webp`,
    intrinsicWidth: GLITCH_INTRINSIC_SIZE,
    intrinsicHeight: GLITCH_INTRINSIC_SIZE,
    alt: "GLITCH looking determined",
  },
};

/** True only for one of the six official expressions. */
export function isGlitchExpression(value: unknown): value is GlitchExpression {
  return (
    typeof value === "string" &&
    (GLITCH_EXPRESSIONS as readonly string[]).includes(value)
  );
}

/**
 * Resolve an expression to its allow-listed artwork.
 *
 * The parameter is the closed union, so the only way to reach the fallback is a
 * caller that lied about its type (or JS calling in) — never a normal caller
 * with an arbitrary string.
 */
export function glitchAsset(expression: GlitchExpression): GlitchAsset {
  return ASSETS[expression] ?? ASSETS[GLITCH_DEFAULT_EXPRESSION];
}

/** `srcSet` for the two densities, so one element serves 1x and 2x. */
export function glitchSrcSet(asset: GlitchAsset): string {
  return `${asset.src1x} 1x, ${asset.src} 2x`;
}
