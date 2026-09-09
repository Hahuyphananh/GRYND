"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import PageSkeleton from "./skeletons/PageSkeleton";

// sessionStorage key — the splash is a first-load brand moment, not a
// per-navigation overlay. Showing it on every route change was pure cost:
// a 2.2s full-viewport skeleton + fade on every page the user visits.
const SPLASH_SEEN_KEY = "grynd:splash:seen:v1";

export default function SplashScreen() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Once per browser session (per tab). Returning visitors / in-app
    // navigations skip the overlay entirely and get the page immediately.
    let seen = false;
    try {
      seen = window.sessionStorage.getItem(SPLASH_SEEN_KEY) === "1";
    } catch {
      // storage unavailable — still show the splash this once
    }
    if (seen) return;
    try {
      window.sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
    } catch {
      // ignore
    }
    setShow(true);

    // Dismiss on a timer once hydration completes. If something throws
    // during hydration the effect never runs, so also dismiss on the
    // window `load` event and on a hard cap — the splash must never be
    // able to trap the app in a permanent "loading" overlay.
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      setShow(false);
    };

    const timer = setTimeout(dismiss, 2200);
    const hardCap = setTimeout(dismiss, 6000);
    window.addEventListener("load", dismiss);

    return () => {
      clearTimeout(timer);
      clearTimeout(hardCap);
      window.removeEventListener("load", dismiss);
    };
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
          <div
            className="absolute inset-0 z-10 overflow-y-auto overscroll-contain"
            tabIndex={0}
            role="region"
            aria-label="Loading preview"
          >
            <PageSkeleton />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}