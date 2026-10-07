import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
const title = "Memory Grid | GRYND";
const description = "Play Memory Grid on GRYND. Stake tokens and race another player on a shared 4×4 grid. Flip two cards to match pairs, winner takes 1.9×.";
const image = ogImageUrl("/images/og/memory-grid.jpg");

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
  alternates: { canonical: "/games/memory-grid/play" },
  robots: { index: false, follow: true },
  openGraph: {
    title,
    description,
    url: ogImageUrl("/games/memory-grid/play"),
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
