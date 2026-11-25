"use client";

// src/components/ui/SpotlightCard.tsx
//
// A panel that paints a soft accent glow under the cursor. The pointer position
// is written to two CSS custom properties on the element, so moving the mouse
// never re-renders React; the glow itself is a pseudo-free child layer whose
// opacity only changes on hover/focus.
//
// Mouse-only by design (a touch drag should not leave a lit card behind), and
// purely decorative: the content above the glow is unchanged and the border
// still carries the semantic token.

import { useRef } from "react";
import type { PointerEvent, ReactNode } from "react";
import styles from "./SpotlightCard.module.css";

export default function SpotlightCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse") return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    el.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
  };

  return (
    <div
      ref={ref}
      onPointerMove={onPointerMove}
      className={`${styles.card} ${className}`}
    >
      <span aria-hidden="true" className={styles.glow} />
      <div className="relative">{children}</div>
    </div>
  );
}
