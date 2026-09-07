"use client";

export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.25, ease: "easeOut" },
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

// ── Creator Mode confetti ─────────────────────────────────────────────
// canvas-confetti's default canvas is appended to <body> as a fixed,
// full-window overlay. The Creator Mode recorder only ever captures the
// game container ([data-creator-recording]), so body-level confetti never
// appeared in recordings — the win celebration was silently missing from
// every creator clip. When a creator frame is live, fire into a canvas
// INSIDE that frame instead: the recorder composites live <canvas>
// elements into each recorded frame, so confetti shows up in the video
// exactly as it does on screen.
//
// The canvas is sized to the frame's logical resolution (the recording
// output size, e.g. 1080×1920), which also makes it crisper than the DOM
// it floats over. It is removed a few seconds after the last burst so it
// never lingers in the DOM — and can never be mistaken for a game canvas
// by the recorder's source-mode detection when a future capture starts.
let creatorConfettiCanvas: HTMLCanvasElement | null = null;
let creatorConfettiCleanupTimer: ReturnType<typeof setTimeout> | null =
  null;

/** Lazily create (and cache) a full-frame confetti canvas inside the
 *  active creator recording frame. Returns null when Creator Mode's
 *  recording container isn't in the DOM (normal play — the default
 *  body-level canvas is used instead). */
function getCreatorConfettiCanvas(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const frame = document.querySelector<HTMLElement>(
    "[data-creator-recording]",
  );
  if (!frame) return null;
  if (creatorConfettiCanvas && frame.contains(creatorConfettiCanvas)) {
    return creatorConfettiCanvas;
  }
  const canvas = document.createElement("canvas");
  canvas.className = "grynd-creator-confetti";
  canvas.setAttribute("aria-hidden", "true");
  const s = canvas.style;
  s.position = "absolute";
  s.top = "0";
  s.left = "0";
  s.width = "100%";
  s.height = "100%";
  s.pointerEvents = "none";
  // Above the game's own result overlays (shared result screens use
  // z-[95]) so confetti rains over the WIN/LOSS popup like it does in
  // normal play (the default body canvas uses z-index 100).
  s.zIndex = "999";
  canvas.width = Math.max(1, Math.round(frame.clientWidth));
  canvas.height = Math.max(1, Math.round(frame.clientHeight));
  frame.appendChild(canvas);
  creatorConfettiCanvas = canvas;
  return canvas;
}

/** Remove the in-frame confetti canvas once the burst(s) have decayed. */
function scheduleCreatorConfettiCleanup(): void {
  if (creatorConfettiCleanupTimer) clearTimeout(creatorConfettiCleanupTimer);
  creatorConfettiCleanupTimer = setTimeout(() => {
    creatorConfettiCleanupTimer = null;
    if (creatorConfettiCanvas?.isConnected) creatorConfettiCanvas.remove();
    creatorConfettiCanvas = null;
  }, 4000);
}

// Confetti trigger helper
export async function fireConfetti(options = {}) {
  try {
    const confetti = (await import("canvas-confetti")).default;
    const creatorCanvas = getCreatorConfettiCanvas();
    if (creatorCanvas) {
      // Canvas-confetti renders in CSS pixels (no devicePixelRatio
      // scaling), so a canvas that already matches the frame's layout
      // size needs no auto-resize — it is exactly the recorded area.
      const fire = confetti.create(creatorCanvas, {
        resize: false,
        useWorker: true,
      });
      scheduleCreatorConfettiCleanup();
      fire({
        particleCount: 80,
        spread: 100,
        origin: { x: 0.5, y: 0.3 },
        colors: ["#fbbf24", "#a855f7", "#22d3ee", "#f472b6", "#34d399"],
        ...options,
      });
      return;
    }
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
