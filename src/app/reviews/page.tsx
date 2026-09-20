import type { Metadata } from "next";
import Link from "next/link";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import ReviewWall from "../../components/reviews/ReviewWall";
import { getApprovedReviews, getReviewStats, type PublicReview, type ReviewStats } from "../../lib/reviews";
import { buildAppJsonLd } from "../../lib/reviewJsonLd";

export const metadata: Metadata = {
  title: "Player Reviews | GRYND",
  description:
    "See what players say about GRYND. Real reviews from verified players of our skill-based games.",
  alternates: {
    canonical: "/reviews",
  },
};

/**
 * The review data is fetched on the SERVER and handed to the wall as initial
 * state, so the reviews, the star distribution and the rating totals are in the
 * HTML that a crawler (or an AI answer engine) receives without running any
 * JavaScript. It used to be fetched in the client only, which meant the page a
 * machine saw was an empty shell.
 *
 * If the reviews table is unreachable we fall back to `null` and let the wall
 * fetch on the client exactly as it used to — a database problem degrades this
 * page, it doesn't 500 it.
 */
async function loadReviews(limit: number): Promise<{ reviews: PublicReview[]; stats: ReviewStats } | null> {
  try {
    const [reviews, stats] = await Promise.all([getApprovedReviews(limit), getReviewStats()]);
    return { reviews, stats };
  } catch (err) {
    console.error("[reviews] server-side review load failed:", err);
    return null;
  }
}

export default async function ReviewsPage() {
  const limit = 12;
  const data = await loadReviews(limit);
  const reviewJsonLd = buildAppJsonLd({ stats: data?.stats, reviews: data?.reviews ?? [] });

  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />
      <NavigationBar currentPath="/reviews" />
      <div className="relative z-10 mx-auto max-w-6xl px-4 pb-16 pt-24">
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-lg border border-[#00e5ff]/30 bg-[#040d24]/70 px-4 py-2 text-sm font-semibold text-[#c9f7ff]/80 transition hover:border-[#00e5ff]/60 hover:bg-[#00e5ff]/10 hover:text-white"
          >
            <span aria-hidden="true">←</span>
            Back to Home
          </Link>
        </div>
        <h1 className="mb-2 text-center text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#f5ff3b]">
          Player Reviews
        </h1>
        <p className="mb-12 text-center text-lg text-[#c9f7ff]/80">
          Real ratings from verified players.
        </p>

        {/* AggregateRating + the published reviews, built from the approved
            rows fetched above — never a hardcoded score. Omitted entirely when
            there is nothing real to report. */}
        {reviewJsonLd && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(reviewJsonLd) }}
          />
        )}

        <ReviewWall
          limit={limit}
          initialReviews={data?.reviews ?? null}
          initialStats={data?.stats ?? null}
        />
      </div>
      <Footer />
    </div>
  );
}
