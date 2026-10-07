import "./globals.css";
import { headers } from "next/headers";
import { Providers } from "./providers";
import ClerkSafeChatWidget from "../components/ClerkSafeChatWidget";
import CookieConsentBanner from "../components/CookieConsentBanner";
import ConsentModeDefault from "../components/ConsentModeDefault";
import CmpConsentBridge from "../components/CmpConsentBridge";
import GoogleAnalytics from "../components/GoogleAnalytics";
import { countryFromHeaders, requiresGoogleCmp } from "../lib/consentRegions";
import { ORGANIZATION_ID, buildWebsiteJsonLd } from "../lib/reviewJsonLd";
import DisableInspect from "../components/DisableInspect";
import CsrfFetchGuard from "../components/CsrfFetchGuard";
import SplashScreen from "../components/SplashScreen";
import { ToastProvider } from "../components/toast/ToastProvider";
import { ogImageUrl, SITE_URL } from "../lib/ogImages";

export const dynamic = "force-dynamic";

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: "GRYND — Competitive PvP Skill Gaming",
  description:
    "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
  // Explicit icon metadata so the browser tab uses our smalllogo.
  // (Next.js also auto-generates a <link rel="icon"> from
  // src/app/icon.png, but listing it here keeps the intent obvious
  // for future maintainers and covers browsers that respect the
  // metadata.icons field before scanning convention paths.)
  icons: {
    icon: [
      { url: "/icon.png", type: "image/png" },
      { url: "/images/smalllogo.png", type: "image/png" },
    ],
    apple: "/icon-192.png",
  },
  // Rich preview cards for social platforms / chat apps (Discord, WhatsApp,
  // Slack, Facebook, LinkedIn, X...). The default image is the 1200×630 brand
  // banner built from our logo (see scripts/generate-og-banner.mjs) so every
  // shared link shows a filled, on-brand card instead of a blank one;
  // individual game pages override the image with their own screenshot art.
  // og:url must be the canonical PAGE url — not the image URL — or social
  // crawlers record the image path as the shared link.
  // NOTE: deliberately NO root-level `alternates.canonical` and no
  // `openGraph.url`.
  //
  // Next.js merges metadata parent → child, but it replaces the `alternates`
  // and `openGraph` objects wholesale rather than deep-merging them. A root
  // `canonical: "/"` was therefore inherited by every page that did not set
  // its own, so each game page told Google "my canonical URL is the homepage"
  // and Google consolidated the whole site into one indexed page.
  //
  // Both fields are intentionally page-owned now. Every public page declares
  // its own canonical (via `alternates.canonical`) and its own `openGraph.url`.
  openGraph: {
    title: "GRYND — Competitive PvP Skill Gaming",
    description:
      "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: ogImageUrl("/images/og-banner.png"),
        width: 1200,
        height: 630,
        alt: "GRYND — Competitive PvP Skill Gaming",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "GRYND — Competitive PvP Skill Gaming",
    description:
      "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
    images: [ogImageUrl("/images/og-banner.png")],
  },
};
// Minimal, factual Organization structured data — name + URL only. No
// ratings, reviews, or aggregate claims that the platform can't back. (The
// player rating lives on the pages that own the reviews, built from the
// approved rows — see src/lib/reviewJsonLd.ts.)
//
// `@id` is what lets other blocks reference this node: the WebSite block below
// names it as publisher, and the application node on / and /reviews names it as
// publisher too, so a crawler reads one linked graph instead of three
// unrelated claims.
export const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": ORGANIZATION_ID,
  name: "GRYND",
  url: `${SITE_URL}/`,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Which consent prompt this visitor is allowed to see. Google requires its
  // own certified CMP for the EEA, the UK and Switzerland, and everyone else
  // keeps our banner — running both would be two prompts over two consent
  // records that disagree. The country arrives on the request headers (see
  // lib/consentRegions.ts); it is "" in local dev, i.e. "not the EU".
  const requestHeaders = await headers();
  const requiresCmp = requiresGoogleCmp(countryFromHeaders(requestHeaders));

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Declared first so it parses before any Google tag can run. React
            hoists `async` scripts (the AdSense tag) above it in the emitted
            HTML, which is exactly what wait_for_update covers — see the
            component's note. */}
        <ConsentModeDefault />
        <link rel="manifest" href="/manifest.json" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        {/* The site itself, so an answer engine knows the name, the canonical
            URL and who publishes it. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(buildWebsiteJsonLd()) }}
        />
        <link rel="icon" type="image/png" href="/icon.png" />
        <link rel="icon" type="image/png" href="/images/smalllogo.png" />
        <link rel="apple-touch-icon" type="image/png" href="/icon-192.png" />
        <meta name="theme-color" content="#000000" />
      </head>

      <body className="antialiased transition-colors duration-300 bg-[#030817] text-[#d8fbff]">
        {/* Google Analytics 4 (gtag.js) — on every page, from this one place.
            Consent-gated: it only loads after the visitor accepts the cookie
            banner (see the component for why). */}
        <GoogleAnalytics />

        {/* Skip to content — accessibility */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[9999] focus:rounded-lg focus:border focus:border-[#00e5ff] focus:bg-[#030817] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#00e5ff] focus:shadow-[0_0_20px_rgba(0,229,255,0.4)] focus:outline-none"
        >
          Skip to main content
        </a>

        {/* SPLASH SCREEN MUST GO HERE */}
        <SplashScreen />

        <Providers>
          {/* Global branded toast system (UX plan P0-1) — wraps everything
              so any page/component can call useToast(). Toasts portal to
              <body>, so the provider's position in the tree only matters
              for context propagation. */}
          <ToastProvider>
            <CsrfFetchGuard />
            <DisableInspect />
            <main id="main-content" className="pt-[68px] sm:pt-16">{children}</main>
            <ClerkSafeChatWidget />
            {/* Mirrors Google's CMP decision into the local consent record so
                the existing gating (GA, PostHog, Sentry) keeps working for
                EEA/UK/Swiss visitors. No-op elsewhere. */}
            <CmpConsentBridge enabled={requiresCmp} />
            <CookieConsentBanner suppressForCmp={requiresCmp} />
          </ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
