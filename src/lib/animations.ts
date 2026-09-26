"use client";

export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  // `as const` keeps the literal "easeOut" type when consumers spread
  // `{...fadeIn}` into a framer-motion component — without it TS widens to
  // `string`, which framer-motion's `Easing | Easing[]` transition type
  // rejects. See `fadeUp` below.
  transition: { duration: 0.25, ease: "easeOut" as const },
};

export const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
  // `as const` keeps the literal "easeOut" type when consumers spread
  // `{...fadeUp}` into a framer-motion component. Without it, TS widens
  // to `string`, which framer-motion's `Easing | Easing[]` transition
  // type rejects. Used by the match-page phase AnimatePresence wrappers
  // (waiting ↔ ready ↔ arming ↔ active ↔ finished).
  transition: { duration: 0.3, ease: "easeOut" as const },
};

export const stagger = {
  animate: {
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.06,
    },
  },
};

export const hoverScale = {
  whileHover: { scale: 1.02 },
  whileTap: { scale: 0.99 },
  transition: { duration: 0.2, ease: "easeOut" },
};

export const modalMotion = {
  backdrop: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.2 },
  },
  panel: {
    initial: { opacity: 0, y: 10, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 6, scale: 0.98 },
    transition: { duration: 0.22, ease: "easeOut" },
  },
};

export const staticMotion = {
  initial: false,
  animate: {},
  exit: {},
  transition: { duration: 0 },
};

export function withReducedMotion(shouldReduce, variant) {
  return shouldReduce ? staticMotion : variant;
}

/* ── Game-specific animation presets ── */

// Dice roll animation
export const diceRoll = (index = 0) => ({
  animate: {
    rotate: [0, 15 * (index % 2 === 0 ? 1 : -1), -15, 8, -5, 0],
    x: [0, 3 * (index % 2 === 0 ? 1 : -1), -3, 2, -1, 0],
    y: [0, -4, -2, -6, -1, 0],
    scale: [1, 1.05, 0.95, 1.03, 0.98, 1],
  },
  transition: { duration: 0.25, repeat: Infinity, ease: "easeInOut" },
});

// Coin flip 3D animation
export const coinFlip = () => ({
  animate: {
    rotateY: [0, 360, 720, 1080, 1440],
    rotateX: [0, 180, 360, 540, 720],
  },
  transition: { duration: 1, ease: [0.19, 1, 0.22, 1] },
});

// Card deal animation — cards fan out from center
export const cardDeal = (index, total) => ({
  initial: { opacity: 0, y: -40, rotate: -10 + (index / Math.max(total - 1, 1)) * 20 },
  animate: { opacity: 1, y: 0, rotate: 0 },
  transition: { delay: index * 0.06, duration: 0.3, ease: "easeOut" },
});

// Shoe deal animation — every card in the hand starts at the shoe's offset
// from its own slot (`dy`: positive when the shoe sits *below* the row, as
// it does for the opponent's backs above the table centre) and slides into
// place. Unlike `cardDeal` the cards do not fan out from their own slots:
// they share one origin, so the row reads as a single deal from the shoe.
// The stagger is squeezed into a fixed window so a long hand (repeated
// hits) still settles as one deal instead of trailing card by card.
//
// `dx` and `rotate` are optional non-negative/negative offsets for tables
// where the slots are NOT in one row (a ring of seats): pass the
// seat's offset from the shoe and the card travels the full 2D vector,
// tilted a few degrees on entry. Both default to 0, so the row-based
// blackjack call sites are byte-for-byte unchanged.
export const dealFromShoe = ({
  index = 0,
  total = 1,
  dx = 0,
  dy = 0,
  rotate = 0,
} = {}) => ({
  initial: { opacity: 0, x: dx, y: dy, rotate },
  animate: { opacity: 1, x: 0, y: 0, rotate: 0 },
  transition: {
    delay: index * Math.min(0.09, 0.4 / Math.max(total, 1)),
    duration: 0.35,
    ease: "easeOut" as const,
  },
});

// Score pop-in animation
export const scorePop = {
  initial: { scale: 0 },
  animate: { scale: 1 },
  transition: { type: "spring" as const, stiffness: 400, damping: 15 },
};

// HP bar/Damage float animation
export const damageFloat = (side) => ({
  initial: { opacity: 0, y: 0, x: 0 },
  animate: { opacity: [0, 1, 1, 0], y: -40, x: side === "right" ? 20 : -20 },
  transition: { duration: 0.9, ease: "easeOut" },
});

// Turn banner slide-in
export const turnBanner = {
  initial: { opacity: 0, y: -50, scale: 0.8 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -50, scale: 0.8 },
  transition: { type: "spring" as const, stiffness: 300, damping: 20 },
};

// Game over modal — spring with scale bounce
export const gameOverModal = {
  backdrop: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.25 },
  },
  panel: {
    initial: { scale: 0.6, opacity: 0, y: 40 },
    animate: { scale: 1, opacity: 1, y: 0 },
    exit: { scale: 0.6, opacity: 0, y: 40 },
    transition: { type: "spring" as const, stiffness: 250, damping: 18, delay: 0.15 },
  },
};

// Choice reveal animation (rock-paper-scissors, coin flip)
export const choiceReveal = {
  initial: { scale: 0.5, opacity: 0, rotate: -20 },
  animate: { scale: 1, opacity: 1, rotate: 0 },
  transition: { type: "spring" as const, stiffness: 300, damping: 12 },
};

// Floating notification toast
export const notificationPop = {
  initial: { opacity: 0, y: -20, scale: 0.8 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -10, scale: 0.9 },
  transition: { duration: 0.25, ease: "easeOut" },
};

// Button pulse glow
export const buttonPulse = (color = "rgba(34,211,238,0.4)") => ({
  animate: {
    boxShadow: [
      `0 0 15px ${color}`,
      `0 0 40px ${color}`,
      `0 0 25px ${color}`,
      `0 0 50px ${color}`,
      `0 0 15px ${color}`,
    ],
    scale: [1, 1.06, 0.98, 1.03, 1],
  },
  transition: { duration: 1.5, ease: "easeOut" },
});

// Confetti trigger helper
export async function fireConfetti(options = {}) {
  try {
    const confetti = (await import("canvas-confetti")).default;
    confetti({
      particleCount: 80,
      spread: 100,
      origin: { x: 0.5, y: 0.3 },
      colors: ["#fbbf24", "#a855f7", "#22d3ee", "#f472b6", "#34d399"],
      ...options,
    });
  } catch {}
}

// Multi-burst confetti celebration
export function celebrateWin() {
  fireConfetti({ particleCount: 80, spread: 100, origin: { x: Math.random(), y: 0.3 + Math.random() * 0.3 } });
  setTimeout(() => fireConfetti({ particleCount: 60, spread: 80, origin: { x: Math.random() * 0.5 + 0.25, y: 0.4 } }), 200);
  setTimeout(() => fireConfetti({ particleCount: 100, spread: 120, origin: { x: 0.5, y: 0.3 } }), 500);
  setTimeout(() => fireConfetti({ particleCount: 50, spread: 60, origin: { x: Math.random(), y: 0.35 } }), 900);
  setTimeout(() => fireConfetti({ particleCount: 150, spread: 160, origin: { x: 0.5, y: 0.3 } }), 1400);
}
