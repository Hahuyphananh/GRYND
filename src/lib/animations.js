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
  transition: { duration: 0.3, ease: "easeOut" },
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
