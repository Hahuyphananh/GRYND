"use client";

import { useCallback } from "react";
import { useLanguage } from "../context/LanguageContext";
import { t as translate } from "../lib/appTextTranslations";

export function useTranslation() {
  const { language } = useLanguage();

  // `params` enables interpolation of `{placeholder}` tokens inside the
  // resolved string (e.g. `t("games.precision.wager_tokens", { wager: 100 })`).
  // The underlying `t()` in `appTextTranslations.js` performs the actual
  // substitution; if a placeholder key is missing, it stays visible in the UI
  // so the call-site can spot the gap.
  const t = useCallback(
    (key, params) => translate(language, key, params),
    [language]
  );

  return { t, language };
}
