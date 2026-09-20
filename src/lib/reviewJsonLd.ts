import { SITE_URL } from "./ogImages";
import type { ReviewStats } from "./reviews";

/**
 * Structured data for machines — the identity of the site and, most
 * importantly for AI answer engines, the player rating.
 *
 * Two rules this file exists to enforce:
 *
 * 1. NEVER INVENT A RATING. Every number is derived from approved,
 *    moderated reviews (src/lib/reviews.ts). No approved reviews means these
 *    builders return `null` and no markup is emitted at all — a hardcoded or
 *    placeholder score is exactly the kind of thing that gets structured data
 *    distrusted (and, with Google, earns a manual action).
 *
 * 2. ONE ENTITY, REFERENCED BY @id. The rating on the home page and the rating
 *    on the reviews page describe the same thing (`#app`), so a crawler merges
 *    them instead of seeing two competing claims.
 *
 * Note on eligibility: the reviews are of GRYND itself, collected from
 * verified players on GRYND. Google treats first-party reviews of your own
 * organisation as "self-serving" and will not show star rich results for
 * them — that is Google's policy, not a defect here, and the markup is still
 * what an AI answer engine reads to decide whether the site is well regarded.
 * Attaching it to the application entity (rather than the Organization node)
 * keeps it a review of a product.
 */

/** Stable ids so separate JSON-LD blocks describe one linked graph. */
export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;
export const APP_ID = `${SITE_URL}/#app`;

const APP_NAME = "GRYND";

export interface ReviewLike {
  rating: number;
  title: string | null;
  body: string | null;
  createdAt: string;
  username: string | null;
}

export interface JsonLdNode {
  [key: string]: unknown;
}

/**
 * The rating a machine is allowed to repeat, or null when there is nothing
 * real to report.
 */
export function buildAggregateRating(stats: ReviewStats | null | undefined): JsonLdNode | null {
  const count = Math.max(0, Math.floor(Number(stats?.count ?? 0)));
  const value = Number(stats?.average ?? 0);
  if (count <= 0 || !Number.isFinite(value) || value <= 0) return null;

  const clamped = Math.min(5, Math.max(1, value));
  return {
    "@type": "AggregateRating",
    // One decimal, matching what the wall shows a visitor.
    ratingValue: clamped.toFixed(1),
    reviewCount: count,
    bestRating: 5,
    worstRating: 1,
  };
}

/** One approved review as a schema.org Review node. */
export function buildReviewNode(review: ReviewLike): JsonLdNode {
  const rating = Math.min(5, Math.max(1, Math.round(Number(review.rating) || 1)));
  const published = new Date(review.createdAt);
  const datePublished = Number.isNaN(published.getTime())
    ? undefined
    : published.toISOString().slice(0, 10);

  return {
    "@type": "Review",
    author: { "@type": "Person", name: review.username?.trim() || "Verified player" },
    reviewRating: { "@type": "Rating", ratingValue: rating, bestRating: 5, worstRating: 1 },
    ...(datePublished ? { datePublished } : {}),
    ...(review.title?.trim() ? { name: review.title.trim() } : {}),
    ...(review.body?.trim() ? { reviewBody: review.body.trim() } : {}),
  };
}

/**
 * The application plus its real rating (and up to `maxReviews` published
 * review bodies when the caller passes them). Returns null when there is no
 * approved rating to report.
 */
export function buildAppJsonLd({
  stats,
  reviews = [],
  maxReviews = 10,
}: {
  stats: ReviewStats | null | undefined;
  reviews?: ReviewLike[];
  maxReviews?: number;
}): JsonLdNode | null {
  const aggregateRating = buildAggregateRating(stats);
  if (!aggregateRating) return null;

  // Only reviews that actually say something are worth marking up — a bare
  // star with no text adds nothing a crawler can quote.
  const nodes = reviews
    .filter((r) => Boolean(r.body?.trim() || r.title?.trim()))
    .slice(0, maxReviews)
    .map(buildReviewNode);

  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": APP_ID,
    name: APP_NAME,
    applicationCategory: "GameApplication",
    operatingSystem: "Web browser",
    url: `${SITE_URL}/`,
    // The application is owned/published by the organisation node in the
    // layout, so the whole graph hangs together.
    publisher: { "@id": ORGANIZATION_ID },
    aggregateRating,
    ...(nodes.length ? { review: nodes } : {}),
  };
}

/** The site itself: name, canonical URL, language, publisher. */
export function buildWebsiteJsonLd(): JsonLdNode {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: APP_NAME,
    url: `${SITE_URL}/`,
    inLanguage: "en",
    publisher: { "@id": ORGANIZATION_ID },
  };
}
