import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
const title = "Memory Grid | GRYND";
const description =
  "Play Memory Grid on GRYND. Stake tokens and race another player on a shared 4×4 grid. Flip two cards to match pairs, winner takes 1.9×.";
const image = ogImageUrl("/images/og/memory-grid.jpg");

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: ogImageUrl("/casino/memory-grid"),
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [
      { url: image, width: 1200, height: 630, alt: "Memory Grid on GRYND" },
    ],
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
