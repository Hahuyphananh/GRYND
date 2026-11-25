// src/components/home/HeroBackdrop.tsx
//
// A purely decorative layer behind the whole home page: soft brand-coloured
// glows that drift very slowly, with fine film grain over the top.
//
// It is CSS-only and token-driven (`--gr-brand-cyan`, `--gr-brand-yellow`,
// `--accent`), so it follows the light/dark theme instead of hard-coding a
// gradient. The page root owns `isolate`; this layer sits at `z-index: -1`
// inside that stacking context, above the page background and behind the copy.
//
// Reduced motion stops the drift (the grain and gradient stay), and the layer
// is `aria-hidden` with no pointer events, so it can never intercept a click.

import styles from "./HeroBackdrop.module.css";

export default function HeroBackdrop() {
  return (
    <div className={styles.wrap} aria-hidden="true">
      <div className={styles.glowA} />
      <div className={styles.glowB} />
      <div className={styles.glowC} />
      <div className={styles.grain} />
    </div>
  );
}
