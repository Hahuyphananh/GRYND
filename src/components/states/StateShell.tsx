"use client";

import type { ReactNode } from "react";

/**
 * Shared visual shell for the empty / error / offline states so all three
 * read as one system: a bordered panel, an icon medallion, a headline, one
 * line of explanation, and the action(s).
 *
 * Kept deliberately quiet (no motion) — these states replace content, they
 * shouldn't compete with it.
 */
export default function StateShell({
  icon,
  tone = "neutral",
  title,
  description,
  children,
  className = "",
  live = "polite",
}: {
  icon?: ReactNode;
  tone?: "neutral" | "danger" | "warning";
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  live?: "polite" | "assertive" | "off";
}) {
  const tones = {
    neutral: {
      ring: "border-[#00e5ff]/35 bg-[#08142f]/90",
      medallion: "border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#00e5ff]",
      title: "text-[#c9f7ff]",
    },
    warning: {
      ring: "border-[#f5ff3b]/35 bg-[#08142f]/90",
      medallion: "border-[#f5ff3b]/45 bg-[#f5ff3b]/10 text-[#f5ff3b]",
      title: "text-[#f5ff3b]",
    },
    danger: {
      ring: "border-red-400/35 bg-[#1a0b16]/90",
      medallion: "border-red-400/45 bg-red-500/10 text-red-300",
      title: "text-red-200",
    },
  }[tone];

  const role = live === "assertive" ? "alert" : "status";

  return (
    <div
      role={role}
      aria-live={live === "off" ? undefined : live}
      className={`flex flex-col items-center gap-3 rounded-xl border ${tones.ring} px-6 py-10 text-center shadow-[0_0_28px_rgba(0,229,255,0.08)] ${className}`}
    >
      {icon && (
        <span
          aria-hidden="true"
          className={`flex h-12 w-12 items-center justify-center rounded-full border ${tones.medallion}`}
        >
          {icon}
        </span>
      )}
      <p className={`text-lg font-bold ${tones.title}`}>{title}</p>
      {description && (
        <p className="max-w-md text-sm leading-relaxed text-cyan-200/80">{description}</p>
      )}
      {children && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  );
}

/** Shared primary/secondary action styling for the three states. */
export const statePrimaryAction =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b] px-5 py-2.5 text-sm font-bold text-[#041125] transition-all hover:bg-[#f5ff3b]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f] active:scale-95 disabled:opacity-60";

export const stateSecondaryAction =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-[#00e5ff]/50 bg-[#0a214d] px-5 py-2.5 text-sm font-semibold text-[#00e5ff] transition-all hover:bg-[#123b82] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f] active:scale-95 disabled:opacity-60";
