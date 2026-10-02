import { ogImageUrl } from "../../../../../lib/ogImages";
import PageClient from "./PageClient";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
//
// The URL points at the Uno lobby rather than this match: a live game id is
// transient, so the lobby is the stable canonical target for a shared link.
const title = "Uno | GRYND";
const description =
  "Play Uno on GRYND. Match colors and numbers in a fast strategic card game against the AI or other players.";
const image = ogImageUrl("/images/og/neon-flush.jpg");

export const metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: ogImageUrl("/casino/uno"),
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [{ url: image, width: 1200, height: 630, alt: "Uno on GRYND" }],
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
