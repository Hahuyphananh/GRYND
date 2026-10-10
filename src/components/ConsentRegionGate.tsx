"use client";

import { useEffect, useState } from "react";
import { COUNTRY_COOKIE, requiresGoogleCmp } from "../lib/consentRegions";
import CmpConsentBridge from "./CmpConsentBridge";
import CookieConsentBanner from "./CookieConsentBanner";

/**
 * Chooses which consent prompt this visitor gets — on the client, deliberately.
 *
 * Google requires its own certified CMP (IAB TCF) for the EEA, the UK and
 * Switzerland; everywhere else our own banner is the prompt. Showing both would
 * be two prompts over two consent records that can disagree, so exactly one is
 * allowed to render.
 *
 * That decision used to be made in the root layout from the request's country
 * header. It cannot be any more: touching the request headers there (or
 * exporting `dynamic = "force-dynamic"`) makes EVERY route in the app render per
 * request. On Cloudflare Workers a request gets 10 ms of CPU, and measured page
 * renders needed 38-937 ms, so 5-20% of page loads were killed with error 1102
 * (exceededCpu). With the layout static, Next prerenders the route at build time
 * and the Worker serves that HTML without rendering it.
 *
 * So the middleware stamps `cf_country` — from the same header, via
 * lib/consentRegions.ts — onto the response that carries this HTML. The browser
 * applies `Set-Cookie` before any script runs, so the region is known on the
 * FIRST page view: there is no round trip and no window in which the wrong
 * prompt could show.
 *
 * Nothing renders until the cookie has been read (one tick after mount). That is
 * the point: rendering the banner against a placeholder region would show OUR
 * prompt to exactly the EEA visitors whose certified CMP has to be the one they
 * see — a compliance problem, not a cosmetic one.
 */
export default function ConsentRegionGate() {
  // null = region not known yet. "" = nothing reported a country (local dev,
  // or a request with no geo header), which `requiresGoogleCmp` treats as
  // non-EEA — i.e. our banner, exactly as before this change.
  const [country, setCountry] = useState<string | null>(null);

  useEffect(() => {
    const match = document.cookie.match(
      new RegExp("(?:^|; )" + COUNTRY_COOKIE + "=([^;]*)"),
    );
    setCountry(match ? decodeURIComponent(match[1]).toUpperCase() : "");
  }, []);

  if (country === null) return null;

  const requiresCmp = requiresGoogleCmp(country);

  return (
    <>
      {/* Mirrors Google's CMP decision into the local consent record so the
          existing gating (GA, PostHog, Sentry) keeps working for EEA/UK/Swiss
          visitors. No-op elsewhere. */}
      <CmpConsentBridge enabled={requiresCmp} />
      {/* Suppressed where the CMP owns consent; also stands aside if the CMP
          later reports its regulations don't apply (see the component). */}
      <CookieConsentBanner suppressForCmp={requiresCmp} />
    </>
  );
}
