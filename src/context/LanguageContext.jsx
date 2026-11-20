"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const LanguageContext = createContext({
  language: "en",
  setLanguage: () => {},
});

const STORAGE_KEY = "casino_app_language";

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState("en");
  // Do not write the first render's default `en` over a stored locale before
  // the stored value has been read. That race made a saved French/Spanish
  // preference fall back to English on every page load.
  const [isLanguageReady, setIsLanguageReady] = useState(false);

  useEffect(() => {
    let next = "en";
    try {
      const storedLanguage = window.localStorage.getItem(STORAGE_KEY);
      if (storedLanguage && ["en", "fr", "es"].includes(storedLanguage)) {
        next = storedLanguage;
      }
    } catch {
      // Private mode / blocked storage: use English for this session.
    }
    setLanguage(next);
    setIsLanguageReady(true);
  }, []);

  useEffect(() => {
    if (!isLanguageReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
      document.documentElement.lang = language;
    } catch {
      // The chosen language still applies for this page view.
    }
  }, [isLanguageReady, language]);

  const value = useMemo(() => ({ language, setLanguage }), [language]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
