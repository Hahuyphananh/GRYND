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

    (function () {
      const s1 = document.createElement("script");
      const s0 = document.getElementsByTagName("script")[0];

      s1.async = true;
      s1.src = "https://embed.tawk.to/69f1165f4648951c37a18238/1jnarupqq";
      s1.charset = "UTF-8";
      s1.setAttribute("crossorigin", "*");

      s0.parentNode?.insertBefore(s1, s0);
    })();

    window.Tawk_API.onLoad = function () {
      window.Tawk_API.hideWidget?.();
    };
  }, []);

  return null;
}
