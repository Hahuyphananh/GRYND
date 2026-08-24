import type { Metadata } from "next";
import Link from "next/link";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import ReviewWall from "../../components/reviews/ReviewWall";

export const metadata: Metadata = {
  title: "Player Reviews | GRYND",
  description:
    "See what players say about GRYND. Real reviews from verified players of our skill-based games.",
};

export default function ReviewsPage() {
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
        <ReviewWall limit={12} />
      </div>
      <Footer />
    </div>
  );
}
