import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { productReviews, users } from "../db/schema";

/**
 * Shared reads for the public review wall.
 *
 * The reviews page and GET /api/reviews need exactly the same two queries —
 * one for the approved reviews, one for the aggregate — and they must never
 * disagree: the page renders the rating totals into its structured data, while
 * the API feeds the interactive wall. Keeping them in one place means the
 * markup a crawler reads is always computed from the same rows as the numbers
 * a visitor sees, and neither can drift into claiming a rating that isn't
 * backed by approved reviews.
 */

/** A publicly visible, moderated review — the JSON shape the wall consumes. */
export interface PublicReview {
  id: number;
  rating: number;
  title: string | null;
  body: string | null;
  game: string | null;
  /** ISO string (the wall renders it with the deterministic formatReviewDate). */
  createdAt: string;
  username: string | null;
  iconKey: string | null;
}

export interface ReviewStats {
  /** Average to one decimal, as a string — e.g. "4.6". "0.0" when empty. */
  average: string;
  count: number;
  /** rating (1–5) → how many approved reviews gave it. */
  distribution: Record<number, number>;
}

/** Newest approved reviews, newest first. */
export async function getApprovedReviews(limit = 12): Promise<PublicReview[]> {
  const rows = await db
    .select({
      id: productReviews.id,
      rating: productReviews.rating,
      title: productReviews.title,
      body: productReviews.body,
      game: productReviews.game,
      createdAt: productReviews.createdAt,
      username: users.name,
      // Official Grynd icon key for the reviewer's avatar (never an arbitrary
      // profile-image URL).
      iconKey: users.selectedIcon,
    })
    .from(productReviews)
    .innerJoin(users, eq(productReviews.userId, users.id))
    .where(eq(productReviews.status, "approved"))
    .orderBy(desc(productReviews.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }));
}

/** Aggregate of every approved review (not just the page of them). */
export async function getReviewStats(): Promise<ReviewStats> {
  const stats = await db
    .select({
      avg: sql<number>`COALESCE(AVG(rating), 0)`,
      count: sql<number>`COUNT(*)`,
      one: sql<number>`COUNT(*) FILTER (WHERE rating = 1)`,
      two: sql<number>`COUNT(*) FILTER (WHERE rating = 2)`,
      three: sql<number>`COUNT(*) FILTER (WHERE rating = 3)`,
      four: sql<number>`COUNT(*) FILTER (WHERE rating = 4)`,
      five: sql<number>`COUNT(*) FILTER (WHERE rating = 5)`,
    })
    .from(productReviews)
    .where(eq(productReviews.status, "approved"))
    .then((r) => r[0]);

  return {
    average: Number(stats?.avg ?? 0).toFixed(1),
    count: Number(stats?.count ?? 0),
    distribution: {
      1: Number(stats?.one ?? 0),
      2: Number(stats?.two ?? 0),
      3: Number(stats?.three ?? 0),
      4: Number(stats?.four ?? 0),
      5: Number(stats?.five ?? 0),
    },
  };
}

// ── Aggregate for pages that only need the score ───────────────────────────
// The home page advertises the same rating as the reviews page, but it should
// not pay for a database round trip on every render — and it must never break
// because the reviews table is slow or unreachable. A short in-process cache
// keeps it to roughly one query per instance per five minutes, and any failure
// degrades to "no rating markup" rather than a broken page.
const AGGREGATE_TTL_MS = 5 * 60 * 1000;
let aggregateCache: { value: ReviewStats | null; at: number } | null = null;

export async function getReviewAggregate(): Promise<ReviewStats | null> {
  const now = Date.now();
  if (aggregateCache && now - aggregateCache.at < AGGREGATE_TTL_MS) {
    return aggregateCache.value;
  }
  try {
    const value = await getReviewStats();
    aggregateCache = { value, at: now };
    return value;
  } catch {
    // Unavailable reviews must not take the page down with them. Cache the
    // failure briefly so a slow database isn't hit once per request.
    aggregateCache = { value: null, at: now };
    return null;
  }
}
