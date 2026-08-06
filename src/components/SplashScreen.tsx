"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import InteractiveCasinoBg from "./InteractiveCasinoBg";
import PageSkeleton from "./skeletons/PageSkeleton";

export default function SplashScreen() {
  const [show, setShow] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setShow(false), 2200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          /* Fixed full-viewport, z-9999; bg-[#030817] matches the layout
             body so the InteractiveCasinoBg layers paint against a
             consistent dark backdrop instead of pure black. */
          className="fixed inset-0 z-[9999] overflow-hidden bg-[#030817]"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: "easeInOut" }}
          role="status"
          aria-label="Loading GoonBet"
        >
          {/* Splash-variant animated background — wireframe rotates slowly
              at 0.18 opacity, no parallax, no orb, no ripples. Adds a dim
              cyan/magenta tint instead of solid black. */}
          <InteractiveCasinoBg variant="splash" />

          {/* Dark overlay z-[1] — dims the background so the skeleton stays
              legible while a hint of the wheel/grid still peeks through. */}
          <div
            className="pointer-events-none absolute inset-0 z-[1] bg-black/40"
            aria-hidden="true"
          />

          {/* Page-mapped skeleton z-10 — mirrors the layout of whatever page
              is being loaded (home, casino, sport, a game, profile, …) so
              the splash doubles as a contextual loading state. Scrollable so
              short viewports (mobile) can see the full page shape. */}
          <div className="absolute inset-0 z-10 overflow-y-auto overscroll-contain">
            <PageSkeleton />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}