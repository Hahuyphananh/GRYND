import PageClient from "./PageClient";
import AdSenseScript from "../components/AdSenseScript";
import AdSlot from "../components/AdSlot";
import HomeExplainer from "../components/home/HomeExplainer";
import {
  HOMEPAGE_FEATURED_SLUGS,
  gameIndexFor,
} from "../lib/gameLandingPages";
import { ogImageUrl, SITE_URL } from "../lib/ogImages";
import { getReviewAggregate } from "../lib/reviews";
import { buildAppJsonLd } from "../lib/reviewJsonLd";

export const metadata = {
  title: "GRYND — Competitive PvP Skill Gaming",
  description:
    "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
  alternates: {
    canonical: `${SITE_URL}/`,
  },
  openGraph: {
    title: "GRYND — Competitive PvP Skill Gaming",
    description:
      "Challenge real players in competitive games, climb the leaderboard, and prove your skill.",
    url: `${SITE_URL}/`,
    siteName: "GRYND",
    locale: "en_US",
    type: "website",
    // The 1200×630 brand banner (scripts/generate-og-banner.mjs), so a shared
    // grynd link always renders a filled card with our mark.
    images: [
      {
        url: ogImageUrl("/images/og-banner.png"),
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
    images: [ogImageUrl("/images/og-banner.png")],
  },
};

export default async function Page() {
  // The player rating, from the approved reviews only, cached for a few
  // minutes and failing soft (null → no markup) so the home page can never be
  // taken down by the reviews table. AI answer engines weight ratings heavily
  // when deciding what to recommend, and this is the page they read first.
  const reviewStats = await getReviewAggregate();
  const ratingJsonLd = buildAppJsonLd({ stats: reviewStats });

  // The site's most popular games, as real links to their public pages
  // (/games/<slug>). Resolved from the game catalogue on the SERVER and handed
  // to the client page as plain data — the catalogue's entries carry every
  // game's rules, tips and FAQ prose, which has no business in the browser
  // bundle just to render a handful of anchors. A game can only appear here by
  // existing (see HOMEPAGE_FEATURED_SLUGS), so an unknown slug is dropped
  // rather than rendered as a link to a 404.
  const popularGames = gameIndexFor(HOMEPAGE_FEATURED_SLUGS);

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
      {/* `explainerSlot` is the server-rendered block that explains what GRYND
          is, what the games test, how ranked play and progression work, and how
          to start — so the whole explanation is in the page's HTML. */}
      <PageClient
        adSlot={<AdSlot placement="home" />}
        popularGames={popularGames}
        explainerSlot={<HomeExplainer />}
      />
    </>
  );
}