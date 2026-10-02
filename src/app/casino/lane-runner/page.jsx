import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

// Next.js replaces the layout's `openGraph`/`twitter` block wholesale rather
// than deep-merging it, so every field the card needs is restated here.
// See scripts/audit-social-metadata.mjs.
const title = "Lane Rush Duel | GRYND";
const description =
  "Play Lane Rush Duel on GRYND. Race a rival across the same 10-row bridge — every row hides one bad tile. A safe step keeps your turn; one wrong step sends you back to Row 1. First across wins.";
const image = ogImageUrl("/images/og/lane-runner.jpg");

export const metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: ogImageUrl("/casino/lane-runner"),
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [
      { url: image, width: 1200, height: 630, alt: "Lane Rush Duel on GRYND" },
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
