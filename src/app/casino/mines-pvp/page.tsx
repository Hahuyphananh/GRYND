import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
const title = "Mines Duel | GRYND";
const description =
  "Play Mines Duel on GRYND. Race another player on your own 10×10 minefield — 10 mines, no turns, one shared 3-minute clock. Safe tiles +5, correct flags score the mine's value, mine hits −25, clearing your board +100. Highest score wins.";
const image = ogImageUrl("/images/og/mines.jpg");

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: ogImageUrl("/casino/mines-pvp"),
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [{ url: image, width: 1200, height: 630, alt: "Mines Duel on GRYND" }],
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
