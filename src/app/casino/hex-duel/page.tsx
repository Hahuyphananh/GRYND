import type { Metadata } from "next";
import PageClient from "./PageClient";
import { ogImageUrl } from "../../../lib/ogImages";

const title = "Hex Duel | GRYND";
const description = "Play Hex Duel on GRYND. Strategic hex-grid territory conquest. Capture tiles, outmaneuver your opponent and dominate the board.";
const image = ogImageUrl("/images/og-banner.png");

// This page is the AUTHENTICATED game application, served at
// /games/<slug>/play (next.config.js rewrites that path to this /casino/<slug>
// route; bare /casino/<slug> 308-redirects to the public landing page).
//
// The PUBLIC, indexable page for this game is /games/<slug>. This lobby is
// therefore noindex: it is a client-side application with almost no crawlable
// text, so letting it compete with the landing page would only split the two
// across the same query. The `canonical` below still names this page's own URL,
// so a direct link to the lobby is never consolidated into the landing page.
export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/games/hex-duel/play" },
  robots: { index: false, follow: true },
  openGraph: {
    title,
    description,
    url: ogImageUrl("/games/hex-duel/play"),
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [{ url: image, width: 1200, height: 630, alt: title }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [image],
  },
};


export default function Page() {
  return <PageClient />;
}
