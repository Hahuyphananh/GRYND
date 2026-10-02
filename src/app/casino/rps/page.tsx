import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
const title = "Rock-Paper-Scissors | GRYND";
const description =
  "Play Rock-Paper-Scissors on GRYND. Best-of-7 mind games against a live opponent, or play the AI for free.";
const image = ogImageUrl("/images/og/rps.jpg");

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: ogImageUrl("/casino/rps"),
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [
      { url: image, width: 1200, height: 630, alt: "Rock-Paper-Scissors on GRYND" },
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
