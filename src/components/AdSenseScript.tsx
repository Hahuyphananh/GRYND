"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { COOKIE_CONSENT_EVENT, getCookieConsent } from "../lib/cookieConsent";

/**
 * AdSense publisher ID for the GRYND property. Public by design — it ships in
 * the page source either way.
 */
export const ADSENSE_CLIENT = "ca-pub-4903728316211815";

/**
 * Google AdSense loader, for the pages we monetise: the home page, the game
 * hub, the leaderboard, the battlepass and the game lobbies.
 *
 * Deliberately NOT in the root layout. AdSense pays for impressions on the
 * pages a player browses *between* games, and an ad on a live board is both an
 * intrusion and a distraction from a wager in progress. So this is rendered
 * per page instead, and it is absent from:
 *
 *   - every match page (the `[matchId]` / `game/[gameId]` / `table/[tableId]`
 *     routes), and
 *   - the games whose lobby and board live in ONE page — Dice Flush and Odds
 *     today — because there is no lobby route to put it on that isn't also the
 *     board.
 *
 * The snippet is Google's, verbatim:
 *
 *   <script async
 *     src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4903728316211815"
 *     crossorigin="anonymous"></script>
 *
 * CONSENT FIRST. AdSense sets advertising cookies, so it is a non-essential
 * provider under both our published privacy policy and the cookie-consent
 * banner, which promise that such providers only run once the visitor accepts
 * (Quebec's Law 25 | GDPR). The tag is therefore absent from the
 * server-rendered HTML and only fetched after consent reads "accepted",
 * mirroring components/GoogleAnalytics.tsx and PostHogProvider.tsx. A visitor
 * who declines — or never answers — makes no request to googlesyndication.com
 * and gets no advertising cookies.
 *
 * NOTE for whoever files the AdSense review: Google's site verification reads
 * the RAW HTML for the tag in <head>, which a consent gate by definition does
 * not put there. If the property needs to pass that review, temporarily hoist
 * the loader into src/app/layout.tsx's <head> until it is approved, then put it
 * back behind the gate — the contract test in tests/adsense.test.mjs pins the
 * page allow-list either way.
 */
export default function AdSenseScript() {
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    const sync = () => setAccepted(getCookieConsent() === "accepted");

    sync();
    // The banner records the choice and fires COOKIE_CONSENT_EVENT, so
    // accepting enables ads in the same session (no reload); another tab's
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
    <Script
      id="adsbygoogle-init"
      async
      crossOrigin="anonymous"
      strategy="afterInteractive"
      src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`}
    />
  );
}
