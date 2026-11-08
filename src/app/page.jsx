import PageClient from "./PageClient";
import AdSenseScript from "../components/AdSenseScript";
import AdSlot from "../components/AdSlot";
import HilltopBanner from "../components/ads/HilltopBanner";
import { ogImageUrl, SITE_URL } from "../lib/ogImages";
import { getReviewAggregate } from "../lib/reviews";
import { buildAppJsonLd } from "../lib/reviewJsonLd";

export const metadata = {
  title: "GRYND — The competitive home of Solitaire",
  description:
    "Play classic Klondike Solitaire one-on-one against real opponents. The same deal, a free ranked ladder, trophies and match history.",
  alternates: {
    canonical: `${SITE_URL}/`,
  },
  openGraph: {
    title: "GRYND — The competitive home of Solitaire",
    description:
      "Play classic Klondike Solitaire one-on-one against real opponents. The same deal, a free ranked ladder, trophies and match history.",
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
        alt: "GRYND — The competitive home of Solitaire",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "GRYND — The competitive home of Solitaire",
    description:
      "Play classic Klondike Solitaire one-on-one against real opponents. The same deal, a free ranked ladder, trophies and match history.",
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
      <PageClient
        adSlot={<AdSlot placement="home" />}
        // A second, independent provider. It carries its own server-side
        // entitlement check and its own placement allow-list, and it renders
        // inside the page's content column — never over the hero or a card.
        hilltopSlot={<HilltopBanner placement="home" />}
      />
    </>
  );
}