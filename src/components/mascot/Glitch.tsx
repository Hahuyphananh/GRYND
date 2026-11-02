// src/components/mascot/Glitch.tsx
//
// One GLITCH expression. Draws the allow-listed artwork only — there is no
// `src` prop, so a caller can never point this at an arbitrary image.
//
// NO CONTAINER, NO BACKDROP. The assets have real alpha, so the mascot is drawn
// straight onto the page: no card, no panel, no border, no background colour,
// no `mix-blend-mode`. The separation from GRYND's near-black ground comes from
// an ALPHA-FOLLOWING glow (drop-shadow on the <img>), never a box-shadow, which
// would trace the element box and produce a visible rectangle.
//
// The artwork itself is never recoloured, cropped, stretched or filtered in a
// way that changes it: `object-contain`, a square box, and the original file
// untouched.

import {
  glitchAsset,
  glitchSrcSet,
  GLITCH_DEFAULT_EXPRESSION,
  type GlitchExpression,
} from "../../lib/mascot/glitchAssets";

/** Named sizes, in CSS pixels. */
export const GLITCH_SIZES = {
  sm: 72,
  md: 120,
  lg: 176,
} as const;

export type GlitchSizePreset = keyof typeof GLITCH_SIZES;

export type GlitchProps = {
  /** One of the six expressions. Defaults to `idle`. */
  expression?: GlitchExpression;
  /** A named size, or an explicit pixel size. */
  size?: GlitchSizePreset | number;
  /**
   * Decorative mode: the mascot is incidental, so it is hidden from assistive
   * tech (`alt=""` + `aria-hidden`). Use this whenever a bubble or nearby copy
   * already says what GLITCH is doing — otherwise a screen reader announces
   * both the portrait and the sentence.
   */
  decorative?: boolean;
  /** Override the meaningful alt text (ignored when `decorative`). */
  alt?: string;
  /**
   * The restrained aqua rim. On by default because the mascot's own indigo is
   * only a couple of luminance steps from the page ground (#030817); turn it
   * off where the surface behind GLITCH is already light.
   */
  glow?: boolean;
  className?: string;
};

/**
 * The rim light, in the brand token rather than a new colour (#00e5ff).
 *
 * Two soft layers, both well under a visible halo: the first defines the
 * silhouette, the second lifts it off the ground. No pulsing, no animation —
 * `drop-shadow` follows the artwork's alpha, so the mascot never appears to sit
 * in a rectangle.
 */
function glowFilter(): string {
  return (
    "drop-shadow(0 0 6px rgb(var(--gr-brand-cyan-rgb) / 0.32)) " +
    "drop-shadow(0 0 18px rgb(var(--gr-brand-cyan-rgb) / 0.14))"
  );
}

export default function Glitch({
  expression = GLITCH_DEFAULT_EXPRESSION,
  size = "md",
  decorative = false,
  alt,
  glow = true,
  className = "",
}: GlitchProps) {
  const asset = glitchAsset(expression);
  const px =
    typeof size === "number" ? Math.max(24, Math.round(size)) : GLITCH_SIZES[size];

  return (
    // A plain <img> rather than next/image on purpose: the file is ~17–27 KB,
    // it is already encoded at both densities, and an explicit box is what
    // guarantees zero layout shift. next/image would add a wrapper, an
    // optimiser round-trip and the config's quality allow-list for no gain
    // (the same reasoning as EmoteArtwork).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={asset.src}
      srcSet={glitchSrcSet(asset)}
      sizes={`${px}px`}
      width={px}
      height={px}
      alt={decorative ? "" : (alt ?? asset.alt)}
      aria-hidden={decorative || undefined}
      draggable={false}
      decoding="async"
      loading="lazy"
      className={`shrink-0 select-none object-contain ${className}`}
      style={{
        width: px,
        height: px,
        filter: glow ? glowFilter() : undefined,
      }}
    />
  );
}
