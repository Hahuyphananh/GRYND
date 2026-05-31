"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    __tawkLoaded?: boolean;
    Tawk_API: {
      onLoad?: () => void;
      hideWidget?: () => void;
      showWidget?: () => void;
      maximize?: () => void;
      [key: string]: unknown;
    };
    Tawk_LoadStart?: Date;
  }
}

export default function TawkProvider() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.__tawkLoaded) return;

    window.__tawkLoaded = true;

    window.Tawk_API = window.Tawk_API || {};
    window.Tawk_LoadStart = new Date();

    // Defer Tawk script load until after the page is fully rendered.
    // Loading too early can cause 'clientHeight' errors when the widget
    // tries to measure DOM elements that aren't mounted yet.
    // Uses requestIdleCallback when available (waits until browser is idle),
    // with a 500ms setTimeout fallback for older browsers.
    let cancelled = false;

    const schedule =
      typeof requestIdleCallback !== "undefined"
        ? requestIdleCallback
        : (fn: () => void) => setTimeout(fn, 500);

    const handle = schedule(() => {
      if (cancelled) return;
      (function () {
        const s1 = document.createElement("script");
        const s0 = document.getElementsByTagName("script")[0];

        s1.async = true;
        s1.src = "https://embed.tawk.to/69f1165f4648951c37a18238/1jnarupqq";
        s1.charset = "UTF-8";

        s0.parentNode?.insertBefore(s1, s0);
      })();
    });

    window.Tawk_API.onLoad = function () {
      window.Tawk_API.hideWidget?.();
    };

    return () => {
      cancelled = true;
      if (typeof handle === "number") clearTimeout(handle);
    };
  }, []);

  return null;
}
