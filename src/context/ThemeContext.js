"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const ThemeContext = createContext({
  theme: "dark",
  setTheme: () => {},
  toggleTheme: () => {},
});

const STORAGE_KEY = "casino_app_theme";

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState("dark");

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;

    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
    body?.setAttribute("data-theme", "dark");
    window.localStorage.setItem(STORAGE_KEY, "dark");
  }, []);

  const setTheme = () => {
    setThemeState("dark");
    const root = document.documentElement;
    const body = document.body;
    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
    body?.setAttribute("data-theme", "dark");
    window.localStorage.setItem(STORAGE_KEY, "dark");
  };

  const toggleTheme = () => {
    setTheme();
  };

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
