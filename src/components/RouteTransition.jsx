"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { usePathname } from "next/navigation";
import { fadeIn, withReducedMotion } from "../lib/animations";

export default function RouteTransition({ children }) {
  const pathname = usePathname();
  const shouldReduceMotion = useReducedMotion();
  const variant = withReducedMotion(shouldReduceMotion, fadeIn);

  return (
    <div className="relative min-h-screen bg-[#030817]">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={pathname}
          initial={variant.initial}
          animate={variant.animate}
          exit={variant.exit}
          transition={variant.transition}
          className="min-h-screen"
        >
          {!shouldReduceMotion && (
            <motion.div
              aria-hidden="true"
              className="pointer-events-none fixed inset-0 z-[60] bg-[#030817]"
              initial={{ opacity: 0.34 }}
              animate={{ opacity: 0 }}
              exit={{ opacity: 0.38 }}
              transition={{ duration: 0.28, ease: "easeInOut" }}
            />
          )}
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
