import type { Metadata } from "next";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
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
      <div className="relative z-10 mx-auto max-w-6xl px-4 py-16">
        <h1 className="mb-2 text-center text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#f5ff3b]">
          Player Reviews
        </h1>
        <p className="mb-12 text-center text-lg text-[#c9f7ff]/80">
          Real ratings from verified players.
        </p>
        <ReviewWall limit={12} />
      </div>
    </div>
  );
}
