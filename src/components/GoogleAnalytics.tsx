"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { COOKIE_CONSENT_EVENT, getCookieConsent } from "../lib/cookieConsent";

/**
 * Google Analytics 4 measurement ID for the GRYND property. Public by design —
 * it ships in the page source either way.
 */
export const GA_MEASUREMENT_ID = "G-PFN3BBLC0E";

/**
 * Google Analytics 4 (gtag.js) for every page. Rendered once from the root
 * layout (src/app/layout.tsx), so every route gets it — including the pages
 * that never mount a client provider.
 *
 * The snippet is Google's, verbatim — the async loader, the `dataLayer` queue,
 * `gtag('js', …)` and `gtag('config', 'G-PFN3BBLC0E')`:
 *
 *   <script async src="https://www.googletagmanager.com/gtag/js?id=G-PFN3BBLC0E"></script>
 *   <script>
 *     window.dataLayer = window.dataLayer || [];
 *     function gtag(){dataLayer.push(arguments);}
 *     gtag('js', new Date());
 *     gtag('config', 'G-PFN3BBLC0E');
 *   </script>
 *
 * CONSENT FIRST. GA is a non-essential analytics provider, and both our
 * published privacy policy and the cookie-consent banner promise that
 * analytics are only enabled once the visitor accepts (Quebec's Law 25 |
 * GDPR). So the tag is deliberately absent from the initial HTML: `gtag.js`
 * is only fetched after consent reads "accepted", mirroring PostHog, which is
 * initialised opted-out until the same banner says otherwise
 * (components/PostHogProvider.tsx). A visitor who declines makes no request to
 * googletagmanager.com and gets no GA cookies at all.
 *
 * `strategy="afterInteractive"` keeps the loader out of the critical path, so
 * it can never compete with hydration. GA4's own "page changes based on
 * browser history events" measures App Router navigations, so no manual
 * `page_view` calls are needed.
 */
export default function GoogleAnalytics() {
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    const sync = () => {
      const granted = getCookieConsent() === "accepted";
      // `ga-disable-<ID>` is GA's documented kill switch: while it is set,
      // gtag.js stops collecting and stops writing its cookies. Kept in sync so
      // a visitor who withdraws consent stops being measured without a reload.
      (window as unknown as Record<string, unknown>)[`ga-disable-${GA_MEASUREMENT_ID}`] = !granted;
      setAccepted(granted);
    };

    sync();
    // The banner records the choice and fires COOKIE_CONSENT_EVENT, so
    // accepting enables GA in the same session (no reload); another tab's
    // choice arrives through `storage`.
    window.addEventListener(COOKIE_CONSENT_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(COOKIE_CONSENT_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Not in the markup, and never fetched, until consent is granted.
  if (!accepted) return null;

  return (
    <>
      <Script
        id="ga-gtag"
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga-init" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}');`}
      </Script>
    </>
  );
}
