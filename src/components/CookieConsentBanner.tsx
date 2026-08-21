"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import posthog from "posthog-js";
import { useTranslation } from "../hooks/useTranslation";
import {
  getCookieConsent,
  setCookieConsent,
  type CookieConsent,
} from "../lib/cookieConsent";

export default function CookieConsentBanner() {
  const [visible, setVisible] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const { t } = useTranslation();

  // Show the banner only until the visitor makes a choice.
  useEffect(() => {
    if (getCookieConsent() === null) setVisible(true);
  }, []);

  if (!visible) return null;

  const choose = (value: CookieConsent) => {
    setCookieConsent(value);
    try {
      if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
        if (value === "accepted") posthog.opt_in_capturing();
        else posthog.opt_out_capturing();
      }
    } catch {
      // PostHog client not ready / not configured — the stored choice still applies.
    }
    setVisible(false);
  };

  return (
    <motion.div
      initial={shouldReduceMotion ? false : { opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      role="region"
      aria-label={t("cookieBanner.title")}
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-[#00e5ff]/30 bg-[#050b1e]/95 shadow-[0_-8px_30px_rgba(0,229,255,0.15)] backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-3 px-4 py-4 sm:flex-row sm:gap-6 sm:px-6">
        <div className="flex-1 text-center sm:text-left">
          <p className="text-sm font-bold text-[#f5ff3b]">
            {t("cookieBanner.title")}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-[#c9f7ff]/90">
            {t("cookieBanner.text")}
          </p>
        </div>
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:gap-3">
          <Link
            href="/privacy-policy"
            className="rounded-lg px-4 py-2 text-sm font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#d8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {t("cookieBanner.privacyLink")}
          </Link>
          <button
            type="button"
            onClick={() => choose("declined")}
            className="rounded-lg border border-[#00e5ff]/40 bg-transparent px-4 py-2 text-sm font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {t("cookieBanner.decline")}
          </button>
          <button
            type="button"
            onClick={() => choose("accepted")}
            className="rounded-lg border border-[#f5ff3b]/50 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-2 text-sm font-bold text-[#1f1700] shadow-[0_0_18px_rgba(245,255,59,0.4)] transition-all hover:shadow-[0_0_26px_rgba(245,255,59,0.65)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
          >
            {t("cookieBanner.accept")}
          </button>
        </div>
      </div>
    </motion.div>
  );
}
