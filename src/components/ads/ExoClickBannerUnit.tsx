"use client";

// src/components/ads/ExoClickBannerUnit.tsx
//
// The browser-side half of the ExoClick banner. It loads the provider's
// asynchronous banner tag EXACTLY ONCE per document, only inside a container
// GRYND owns, and only when every client-side requirement still holds.
//
// ── WHAT IT GUARANTEES ────────────────────────────────────────────────────
//
//   * ONE PROVIDER SCRIPT PER DOCUMENT. A DOM sentinel covers React remounts
//     and client-side navigation that keeps the document; an existing loader is
//     reused rather than appended again.
//   * ONE `<ins>` PER CONTAINER. A remount reuses the element already there.
//   * NEVER OFF ITS OWN PAGE. The pathname must be exactly the route this
//     placement belongs to, and the shared gameplay classifier must not match.
//   * CONSENT FIRST. With `NEXT_PUBLIC_EXOCLICK_REQUIRES_CONSENT` on (the
//     default), nothing is injected until the stored consent record says
//     "accepted". Accepting later in the same page loads the banner through the
//     consent-change event.
//   * BOUNDED AND HONEST. A blocked script, a CSP-refused frame or an unfilled
//     zone collapses the reserved area after a bounded wait. There is no
//     placeholder creative, no retry loop and no fake video.
//   * IN FLOW ONLY. The only nodes this code creates are a `<script>` and an
//     `<ins>` inside our container. It never touches `document.body`, never
//     positions anything fixed/absolute, and never calls a provider API for a
//     sticky, popunder, inline-push or interstitial format.
//   * NO UNKNOWN UNMOUNT. Only our observer, timer and listeners are released.
//     The provider's nodes live inside this component's own container, which
//     React removes with it.

import { useEffect, useRef, useState } from "react";

import AdCodeMarker from "../AdCodeMarker";
import { isMatchHref } from "../../lib/matchNavigation";
import { COOKIE_CONSENT_EVENT, getCookieConsent } from "../../lib/cookieConsent";
import {
  EXOCLICK_INS_ATTRIBUTE,
  EXOCLICK_PROVIDER_ATTRIBUTE,
  EXOCLICK_READY_TIMEOUT_MS,
  exoclickBannerScriptUrl,
  exoclickConsentSatisfied,
  exoclickContainerId,
  exoclickContainerMaxWidth,
  exoclickInsClass,
  exoclickRequiresConsent,
  exoclickReservedHeight,
  exoclickRouteMatchesPlacement,
  exoclickZoneId,
  isExoclickProviderHost,
  shouldInjectExoclickScript,
  type ExoclickPlacement,
} from "../../lib/exoclick/config";

type Phase = "idle" | "loading" | "filled" | "unavailable";

/** True once the provider has actually drawn something in our `<ins>`. */
function creativePresent(container: HTMLElement): boolean {
  const ins = container.querySelector<HTMLElement>(
    `ins[${EXOCLICK_INS_ATTRIBUTE}]`,
  );
  if (!ins) return false;

  // A conventional banner is an iframe or an image/video creative.
  if (ins.querySelector("iframe, img, video, canvas, object, embed")) return true;

  // No node we recognise: only a laid-out box counts. An empty `<ins>` has no
  // height, so "the tag loaded" is not mistaken for "an ad was served".
  const rect = ins.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

/** The loader URL already present in this document, or null. */
function existingProviderScriptUrl(): string | null {
  const script = document.querySelector<HTMLScriptElement>(
    `script[${EXOCLICK_PROVIDER_ATTRIBUTE}]`,
  );
  return script ? script.src || "" : null;
}

export default function ExoClickBannerUnit({
  placement,
}: {
  placement: ExoclickPlacement;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [consent, setConsent] = useState<"accepted" | "declined" | null>(() =>
    getCookieConsent(),
  );

  // A visitor can accept (or withdraw) consent without leaving the page.
  useEffect(() => {
    const onConsentChange = () => setConsent(getCookieConsent());
    window.addEventListener(COOKIE_CONSENT_EVENT, onConsentChange);
    return () => window.removeEventListener(COOKIE_CONSENT_EVENT, onConsentChange);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    // 1. ROUTE GUARD — the page being viewed must be the page this placement
    //    belongs to. Exact match, so a lobby/match/board/alias injects nothing.
    if (!exoclickRouteMatchesPlacement(window.location.pathname, placement)) {
      setPhase("unavailable");
      return undefined;
    }

    // 1b. GAMEPLAY GUARD — the shared classifier, as an independent belt.
    if (isMatchHref(`${window.location.pathname}${window.location.search}`)) {
      setPhase("unavailable");
      return undefined;
    }

    // 2. CONSENT — the record lives in this browser, so this is the only place
    //    it can be read. Undecided and declined both fail closed: the render
    //    below hides the slot, and this guard keeps the effect from doing any
    //    work. It deliberately does NOT mark the phase unavailable, so a
    //    visitor who accepts later in the same page mounts the container and
    //    this effect runs again with consent granted.
    if (exoclickRequiresConsent() && !exoclickConsentSatisfied(consent)) {
      return undefined;
    }

    // 3. CONFIGURATION — no invented zone id or class token, ever.
    const zone = exoclickZoneId(placement);
    const insClass = exoclickInsClass(placement);
    const url = exoclickBannerScriptUrl();
    if (!zone || !insClass || !url) {
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

    // 4. THE `<ins>` — created once inside our own container. The provider
    //    fills THIS element; it is never appended to `<body>`.
    let ins = host.querySelector<HTMLElement>(`ins[${EXOCLICK_INS_ATTRIBUTE}]`);
    if (!ins) {
      ins = document.createElement("ins");
      ins.className = insClass;
      ins.setAttribute("data-zoneid", zone);
      ins.setAttribute(EXOCLICK_INS_ATTRIBUTE, "1");
      host.appendChild(ins);
    }

    // 5. THE LOADER — at most once per document. `existingProviderScriptUrl`
    //    is the DOM sentinel; a remount or a client-side navigation reuses it.
    if (
      shouldInjectExoclickScript(existingProviderScriptUrl(), url) &&
      !document.querySelector(`script[${EXOCLICK_PROVIDER_ATTRIBUTE}]`)
    ) {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.type = "application/javascript";
      script.setAttribute(EXOCLICK_PROVIDER_ATTRIBUTE, "1");
      script.addEventListener("error", fail, { once: true });
      document.head.appendChild(script);
    }

    // 6. ASK THE PROVIDER TO SERVE. This is ExoClick's documented queue call;
    //    it is safe before the loader executes because `AdProvider` is a queue.
    try {
      const provider = window as unknown as { AdProvider?: unknown[] };
      provider.AdProvider = provider.AdProvider || [];
      provider.AdProvider.push({ serve: {} });
    } catch {
      fail();
      return undefined;
    }

    if (creativePresent(host)) {
      setPhase("filled");
      return undefined;
    }

    // 7. FILL DETECTION — the provider fills asynchronously, so watch the
    //    container rather than assuming a successful script load is an ad.
    observer = new MutationObserver(() => {
      if (cancelled) return;
      if (creativePresent(host)) {
        setPhase("filled");
        stop();
      }
    });
    observer.observe(host, { childList: true, subtree: true });

    // 8. POLICY-BLOCKED RESOURCE — a `script-src` or `frame-src` that does not
    //    name the provider collapses the slot instead of leaving a blank box.
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (cancelled) return;
      const directive = String(event.effectiveDirective);
      if (!directive.startsWith("script-src") && !directive.startsWith("frame-src")) {
        return;
      }
      const blocked = String(event.blockedURI);
      try {
        if (!isExoclickProviderHost(new URL(blocked).hostname)) return;
      } catch {
        return;
      }
      fail();
    };
    document.addEventListener("securitypolicyviolation", onViolation);

    // 9. BOUNDED WAIT — an unfilled zone reserves space only briefly.
    timer = window.setTimeout(fail, EXOCLICK_READY_TIMEOUT_MS);

    return () => {
      cancelled = true;
      document.removeEventListener("securitypolicyviolation", onViolation);
      stop();
    };
  }, [placement, consent]);

  // Consent is part of what may be drawn, not only of what may load: an
  // undecided or declined visitor sees no reserved box and no caption.
  const consentSatisfied =
    !exoclickRequiresConsent() || exoclickConsentSatisfied(consent);
  if (phase === "unavailable" || !consentSatisfied) return null;

  return (
    <>
      {/* Flags the document as ad-carrying, so the next match entry is a
          document navigation and provider code cannot follow the player onto a
          board (lib/matchNavigation.ts). */}
      <AdCodeMarker />
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.2em] text-[#9dd8ff]/50">
        Advertisement
      </span>
      <div
        ref={hostRef}
        id={exoclickContainerId(placement)}
        data-grynd-exoclick={phase}
        role="group"
        aria-label="Advertisement"
        className="mx-auto flex w-full items-center justify-center overflow-hidden"
        style={{
          maxWidth: exoclickContainerMaxWidth(placement),
          minHeight: exoclickReservedHeight(placement),
        }}
      />
    </>
  );
}
