"use client";

import { useEffect } from "react";

export default function DisableInspect() {
  useEffect(() => {
    const onContextMenu = (e) => e.preventDefault();
    const onKeyDown = (e) => {
      const key = e.key?.toLowerCase();
      const blocked =
        key === "f12" ||
        (e.ctrlKey && e.shiftKey && ["i", "j", "c", "k"].includes(key)) ||
        (e.metaKey && e.altKey && ["i", "j", "c", "k"].includes(key)) ||
        (e.ctrlKey && key === "u") ||
        (e.metaKey && key === "u");

      if (blocked) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    document.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return null;
}
