"use client";

// src/components/SiteChrome.tsx
//
// ONE decision: is this page part of the SITE, or is it the portal surface?
//
// The root layout is a single root for every route (Next only allows a second
// layout tree by moving every existing route into a route group, which is not a
// change worth making for four pages). So the chrome that must disappear on the
// portal surface is gated HERE, on the pathname, exactly once:
//
//   /play/<gameKey>  → the game fills the viewport. No navbar, no chat bubble,
//                      no quest badge, no mascot, no splash overlay, no cookie
//                      banner, no skip link, no top padding for a navbar that is
//                      not there, no site analytics.
//   everything else  → byte-for-byte the tree the layout used to render.
//
// The client-side pathname check is deliberate. `usePathname()` is resolved
// during the server render of a client component too, so the first paint already
// has the right chrome and hydration agrees with it — the page never renders the
// navbar for a frame and then removes it.
//
// `NavigationBar` mounts per page (PvpLobby renders it), so it has its own guard
// for the same path; this file cannot suppress a component a game renders itself.

import { usePathname } from "next/navigation";

import ClerkSafeChatWidget from "./ClerkSafeChatWidget";
import CookieConsentBanner from "./CookieConsentBanner";
import CmpConsentBridge from "./CmpConsentBridge";
import GoogleAnalytics from "./GoogleAnalytics";
import SplashScreen from "./SplashScreen";
import GlitchProvider from "./mascot/GlitchProvider";
import { isPortalPlayPath } from "../lib/portal/framing";

export default function SiteChrome({
  children,
  requiresCmp,
}: {
  children: React.ReactNode;
  /** Google's certified CMP country check, resolved on the server layout. */
  requiresCmp: boolean;
}) {
  const pathname = usePathname();

  // ── Portal surface ──────────────────────────────────────────────────────
  // The game is the whole page. `<main>` stays (it is the landmark the app and
  // its a11y tooling expect) but takes no navbar offset, because a portal frame
  // has no navbar: on a 360×640 phone that padding was 68px of dead space above
  // the board.
  if (isPortalPlayPath(pathname)) {
    return (
      <main id="main-content" className="min-h-dvh bg-[#000d1a]">
        {children}
      </main>
    );
  }

  // ── The site ────────────────────────────────────────────────────────────
  return (
    <>
      {/* Google Analytics 4 — consent-gated, and never on the portal surface:
          a portal frame must not carry our tracking, and there is no consent
          banner there to earn the consent it needs. */}
      <GoogleAnalytics />

      {/* Skip to content — accessibility */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[9999] focus:rounded-lg focus:border focus:border-[#00e5ff] focus:bg-[#030817] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#00e5ff] focus:shadow-[0_0_20px_rgba(0,229,255,0.4)] focus:outline-none"
      >
        Skip to main content
      </a>

      {/* First-load brand moment. A portal visitor must land on the game, not
          on a 2.2s skeleton, so this is site-only. */}
      <SplashScreen />

      {/* The fixed navigation bar clears the status bar with its own
          `.safe-top` padding, so the page offset below adds the same inset —
          one source of truth (`--safe-top`), no double padding, and 0px
          everywhere the platform reports no inset. */}
      <main
        id="main-content"
        className="pt-[calc(68px_+_var(--safe-top))] sm:pt-[calc(4rem_+_var(--safe-top))]"
      >
        {children}
      </main>

      {/* GLITCH's floating layer — the ONLY mount of the mascot provider. Its
          own decisions (cadence, suppression, session limits) come from
          lib/mascot/glitchCadence.js; this only states that the layer exists.
          Inside ToastProvider so a toast always wins, and before the chat
          widget so bottom-left stays free. Renders nothing until something
          calls useGlitch().say(). Site-only: a mascot popping over a portal
          board is an uninvited interruption in someone else's product. */}
      <GlitchProvider />
      <ClerkSafeChatWidget />
      {/* Mirrors Google's CMP decision into the local consent record so the
          existing gating (GA, PostHog, Sentry) keeps working for EEA/UK/Swiss
          visitors. No-op elsewhere. */}
      <CmpConsentBridge enabled={requiresCmp} />
      <CookieConsentBanner suppressForCmp={requiresCmp} />
    </>
  );
}
