// src/lib/featuredReview.ts
//
// THE TESTIMONIAL ON THE PAYWALL — one REAL, approved review.
//
// No quote, rating or name is ever written into this repo. The paywall may only
// repeat what a player actually published on the /reviews wall, which is the
// same moderated source (`getApprovedReviews` in lib/reviews.ts) the public wall
// and its structured data read. If there is no approved review with something
// worth quoting, there is no testimonial — the surface renders nothing rather
// than a plausible-looking fake.
//
// `pickFeaturedReview` is pure and shared: the /upgrade-pro page picks one on
// the server and passes it down, while the modal fetches the same public feed
// lazily (`fetchFeaturedReview`) the first time it opens. Both use this picker,
// so the page and the dialog can never quote different reviews.

/** The subset of a public review this module needs. */
export type ReviewLike = {
  rating?: number | null;
  title?: string | null;
  body?: string | null;
  username?: string | null;
};

/** What the paywall renders. */
export type ProTestimonial = {
  /** 1–5, exactly as the player rated GRYND. */
  rating: number;
  quote: string;
  /** Player name, or null when the account has none. */
  author: string | null;
};

/**
 * A quote has to say something: a bare "gg" or a one-word title reads as
 * filler and would make the offer look padded. Forty characters is the point
 * where a review states a reason.
 */
const MIN_QUOTE_LENGTH = 40;

/**
 * The best review to show, or null.
 *
 * "Best" is the highest rating, then the most to say (longest quote). Reviews
 * without a real quote are skipped — a 5-star row with no words is not social
 * proof, and the paywall must not imply it is.
 */
export function pickFeaturedReview(
  reviews: readonly ReviewLike[] | null | undefined,
): ProTestimonial | null {
  if (!Array.isArray(reviews)) return null;

  let best: ProTestimonial | null = null;
  for (const review of reviews) {
    const rating = Math.round(Number(review?.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) continue;

    const quote = String(review?.body ?? review?.title ?? "").trim();
    if (quote.length < MIN_QUOTE_LENGTH) continue;

    if (
      !best ||
      rating > best.rating ||
      (rating === best.rating && quote.length > best.quote.length)
    ) {
      best = {
        rating,
        quote,
        author: String(review?.username ?? "").trim() || null,
      };
    }
  }
  return best;
}

// The public feed is the same one /reviews reads, so this is a read of
// moderated content — never a write, never an entitlement decision.
let cached: ProTestimonial | null | undefined;

/**
 * Fetch the featured review for a client surface (the upgrade modal). Cached
 * per tab; a failure resolves to null, which renders no testimonial.
 */
export async function fetchFeaturedReview(): Promise<ProTestimonial | null> {
  if (cached !== undefined) return cached;
  try {
    const res = await fetch("/api/reviews?limit=12", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    cached = pickFeaturedReview(Array.isArray(data?.reviews) ? data.reviews : []);
  } catch {
    cached = null;
  }
  return cached ?? null;
}
