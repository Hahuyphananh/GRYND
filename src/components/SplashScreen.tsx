"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import InteractiveCasinoBg from "./InteractiveCasinoBg";

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
          className="fixed inset-0 z-[9999] overflow-hidden flex items-center justify-center bg-[#030817]"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Splash-variant animated background — wireframe rotates slowly
              at 0.18 opacity, no parallax, no orb, no ripples. Adds a dim
              cyan/magenta tint instead of solid black. */}
          <InteractiveCasinoBg variant="splash" />

          {/* Dark overlay z-[1] — gives the requested darker tone while
              letting a hint of the wheel/grid peek through. */}
          <div
            className="pointer-events-none absolute inset-0 z-[1] bg-black/60"
            aria-hidden="true"
          />

          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 1.2, opacity: 0 }}
            transition={{ duration: 0.6 }}
            /* z-10 + pointer-events-none: text sits above the dark overlay,
               clicks pass through to underlying listeners. */
            className="relative z-10 text-center pointer-events-none"
          >
            <h1 className="text-4xl font-bold text-yellow-400">
              GoonBet, Skill based Gambling
            </h1>

            <motion.p
              className="text-gray-400 mt-2"
              animate={{ opacity: [0, 1, 0.6, 1] }}
              transition={{ duration: 2 }}
            >
              Loading your app...
            </motion.p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}