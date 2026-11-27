import PageClient from "./PageClient";
import JsonLd from "../components/seo/JsonLd";
import AdSenseScript from "../components/AdSenseScript";
import AdSlot from "../components/AdSlot";
import BannerSlot from "../components/ads/BannerSlot";
import SocialProof from "../components/home/SocialProof";
import { ogImageUrl, SITE_URL } from "../lib/ogImages";
import { getReviewAggregate } from "../lib/reviews";
import { buildAppJsonLd } from "../lib/reviewJsonLd";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../lib/seo";

export const metadata = pageMetadata({
  title: "GRYND — The competitive home of Solitaire",
  description: "Play classic Klondike Solitaire one-on-one against real opponents. The same deal, a free ranked ladder, trophies and match history.",
  path: "/",
  image: DEFAULT_OG_IMAGE,
  other: { "trustpilot-one-time-domain-verification-id": "98b96218-f16a-408f-b1f0-5a8efcb052e2" },
});

export default async function Page() {
  // The player rating, from the approved reviews only, cached for a few
  // minutes and failing soft (null → no markup) so the home page can never be
  // taken down by the reviews table. AI answer engines weight ratings heavily
  // when deciding what to recommend, and this is the page they read first.
  const reviewStats = await getReviewAggregate();
  const ratingJsonLd = buildAppJsonLd({ stats: reviewStats });

  return (
    <>
      {/* Same entity (@id) as the reviews page, so the two never look like
          competing claims. JsonLd escapes "<" so no review text can close the
          script tag. */}
      <JsonLd data={ratingJsonLd} />
      {/* Ad capability on the home page (a browsing surface, never gameplay).
          The loader and the slot both decide server-side whether this viewer
          gets ads at all: GRYND PRO members receive neither. */}
      <AdSenseScript />
      {/* Passed as a child so the slot lands in the page's own content column,
          above the footer — never over the hero, nav or a control. */}
      <PageClient
        adSlot={<AdSlot placement="home" />}
        // The Trustpilot Review Collector TrustBox and the Product Hunt badge.
        // Passed in as a child, like the ad slots, so it is rendered on the
        // server and lands inside the page's content column above the footer.
        socialProof={<SocialProof />}
        // ONE banner surface for the whole page. It resolves the configured
        // provider priority, applies switch/configuration/placement/
        // entitlement gates on the server, and lets the browser try one
        // provider at a time until one fills.
        bannerSlot={<BannerSlot placement="home" />}
      />
    </>
  );
}