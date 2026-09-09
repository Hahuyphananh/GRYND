import "./globals.css";
import { Providers } from "./providers";
import ClerkSafeChatWidget from "../components/ClerkSafeChatWidget";
import CookieConsentBanner from "../components/CookieConsentBanner";
import DisableInspect from "../components/DisableInspect";
import CsrfFetchGuard from "../components/CsrfFetchGuard";
import TawkProvider from "../components/TawkProvider";
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
  // Slack, Facebook, LinkedIn...). The default banner applies to every page;
  // individual game pages override the image with their own screenshot art.
  // og:url must be the canonical PAGE url — not the image URL — or social
  // crawlers record the image path as the shared link.
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "GRYND — Competitive PvP Skill Gaming",
    description:
      "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
    url: SITE_URL + "/",
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: ogImageUrl("/og-image.png"),
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
    images: [ogImageUrl("/og-image.png")],
  },
};
// Minimal, factual Organization structured data — name + URL only. No
// ratings, reviews, or aggregate claims that the platform can't back.
export const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "GRYND",
  url: `${SITE_URL}/`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <link rel="icon" type="image/png" href="/icon.png" />
        <link rel="icon" type="image/png" href="/images/smalllogo.png" />
        <link rel="apple-touch-icon" type="image/png" href="/icon-192.png" />
        <meta name="theme-color" content="#000000" />
      </head>

      <body className="antialiased transition-colors duration-300 bg-[#030817] text-[#d8fbff]">
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
            <TawkProvider />
            <main id="main-content" className="pt-[68px] sm:pt-16">{children}</main>
            <ClerkSafeChatWidget />
            <CookieConsentBanner />
          </ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
