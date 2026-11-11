// src/components/home/HeroCard3D.tsx
//
// The homepage's 3D playing card. Purely decorative: no state, no handlers,
// no gameplay imports. The motion is CSS-only (perspective + preserve-3d), so
// it costs no JavaScript frames and introduces no dependency.
//
// The visible design follows the shipped Solitaire card language: a white
// Ace of Spades face and the navy / cyan patterned back. The whole scene is
// aria-hidden and contains no focusable elements.

import styles from "./HeroCard3D.module.css";

const SPADE = "\u2660";

export default function HeroCard3D() {
  return (
    <div className={styles.scene} data-hero-card aria-hidden="true">
      <div className={styles.glow} />

      <div className={styles.float}>
        <div className={styles.tilt} data-hero-card-tilt>
          <div className={styles.spinner} data-hero-card-spinner>
            <div className={styles.card}>
              {/* FRONT — a grounded Ace of Spades with the card's paper grain,
                  corner indices and a restrained cyan table label. */}
              <div
                className={`${styles.face} ${styles.front}`}
                data-hero-card-face="front"
              >
                <div className={styles.frontFrame} />

                <span className={`${styles.corner} ${styles.cornerTop}`}>
                  <span className={styles.cornerRank}>A</span>
                  <span className={styles.cornerSuit}>{SPADE}</span>
                </span>
                <span className={`${styles.corner} ${styles.cornerBottom}`}>
                  <span className={styles.cornerRank}>A</span>
                  <span className={styles.cornerSuit}>{SPADE}</span>
                </span>

                <div className={styles.center}>
                  <span className={styles.halo} />
                  <span className={styles.bigSuit}>{SPADE}</span>
                  <span className={styles.label}>SOLITAIRE</span>
                </div>
              </div>

              {/* BACK — deep navy, a fine cyan lattice and a luminous spade
                  seal. `back` is rotated 180deg so exactly one face is visible. */}
              <div
                className={`${styles.face} ${styles.back}`}
                data-hero-card-face="back"
              >
                <div className={styles.backPattern} />
                <div className={styles.backFrame} />
                <div className={styles.backEmblem}>
                  <span className={styles.backSuit}>{SPADE}</span>
                </div>
                <span className={`${styles.backMark} ${styles.backMarkTL}`}>{SPADE}</span>
                <span className={`${styles.backMark} ${styles.backMarkTR}`}>{SPADE}</span>
                <span className={`${styles.backMark} ${styles.backMarkBL}`}>{SPADE}</span>
                <span className={`${styles.backMark} ${styles.backMarkBR}`}>{SPADE}</span>
                <span className={styles.backLabel}>SOLITAIRE</span>
              </div>

              {/* A dark plane a few pixels behind both faces gives the card a
                  thin physical edge instead of a paper-thin silhouette. */}
              <div className={styles.edge} />
            </div>
          </div>
        </div>
      </div>

      <div className={styles.shadow} />
    </div>
  );
}
