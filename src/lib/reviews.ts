import { and, desc, eq, sql } from "drizzle-orm";
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
  /**
   * Clerk id of the reviewer.
   *
   * Included so the public wall can file a report against the REVIEWER when a
   * review is flagged (POST /api/reports/submit needs a reportedClerkId). This
   * is not new information: public profile URLs are /profil/<clerkId> and the
   * weekly leaderboard already ships clerk ids to signed-out clients.
   */
  clerkId: string | null;
}

export interface ReviewStats {
  /** Average to one decimal, as a string — e.g. "4.6". "0.0" when empty. */
  average: string;
  count: number;
  /** rating (1–5) → how many approved reviews gave it. */
  distribution: Record<number, number>;
}

// ── Placeholder reviews are never public ───────────────────────────────────
// This table was hand-seeded during development, and one placeholder row
// (title "Test review", body "Test") was approved and left live on /reviews —
// a fake review, credited to a "Verified player", sitting on a public marketing
// page. A moderation queue does not catch that, because the row was approved on
// purpose, so the public read path refuses placeholder content outright.
//
// A review is treated as a placeholder only when BOTH fields are empty or
// nothing but a placeholder token. A real review — however terse — keeps at
// least one field with actual words, so it is never hidden. The same rule is
// applied by a database cleanup (migration 0194) and by the SQL twin below, so
// the wall, the aggregate and the JSON-LD all agree on what is publishable.

export const PLACEHOLDER_REVIEW_VALUES = [
  "test",
  "testreview",
  "testing",
  "testtest",
  "asdf",
  "asdfasdf",
  "foo",
  "bar",
  "baz",
  "sample",
  "samplesample",
  "placeholder",
  "dummy",
  "loremipsum",
  "hello",
  "helloworld",
  "hi",
  "abc",
  "abcabc",
  "xyz",
  "qwerty",
  "aaa",
  "bbb",
];

/** Lowercase a review field and drop everything that is not a letter or digit. */
export function normalizeReviewField(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** True when a field is empty or is nothing but a known placeholder token. */
export function isPlaceholderReviewField(value: unknown): boolean {
  const normalized = normalizeReviewField(value);
  return normalized === "" || PLACEHOLDER_REVIEW_VALUES.includes(normalized);
}

/**
 * True when a review carries no real content at all.
 *
 * Both fields must be placeholder-or-empty; a single field with real words is
 * enough to keep the review publishable.
 */
export function isPlaceholderReview(review: {
  title?: unknown;
  body?: unknown;
}): boolean {
  return (
    isPlaceholderReviewField(review?.title) && isPlaceholderReviewField(review?.body)
  );
}

// SQL twin of `isPlaceholderReview`. The values are code-owned lowercase
// alphanumerics, so inlining them is safe (and `sql.raw` keeps them out of the
// parameter list, where an `IN` with a parameter array would not work).
const PLACEHOLDER_VALUES_SQL = sql.raw(
  `(${PLACEHOLDER_REVIEW_VALUES.map((value) => `'${value}'`).join(", ")})`,
);

const titleKey = sql`regexp_replace(lower(coalesce(${productReviews.title}, '')), '[^a-z0-9]', '', 'g')`;
const bodyKey = sql`regexp_replace(lower(coalesce(${productReviews.body}, '')), '[^a-z0-9]', '', 'g')`;

const NOT_PLACEHOLDER_REVIEW = sql`NOT ((${titleKey} = '' OR ${titleKey} IN ${PLACEHOLDER_VALUES_SQL}) AND (${bodyKey} = '' OR ${bodyKey} IN ${PLACEHOLDER_VALUES_SQL}))`;

/** Approved AND not a placeholder — the only rows that may be published. */
const PUBLISHABLE = and(
  eq(productReviews.status, "approved"),
  NOT_PLACEHOLDER_REVIEW,
);

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
      // Identity of the reviewer, for the report-this-review action.
      clerkId: users.clerkId,
    })
    .from(productReviews)
    .innerJoin(users, eq(productReviews.userId, users.id))
    .where(PUBLISHABLE)
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
    .where(PUBLISHABLE)
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
