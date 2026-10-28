import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";
import { ogImageUrl } from "../../../lib/ogImages";

const title = "Dominoes | GRYND";
const description =
  "Play Dominoes on GRYND — a free, rated 1v1 block-dominoes duel. Seven tiles each, one shared chain, fifteen seconds a turn. Nothing is wagered.";
const image = ogImageUrl("/images/og-banner.png");

// This page is the AUTHENTICATED lobby, served at /games/dominoes/play
// (next.config.js rewrites that path to this /casino/dominoes route). The
// PUBLIC, indexable page for the game is /games/dominoes
// (src/app/games/[slug]/page.tsx), which is what this route is canonical to.
//
// Like every other game lobby it is noindex: it is a client-side application
// with almost no crawlable text.
export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/games/dominoes/play" },
  robots: { index: false, follow: true },
  openGraph: {
    title,
    description,
    url: ogImageUrl("/games/dominoes/play"),
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
