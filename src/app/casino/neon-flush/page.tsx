import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import NeonFlushPage from "../uno/page";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
const title = "Neon Flush | GRYND";
const description =
  "Play Neon Flush on GRYND. A fast strategic card game against the AI or other players.";
const image = ogImageUrl("/images/og/neon-flush.jpg");

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: ogImageUrl("/casino/neon-flush"),
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [{ url: image, width: 1200, height: 630, alt: "Neon Flush on GRYND" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [image],
  },
};

export default function Page() {
  return <NeonFlushPage />;
}
