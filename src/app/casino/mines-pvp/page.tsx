import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
const title = "Mines Duel | GRYND";
const description =
  "Play Mines Duel on GRYND. Face another player on a shared 10×10 board with 10 mines — every safe reveal and its clue is public, flags are private. Step on a mine and you lose instantly; confirm every mine and you win.";
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
