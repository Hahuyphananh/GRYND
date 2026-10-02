import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
const title = "Chess | GRYND";
const description =
  "Play chess on GRYND. Challenge players in multiplayer chess matches or sharpen your skills against the AI.";
const image = ogImageUrl("/images/og/chess.jpg");

export const metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: ogImageUrl("/casino/chess"),
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [{ url: image, width: 1200, height: 630, alt: "Chess on GRYND" }],
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
