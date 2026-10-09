"use client";

// src/context/ThemeContext.js
//
// The app's light/dark switch.
//
// The theme is carried on <html data-theme="light|dark">, which is what
// src/app/light-theme.css (generated — see scripts/generate-light-theme.mjs)
// keys its whole override layer off. It is NOT carried by Tailwind's `dark`
// class alone: the app has no `dark:` variants, so flipping that class would
// change nothing. The class is kept in sync anyway, because `darkMode:
// "class"` is still configured and a future `dark:` variant would otherwise
// silently ignore the theme.
//
// Three things have to agree, or the user sees a flash of the wrong theme:
//
//   1. the bootstrap script in src/app/layout.tsx, which sets data-theme
//      before first paint (React hasn't run yet),
//   2. this provider's initial state, which reads the DOM the script already
//      settled (reading it in an effect instead would paint one wrong frame),
//   3. every write, which goes through applyTheme() so the attribute, the
//      class, color-scheme and the <meta name="theme-color"> never drift.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/** Device preference key — `grynd_*` like the app's other stored prefs. */
export const THEME_STORAGE_KEY = "grynd_theme";
/** The key the old always-dark provider wrote. Read once, then migrated. */
const LEGACY_STORAGE_KEY = "casino_app_theme";

/** The two themes. Anything else is normalised to "dark". */
export const THEMES = ["dark", "light"];

/**
 * Browser chrome for each theme. Kept next to the palette's own ground colour
 * so the mobile address bar matches the page instead of banding against it.
 *
 * MUST equal the generator's PAGE constant
 * (scripts/generate-light-theme.mjs) and the value baked into the bootstrap
 * script in src/app/layout.tsx — three copies of one colour, because none of
 * them can import the others (the generator is build-time, the bootstrap runs
 * before any module loads).
 */
const META_COLOR = { dark: "#000000", light: "#d3e2f7" };

export const normalizeTheme = (value) =>
  value === "light" ? "light" : value === "dark" ? "dark" : null;

export function systemTheme() {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** The stored preference, or null when the visitor has never chosen one. */
export function readStoredTheme() {
  try {
    return (
      normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY)) ||
      normalizeTheme(window.localStorage.getItem(LEGACY_STORAGE_KEY))
    );
  } catch {
    // localStorage unavailable (private mode / disabled) — fall back to system.
    return null;
  }
}

/** Write the theme to the DOM. Single choke point, so nothing can drift. */
export function applyTheme(theme) {
  if (typeof document === "undefined") return;
  const isDark = theme !== "light";
  const root = document.documentElement;

  root.classList.toggle("dark", isDark);
  root.setAttribute("data-theme", isDark ? "dark" : "light");
  // Paints native widgets (scrollbars, caret, form controls, autofill) to match.
  root.style.colorScheme = isDark ? "dark" : "light";
  // Kept for the layouts that style off the body attribute.
  document.body?.setAttribute("data-theme", isDark ? "dark" : "light");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", META_COLOR[isDark ? "dark" : "light"]);
}

const ThemeContext = createContext({
  theme: "dark",
  setTheme: () => {},
  toggleTheme: () => {},
});

export function ThemeProvider({ children }) {
  // Resolved during the first client render, from what the bootstrap script
  // already painted. On the server it is "dark" — the value baked into
  // <html className="dark"> — and the root layout's `suppressHydrationWarning`
  // covers the html element's own attributes.
  const [theme, setThemeState] = useState(() => {
    if (typeof document === "undefined") return "dark";
    const stored = readStoredTheme();
    if (stored) return stored;
    const painted = normalizeTheme(
      document.documentElement.getAttribute("data-theme"),
    );
    return painted || systemTheme();
  });

  // No preference stored yet? Then the visitor is on "follow the system", so
  // keep following it live — a device that flips at sunset should follow.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (readStoredTheme()) return;
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (event) => {
      const next = event.matches ? "light" : "dark";
      setThemeState(next);
      applyTheme(next);
    };
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  const setTheme = useCallback((next) => {
    const theme = normalizeTheme(next);
    if (!theme) return;
    setThemeState(theme);
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      // The old key would otherwise win on the next visit via readStoredTheme.
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Preference just won't survive the reload — the theme still applies.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(
      document.documentElement.getAttribute("data-theme") === "light"
        ? "dark"
        : "light",
    );
  }, [setTheme]);

  const value = useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
