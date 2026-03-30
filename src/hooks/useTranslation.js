"use client";

import { useCallback } from "react";
import { useLanguage } from "../context/LanguageContext";
import { translations } from "../lib/translations";

export function useTranslation() {
  const { language } = useLanguage();

  const t = useCallback(
    (key) => {
      return translations?.[language]?.[key] ?? translations.en?.[key] ?? key;
    },
    [language]
  );

  return { t, language };
}
