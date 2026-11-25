import type { ElementType, ReactNode } from "react";
import { cx } from "./cx";

/**
 * One container for every card, panel and well. Replaces the hand-written
 * dark-navy card classes, the `bg-white/[0.02]` washes and the one-offGround
 * literals the audit found repeated across screens.
 *
 * Tone is semantic, never a colour: `raised` is the default card, `panel` is a
 * recessed well inside a card, `warning` / `success` add a status hairline for
 * the two settings sections that need one. The hairline plus a soft shadow is
 * the depth language — no glow, which is what the audit counted 203 of.
 */
const TONES = {
  page: "bg-[color:var(--bg-page)] border-[color:var(--border-hairline)]",
  raised:
    "bg-[color:var(--bg-surface)] border-[color:var(--border-hairline)] shadow-[var(--shadow-raise)]",
  panel: "bg-[color:var(--bg-panel)] border-[color:var(--border-hairline)]",
  warning: "bg-[color:var(--bg-surface)] border-[color:var(--border-warning)]",
  success: "bg-[color:var(--bg-surface)] border-[color:var(--border-success)]",
} as const;

const PADDING = {
  none: "",
  sm: "p-3",
  md: "p-5 sm:p-6",
  lg: "p-6 sm:p-8",
} as const;

export default function Surface({
  children,
  tone = "raised",
  padding = "md",
  as,
  className,
}: {
  children: ReactNode;
  tone?: keyof typeof TONES;
  padding?: keyof typeof PADDING;
  as?: ElementType;
  className?: string;
}) {
  const Tag: ElementType = as ?? "div";
  return (
    <Tag
      className={cx(
        "rounded-[var(--radius-surface)] border",
        TONES[tone],
        PADDING[padding],
        className,
      )}
    >
      {children}
    </Tag>
  );
}
