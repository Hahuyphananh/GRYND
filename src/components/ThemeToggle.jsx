"use client";

// src/components/ThemeToggle.jsx
//
// The light/dark switch. It is deliberately a plain button, not a slider or a
// segmented control: the app has exactly two themes and one of them is already
// on, so a single press that flips to the other is the whole interaction.
//
// THE MOUNTED GUARD IS LOAD-BEARING. The server always renders the dark theme
// (see src/app/layout.tsx), and the bootstrap script may have flipped the
// document to light before React hydrates. If the glyph were derived from
// `theme` on the first client render, React would compare a moon against the
// server's sun and report a hydration mismatch. Resolving the glyph after
// mount keeps the two in step — and because the button is a fixed-size icon
// slot, the swap costs no layout shift.
//
// aria-pressed reports the state rather than the action, and the label names
// the action, which is what a screen reader needs to hear before the press.

import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "@tabler/icons-react";
import { useTheme } from "../context/ThemeContext";
import { useTranslation } from "../hooks/useTranslation";

const ICON_SIZE = 18;

export default function ThemeToggle({ className = "", showLabel = false }) {
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isLight = mounted && theme === "light";
  const label = t(isLight ? "nav.theme_dark" : "nav.theme_light");

  return (
    <button
      type="button"
      onClick={toggleTheme}
      data-testid="theme-toggle"
      aria-label={label}
      aria-pressed={isLight}
      title={label}
      className={
        className ||
        "inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#d8fbff] transition-colors hover:bg-[#00e5ff]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050b1e]"
      }
    >
      {/* Before mount the glyph is fixed, so the server and the client agree. */}
      {isLight ? <IconMoon size={ICON_SIZE} /> : <IconSun size={ICON_SIZE} />}
      {showLabel && <span className="ml-2 text-sm font-medium">{label}</span>}
    </button>
  );
}
