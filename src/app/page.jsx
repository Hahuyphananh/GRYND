import PageClient from "./PageClient";
import AdSenseScript from "../components/AdSenseScript";
import AdSlot from "../components/AdSlot";
import { ogImageUrl, SITE_URL } from "../lib/ogImages";
import { getReviewAggregate } from "../lib/reviews";
import { buildAppJsonLd } from "../lib/reviewJsonLd";

export const metadata = {
  title: "GRYND — Competitive PvP Skill Gaming",
  description:
    "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "GRYND — Competitive PvP Skill Gaming",
    description:
      "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
    url: `${SITE_URL}/`,
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: ogImageUrl("/og-image.png"),
        width: 1200,
        height: 630,
        alt: "GRYND — Competitive PvP Skill Gaming",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "GRYND — Competitive PvP Skill Gaming",
    description:
      "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
    images: [ogImageUrl("/og-image.png")],
  },
};

export default async function Page() {
  // The player rating, from the approved reviews only, cached for a few
  // minutes and failing soft (null → no markup) so the home page can never be
  // taken down by the reviews table. AI answer engines weight ratings heavily
  // when deciding what to recommend, and this is the page they read first.
  const reviewStats = await getReviewAggregate();
  const ratingJsonLd = buildAppJsonLd({ stats: reviewStats });

  return (
    <>
      {ratingJsonLd && (
        <script
          type="application/ld+json"
          // Same entity (@id) as the reviews page, so the two never look like
          // competing claims.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ratingJsonLd) }}
        />
      )}
      {/* Ad capability on the home page (a browsing surface, never gameplay).
          The loader and the slot both decide server-side whether this viewer
          gets ads at all: GRYND PRO members receive neither. */}
      <AdSenseScript />
      {/* Passed as a child so the slot lands in the page's own content column,
          above the footer — never over the hero, nav or a control. */}
      <PageClient adSlot={<AdSlot placement="home" />} />
    </>
  );
}