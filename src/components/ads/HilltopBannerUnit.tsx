"use client";

// src/components/ads/HilltopBannerUnit.tsx
//
// The browser-side half of the HilltopAds banner. It runs the provider's snippet
// AT MOST ONCE per browser session, and only ever inside a container it owns.
//
// ── WHY IT INJECTS IMPERATIVELY ───────────────────────────────────────────
//
// The provider's snippet is an inline `<script>`. React does not execute inline
// scripts that appear on a client-side navigation, and a declaratively rendered
// `async` script is hoisted into `<head>` — which is exactly the case where the
// provider falls back to appending an absolutely-positioned, max-z-index element
// to `<body>` (an overlay over the page). Appending the snippet element
// ourselves, INSIDE our container, makes it execute and makes the provider's own
// insertion rule (insert next to its script tag) land the banner in that
// container. Containment is therefore structural, not a provider setting.
//
// ── WHAT IT GUARANTEES ────────────────────────────────────────────────────
//
//   * ONCE PER SESSION. A DOM sentinel plus a sessionStorage key cover
//     re-renders, React's development double-effect and client-side navigation.
//     The provider's tag is never loaded a second time.
//   * NEVER OFF ITS OWN PAGE. The pathname must be exactly the route this
//     placement belongs to, so a lobby, a match, a board or an alias refuses to
//     inject even if a page were mis-wired. The match router's URL classifier
//     is checked too, as a second, independent belt.
//   * NO POPUPS, NO REDIRECTS. Nothing here calls window.open, navigates, or
//     writes a link; the provider's click-through is not ours to trigger.
//   * FAILURE IS SILENT AND HONEST. A blocked, offline or unfilled request
//     collapses the reserved area after a bounded wait, and a frame the page's
//     CSP refuses collapses immediately when the violation names it. No
//     placeholder, no fake creative, no retry loop.
//   * NO UNKNOWN UNMOUNT. Only our own observer and timer are released. The
//     provider's nodes live inside this component's own container, which React
//     removes with it — this code never deletes an element it cannot prove it
//     owns (nothing outside the container is touched).
//
// ── RESERVED SPACE ────────────────────────────────────────────────────────
//
// The provider does support a contained banner (its script's own parent is a
// valid target), so the container reserves a 300×250 area while the creative
// loads and then keeps whatever height the creative needs — an arriving ad never
// shifts the page around it.

import { useEffect, useRef, useState } from "react";

import AdCodeMarker from "../AdCodeMarker";
import { isMatchHref } from "../../lib/matchNavigation";
import {
  HILLTOP_CONTAINER_ID,
  HILLTOP_PROVIDER_HOST,
  HILLTOP_READY_TIMEOUT_MS,
  HILLTOP_RESERVED_HEIGHT_PX,
  HILLTOP_SNIPPET_ATTRIBUTE,
  hilltopBannerLoadedThisSession,
  hilltopBannerScriptUrl,
  hilltopBannerSessionStorage,
  hilltopBannerSnippet,
  hilltopRouteMatchesPlacement,
  markHilltopBannerLoaded,
  type HilltopPlacement,
} from "../../lib/hilltop/config";

type Phase = "idle" | "loading" | "filled" | "unavailable" | "already";

/** The creative is a non-script element; the provider's tag is a `<script>`. */
function bannerPresent(host: HTMLElement): boolean {
  return Array.from(host.children).some((child) => child.tagName !== "SCRIPT");
}

export default function HilltopBannerUnit({ placement }: { placement: HilltopPlacement }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    // 1. ROUTE GUARD — the page viewing us must be the page this placement
    //    belongs to. This is what makes "the four approved pages, and nothing
    //    else" enforceable in the browser instead of a promise: a lobby, a
    //    match, a board or an alias is in no placement's route list, so it
    //    injects nothing at all.
    if (!hilltopRouteMatchesPlacement(window.location.pathname, placement)) {
      setPhase("unavailable");
      return undefined;
    }

    // 1b. GAMEPLAY GUARD — a second, independent belt: the same URL classifier
    //     the match router uses, so a match URL can never reach the injection
    //     below even if a route table were ever wrong.
    if (isMatchHref(`${window.location.pathname}${window.location.search}`)) {
      setPhase("unavailable");
      return undefined;
    }

    // 2. CONFIGURATION. Null means the provider URL override was malformed.
    const url = hilltopBannerScriptUrl();
    if (!url) {
      setPhase("unavailable");
      return undefined;
    }

    // 3. ONCE PER SESSION. `alreadyInHost` covers a remount in the same
    //    container (React StrictMode re-runs effects); the session key covers a
    //    reload or a client-side navigation within this tab.
    const alreadyInHost =
      host.querySelector(`script[${HILLTOP_SNIPPET_ATTRIBUTE}]`) !== null;
    const storage = hilltopBannerSessionStorage();

    if (!alreadyInHost && hilltopBannerLoadedThisSession(storage)) {
      setPhase("already");
      return undefined;
    }

    if (!alreadyInHost) {
      markHilltopBannerLoaded(storage);

      const snippet = document.createElement("script");
      snippet.setAttribute(HILLTOP_SNIPPET_ATTRIBUTE, "1");
      // THE PROVIDER'S SNIPPET, UNCHANGED: same URL, same `({})` settings, same
      // async flag, same referrer policy, same insert-before-itself order.
      // Appended inside our container so the provider's own tag (and therefore
      // the banner it inserts beside it) stays here.
      snippet.text = hilltopBannerSnippet(url);
      host.appendChild(snippet);
    }

    setPhase("loading");
    if (bannerPresent(host)) {
      setPhase("filled");
      return undefined;
    }

    // 4. READY / FAILURE. The provider injects asynchronously; the observer
    //    detects the creative, the bounded timer keeps a blocked or unfilled
    //    request from leaving a reserved hole on the page.
    let cancelled = false;

    const observer = new MutationObserver(() => {
      if (cancelled) return;
      if (bannerPresent(host)) {
        setPhase("filled");
        observer.disconnect();
      }
    });
    observer.observe(host, { childList: true, subtree: true });

    // 5. POLICY-BLOCKED FRAME. The creative renders in a cross-origin iframe, so
    //    a `frame-src` that does not name the provider host means the ad can
    //    never paint — but the element still exists, which would otherwise look
    //    "filled" and leave a permanently blank reserved box on the page. The
    //    violation event names what was blocked, so this collapses instead.
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (cancelled) return;
      if (!String(event.effectiveDirective).startsWith("frame-src")) return;
      if (!String(event.blockedURI).includes(HILLTOP_PROVIDER_HOST)) return;
      setPhase("unavailable");
      observer.disconnect();
    };
    document.addEventListener("securitypolicyviolation", onViolation);

    const timer = window.setTimeout(() => {
      if (cancelled || bannerPresent(host)) return;
      setPhase("unavailable");
      observer.disconnect();
    }, HILLTOP_READY_TIMEOUT_MS);

    return () => {
      cancelled = true;
      document.removeEventListener("securitypolicyviolation", onViolation);
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [placement]);

  // Already loaded earlier in this session: the provider's single instance is
  // gone with the page it lived in, so render nothing rather than an empty box.
  if (phase === "already") return null;

  // Reserved from the FIRST render — including the one the server produces — so
  // the block that arrives after hydration cannot push the page down. It
  // collapses only when the ad will never appear (blocked, unfilled, refused).
  const reserved = phase !== "unavailable";

  return (
    <>
      {/* Marks the document as ad-carrying, so the next match entry is a
          document navigation and this tag (and any creative it injected) cannot
          follow the player onto a board. */}
      <AdCodeMarker />
      {/* Rendered with the ad, never without it: this caption is what labels
          the reserved area, so it must not survive the area's collapse. */}
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9dd8ff]/50">
        Advertisement
      </span>
      <div
        ref={hostRef}
        id={HILLTOP_CONTAINER_ID}
        data-grynd-hilltop={phase}
        role="group"
        aria-label="Advertisement"
        className={`mx-auto flex w-full max-w-[336px] items-center justify-center overflow-hidden ${
          reserved ? "" : "hidden"
        }`.trim()}
        style={reserved ? { minHeight: HILLTOP_RESERVED_HEIGHT_PX } : undefined}
      />
    </>
  );
}
