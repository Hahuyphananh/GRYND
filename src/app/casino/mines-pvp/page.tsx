import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
const title = "Mines Duel | GRYND";
const description = "Play Mines Duel on GRYND. Race another player on your own 10×10 minefield — 10 mines, no turns, one shared 3-minute clock. Safe tiles +5, correct flags score the mine's value, mine hits −25, clearing your board +100. Highest score wins.";
const image = ogImageUrl("/images/og/mines.jpg");

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
  alternates: { canonical: "/games/mines-pvp/play" },
  robots: { index: false, follow: true },
  openGraph: {
    title,
    description,
    url: ogImageUrl("/games/mines-pvp/play"),
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
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
