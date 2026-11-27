"use client";

// src/components/ads/AdcashBannerUnit.tsx
//
// The browser-side half of the Adcash banner. It loads the Adcash library at
// most once per document, then executes `aclib.runBanner({ zoneId, renderIn })`
// — Adcash's documented Display mechanism — pointing at a GRYND-owned
// container.
//
// ── WHAT IT GUARANTEES ────────────────────────────────────────────────────
//
//   * ONE LIBRARY PER DOCUMENT. A DOM sentinel covers React remounts and
//     client-side navigation that keeps the document; an existing library is
//     reused, never appended again.
//   * ONE ZONE EXECUTION PER DOCUMENT. A module-scoped set keyed by
//     placement+zone means a remount cannot call `runBanner` twice. A second
//     mount still observes the container so a creative that arrives late is
//     detected.
//   * NEVER OFF ITS OWN PAGE. The pathname must be exactly the route this
//     placement belongs to, and the shared gameplay classifier must not match.
//   * CONSENT FIRST. With consent required (the default), nothing is drawn
//     until the stored record says "accepted"; accepting later in the same page
//     loads it through the consent-change event.
//   * CONTAINED. `renderIn` is our container's selector. This code never
//     touches `document.body`, never positions anything fixed/absolute, and
//     never calls `runPop`, `runAutoTag`, an interstitial, in-page push, video
//     slider or anti-adblock API.
//   * BOUNDED AND HONEST. A failed library load, a CSP-refused resource or an
//     unfilled zone collapses the reserved area after a bounded wait. No
//     placeholder creative and no retry loop.

import { useEffect, useRef, useState } from "react";

import AdCodeMarker from "../AdCodeMarker";
import { isMatchHref } from "../../lib/matchNavigation";
import { COOKIE_CONSENT_EVENT, getCookieConsent } from "../../lib/cookieConsent";
import {
  ADCASH_LIBRARY_ATTRIBUTE,
  ADCASH_READY_TIMEOUT_MS,
  ADCASH_RESERVED_HEIGHTS,
  adcashBannerSize,
  adcashConsentSatisfied,
  adcashContainerId,
  adcashLibraryUrl,
  adcashRequiresConsent,
  adcashRouteMatchesPlacement,
  adcashRunKey,
  adcashSizeForZone,
  adcashSizeMaxWidth,
  adcashZoneId,
  isAdcashProviderHost,
  shouldRunAdcashZone,
  type AdcashPlacement,
} from "../../lib/adcash/config";

type Phase = "idle" | "loading" | "filled" | "unavailable";

/**
 * Zone executions already performed in this document. Module scope survives
 * React remounts and client-side navigation, which is exactly the lifetime the
 * guard needs.
 */
const executedZones = new Set<string>();

/** True once the provider has actually drawn something in our container. */
function bannerPresent(container: HTMLElement): boolean {
  if (container.childElementCount === 0) return false;
  if (container.querySelector("iframe, img, video, canvas, object, embed")) return true;

  // No recognised creative node: only a laid-out box counts, so an empty
  // container is never mistaken for a served ad.
  const rect = container.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

export default function AdcashBannerUnit({
  placement,
}: {
  placement: AdcashPlacement;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [consent, setConsent] = useState<"accepted" | "declined" | null>(() =>
    getCookieConsent(),
  );

  // The zone this placement serves, resolved once for the render as well as the
  // effect: the reserved box must match THAT zone's creative size, because the
  // pool holds both a 300x250 and a 728x90.
  const zone = adcashZoneId(placement);
  const bannerSize = adcashSizeForZone(zone) ?? adcashBannerSize(placement);

  useEffect(() => {
    const onConsentChange = () => setConsent(getCookieConsent());
    window.addEventListener(COOKIE_CONSENT_EVENT, onConsentChange);
    return () => window.removeEventListener(COOKIE_CONSENT_EVENT, onConsentChange);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    // 1. ROUTE GUARD — exact pathname, then the shared gameplay classifier.
    if (!adcashRouteMatchesPlacement(window.location.pathname, placement)) {
      setPhase("unavailable");
      return undefined;
    }
    if (isMatchHref(`${window.location.pathname}${window.location.search}`)) {
      setPhase("unavailable");
      return undefined;
    }

    // 2. CONSENT — read here because the record lives in this browser. The
    //    render below hides the slot until it is satisfied; not marking the
    //    phase unavailable is what lets a later acceptance mount and run.
    if (adcashRequiresConsent() && !adcashConsentSatisfied(consent)) {
      return undefined;
    }

    // 3. CONFIGURATION — no invented zone id or library URL, ever.
    const libraryUrl = adcashLibraryUrl();
    if (!zone || !libraryUrl) {
      setPhase("unavailable");
      return undefined;
    }

    setPhase("loading");
    let cancelled = false;
    let observer: MutationObserver | null = null;
    let timer = 0;

    const stop = () => {
      observer?.disconnect();
      observer = null;
      window.clearTimeout(timer);
    };

    const fail = () => {
      if (cancelled) return;
      stop();
      setPhase("unavailable");
    };

    // 4. FILL DETECTION — watch OUR container, not the whole document.
    observer = new MutationObserver(() => {
      if (cancelled) return;
      if (bannerPresent(host)) {
        setPhase("filled");
        stop();
      }
    });
    observer.observe(host, { childList: true, subtree: true });

    // 5. POLICY-BLOCKED RESOURCE — a `script-src` or `frame-src` that does not
    //    name the provider collapses the slot instead of leaving a blank box.
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (cancelled) return;
      const directive = String(event.effectiveDirective);
      if (!directive.startsWith("script-src") && !directive.startsWith("frame-src")) {
        return;
      }
      try {
        if (!isAdcashProviderHost(new URL(String(event.blockedURI)).hostname)) return;
      } catch {
        return;
      }
      fail();
    };
    document.addEventListener("securitypolicyviolation", onViolation);

    // 6. BOUNDED WAIT — an unfilled zone reserves space only briefly.
    timer = window.setTimeout(fail, ADCASH_READY_TIMEOUT_MS);

    // 7. RUN THE ZONE — at most once per zone in this document.
    const key = adcashRunKey(placement, zone);
    const run = () => {
      if (cancelled) return;
      // Claim the zone HERE, not when the library starts loading: React's
      // development double-effect cleans up the first load listener before the
      // script arrives, and the second mount must still be allowed to execute.
      if (!shouldRunAdcashZone(executedZones, key)) return;
      executedZones.add(key);

      const api = (
        window as unknown as {
          aclib?: { runBanner?: (options: Record<string, string>) => unknown };
        }
      ).aclib;

      if (!api || typeof api.runBanner !== "function") {
        fail();
        return;
      }

      try {
        const result = api.runBanner({
          zoneId: zone,
          renderIn: `#${adcashContainerId(placement)}`,
        });
        // Some builds return a promise; a rejection is a failed request.
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          (result as Promise<unknown>).catch(fail);
        }
      } catch {
        fail();
        return;
      }

      if (bannerPresent(host)) {
        setPhase("filled");
        stop();
      }
    };

    if (shouldRunAdcashZone(executedZones, key)) {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[${ADCASH_LIBRARY_ATTRIBUTE}]`,
      );

      if (existing) {
        // The library is already in this document (an earlier mount). Run now
        // only if it has executed; otherwise wait for its load. Calling
        // `runBanner` before `aclib` exists would fail a healthy load.
        if ((window as unknown as { aclib?: unknown }).aclib) run();
        else existing.addEventListener("load", run, { once: true });
      } else {
        const script = document.createElement("script");
        script.src = libraryUrl;
        script.async = true;
        script.type = "text/javascript";
        script.setAttribute(ADCASH_LIBRARY_ATTRIBUTE, "1");
        script.addEventListener("load", run, { once: true });
        script.addEventListener("error", fail, { once: true });
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      document.removeEventListener("securitypolicyviolation", onViolation);
      stop();
    };
  }, [placement, consent, zone]);

  const consentSatisfied =
    !adcashRequiresConsent() || adcashConsentSatisfied(consent);

  // Nothing is drawn for a declined/undecided visitor, a refused route, an
  // unconfigured placement or a failed request.
  if (phase === "unavailable" || !consentSatisfied) return null;

  return (
    <>
      <AdCodeMarker />
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.2em] text-[#9dd8ff]/50">
        Advertisement
      </span>
      <div
        ref={hostRef}
        id={adcashContainerId(placement)}
        data-grynd-adcash-zone={placement}
        data-grynd-adcash={phase}
        role="group"
        aria-label="Advertisement"
        className="mx-auto flex w-full items-center justify-center overflow-hidden"
        style={{
          maxWidth: adcashSizeMaxWidth(bannerSize),
          minHeight: ADCASH_RESERVED_HEIGHTS[bannerSize],
        }}
      />
    </>
  );
}
