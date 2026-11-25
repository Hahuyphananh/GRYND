"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { cx } from "./cx";

export type TabItem = { key: string; label: string };

/**
 * A segmented choice: one option out of a short list, styled as a pill row.
 *
 * This is deliberately a `group` of `aria-pressed` buttons rather than an
 * ARIA tablist: it is used where the choice itself is the state (language,
 * loss-limit mode), not where a panel swaps in below. Screens that genuinely
 * swap panels (UserStatsTabs) keep their tablist semantics when they migrate.
 *
 * Keyboard: arrows and Home/End move the selection, matching the roving
 * behaviour a segmented control needs to be usable without a mouse.
 */
export default function Tabs({
  items,
  value,
  onChange,
  label,
  size = "md",
  className,
}: {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  /** Accessible name for the group, e.g. "Language". */
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = items.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    onChange(items[next].key);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="group"
      aria-label={label}
      className={cx("flex flex-wrap gap-2", className)}
    >
      {items.map((item, index) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              "rounded-full border font-semibold transition-colors duration-fast ease-standard",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]",
              size === "sm" ? "px-3 py-1 text-[11px]" : "px-4 py-1.5 text-sm",
              active
                ? "border-[color:var(--accent)] bg-[color:var(--accent-fill)] text-[color:var(--accent-strong)]"
                : "border-[color:var(--border-strong)] text-[color:var(--text-secondary)] hover:bg-[color:var(--bg-panel)] hover:text-[color:var(--text-primary)]",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
