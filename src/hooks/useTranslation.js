"use client";

import { useCallback } from "react";
import { useLanguage } from "../context/LanguageContext";
import { t as translate } from "../lib/appTextTranslations";

export function useTranslation() {
  const { language } = useLanguage();

  const t = useCallback((key) => translate(language, key), [language]);

  return { t, language };
}
