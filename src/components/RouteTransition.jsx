"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { usePathname } from "next/navigation";
import { fadeIn, withReducedMotion } from "../lib/animations";

export default function RouteTransition({ children }) {
  const pathname = usePathname();
  const shouldReduceMotion = useReducedMotion();
  const variant = withReducedMotion(shouldReduceMotion, fadeIn);

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={pathname} initial={variant.initial} animate={variant.animate} exit={variant.exit} transition={variant.transition}>
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
