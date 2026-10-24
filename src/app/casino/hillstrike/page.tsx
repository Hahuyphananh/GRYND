import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";
import MonetagScript from "../../../components/MonetagScript";
import { ogImageUrl } from "../../../lib/ogImages";

const title = "Hillstrike | GRYND";
const description =
  "Play Hillstrike on GRYND — a free 1v1 artillery duel. Three lives each, mirrored battlefields, and every shot resolved by the server. No tokens at stake.";
const image = ogImageUrl("/images/og-banner.png");

// This page is the AUTHENTICATED lobby, served at /games/hillstrike/play
// (next.config.js rewrites /games/:slug/play to /casino/:slug).
//
// Like every other game lobby it is noindex: it is a client-side application with
// almost no crawlable text. The free practice board lives one segment deeper, at
// /casino/hillstrike/play-ai, and needs no account at all.
export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/games/hillstrike/play" },
  robots: { index: false, follow: true },
  openGraph: {
    title,
    description,
    url: ogImageUrl("/games/hillstrike/play"),
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
