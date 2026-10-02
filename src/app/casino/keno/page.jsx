import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
const title = "Keno | GRYND";
const description =
  "Play 1v1 Keno on GRYND. A survival duel: 3 lives each, one lit tile and a window that tightens with every claim. Tap faster than your rival or lose a life.";
const image = ogImageUrl("/images/og/keno.jpg");

export const metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: ogImageUrl("/casino/keno"),
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [{ url: image, width: 1200, height: 630, alt: "Keno on GRYND" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [image],
  },
};

export default function Page() {
  return <PageClient />;
}
