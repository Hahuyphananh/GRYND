import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

// The AUTHENTICATED game application for LAST RUN. It is served at
// /games/last-run/play (next.config.js rewrites that path to this /casino/last-run
// route; the bare /games/last-run URL is the PUBLIC landing page).
//
// This lobby is therefore noindex, exactly like every other game lobby: it is a
// client-side application with almost no crawlable text, and the indexable page
// for this game is /games/last-run. Its canonical still names its own play URL,
// so a direct link to the lobby is never consolidated into the landing page.
const title = "LAST RUN | GRYND";
const description =
  "Play LAST RUN, GRYND's 1v1 endless-runner duel. Both runners face the same server-seeded course — jump crates, duck beams and survive the accelerating track; the first crash loses.";
const image = ogImageUrl("/images/og/last-run.svg");

export const metadata = {
  title,
  description,
  alternates: { canonical: "/games/last-run/play" },
  robots: { index: false, follow: true },
  openGraph: {
    title,
    description,
    url: ogImageUrl("/games/last-run/play"),
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

export default async function Page({ searchParams }) {
  const params = await searchParams;
  return (
    <>
      <AdSenseScript />
      <PageClient autoQueue={params?.queue === "1"} />
    </>
  );
}
