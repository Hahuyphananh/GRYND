import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";
import MonetagScript from "../../../components/MonetagScript";
import { ogImageUrl } from "../../../lib/ogImages";

const title = "Barrier Blitz | GRYND";
const description =
  "Play Barrier Blitz on GRYND — a free 1v1 race on a 9x9 board. Ten barriers each, one action per turn, and the first pawn to cross to the far side wins. No tokens at stake.";
const image = ogImageUrl("/images/og-banner.png");

// This page is the AUTHENTICATED lobby, served at /games/barrier-blitz/play
// (next.config.js rewrites that path to this /casino/barrier-blitz route).
//
// Like every other game lobby it is noindex: it is a client-side application
// with almost no crawlable text. The free practice board lives one segment
// deeper, at /casino/barrier-blitz/play-ai, and needs no account at all.
export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/games/barrier-blitz/play" },
  robots: { index: false, follow: true },
  openGraph: {
    title,
    description,
    url: ogImageUrl("/games/barrier-blitz/play"),
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
      <MonetagScript />
      <PageClient />
    </>
  );
}
