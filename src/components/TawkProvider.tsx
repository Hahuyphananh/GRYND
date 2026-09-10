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
      setAttributes?: (attributes: Record<string, unknown>, callback?: () => void) => void;
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
        // Subresource Integrity — the loader is served over Tawk's CDN, so pin
        // its exact bytes to prevent a compromised/ swapped script from running.
        // Recompute if Tawk ever changes this loader:
        //   curl -s https://embed.tawk.to/69f1165f4648951c37a18238/1jnarupqq | openssl dgst -sha384 -binary | openssl base64 -A
        s1.integrity =
          "sha384-btJ+tUFYAkFoBqDb5E+bY7Zwp2l3dVKd0olPDHuOQla/201qMQZvFPeT/mh32+o7";
        s1.crossOrigin = "anonymous";

        s0.parentNode?.insertBefore(s1, s0);
      })();
    });

    window.Tawk_API.onLoad = function () {
      window.Tawk_API.hideWidget?.();

      // Flag Grynd+ members for support agents (priority support perk):
      // custom attributes are visible to agents on the Tawk dashboard.
      fetch("/api/membership/status", { credentials: "include" })
        .then((response) => response.json().catch(() => ({})))
        .then((data) => {
          const active = Boolean(data?.active);
          window.Tawk_API.setAttributes?.(
            {
              premium: active,
              premiumTier: active ? "grynd+" : null,
            },
            () => {},
          );
        })
        .catch(() => {
          // Non-fatal — support flag is best-effort.
        });
    };

    return () => {
      cancelled = true;
      if (typeof handle === "number") clearTimeout(handle);
    };
  }, []);

  return null;
}
