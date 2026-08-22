"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
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
             body so the skeleton sits on a consistent dark backdrop. */
          className="fixed inset-0 z-[9999] overflow-hidden bg-[#030817]"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: "easeInOut" }}
          role="status"
          aria-label="Loading GRYND"
        >
          {/* Page-mapped skeleton — mirrors the layout of whatever page
              is being loaded (home, casino, a game, profile, …) so
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