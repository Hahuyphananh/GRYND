"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useTranslation } from "../hooks/useTranslation";
import {
  COOKIE_CONSENT_EVENT,
  getCookieConsent,
} from "../lib/cookieConsent";

/**
 * Mobile-only sticky bottom CTA, used on the home page and casino lobby.
 *
 * • Hidden on md+ screens — the top nav and in-view buttons cover desktop.
 * • Hidden while the cookie-consent banner is visible so the two bars never
 *   stack: the banner sits at z-[60] and the chat bubble at z-[70], so this
 *   bar deliberately stays at z-[50] and defers to them.
 * • Logged out → "Claim Free Tokens" (signup hook). Logged in → "Play now",
 *   with the destination controlled by the `playHref` prop.
 */
export default function StickyMobileCta({ playHref = "/casino" }) {
  const { isLoaded, isSignedIn } = useUser();
  const { t } = useTranslation();
  const [consentGiven, setConsentGiven] = useState(false);

  useEffect(() => {
    const sync = () => setConsentGiven(getCookieConsent() !== null);
    sync();
    window.addEventListener(COOKIE_CONSENT_EVENT, sync);
    return () => window.removeEventListener(COOKIE_CONSENT_EVENT, sync);
  }, []);

  // Wait for auth to load and for the cookie banner to be dismissed so we
  // never flash two stacked bars on a first visit.
  if (!isLoaded || !consentGiven) return null;

  const href = isSignedIn ? playHref : "/sign-up";
  const label = isSignedIn
    ? t("stickyCta.play", "Play now")
    : t("stickyCta.claim", "Claim Free Tokens");

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[50] border-t border-[#00e5ff]/30 bg-[#050b1e]/95 shadow-[0_-8px_30px_rgba(0,229,255,0.15)] backdrop-blur-md md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="px-4 py-3">
        <Link
          href={href}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-yellow-300 to-amber-500 px-6 py-3 text-base font-extrabold text-black shadow-[0_0_22px_rgba(255,255,51,0.55)] transition-transform active:scale-[0.98]"
        >
          {label}
        </Link>
      </div>
    </div>
  );
}
