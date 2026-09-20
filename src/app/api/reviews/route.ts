import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { productReviews, users } from "../../../db/schema";
import { captureServerEvent } from "../../../lib/analytics-server";
import { parseAndValidateJson } from "../../../lib/security/validation";
// Shared with the server-rendered /reviews page, so the numbers the wall shows
// and the numbers in its structured data can never drift apart.
import { getApprovedReviews, getReviewStats } from "../../../lib/reviews";

export const runtime = "nodejs";

const MAX_BODY = 2000;
const MAX_TITLE = 120;
const MAX_GAME = 50;

/**
 * POST /api/reviews — submit a review (one per user; upsert replaces the
 * user's previous review). New/edited reviews start as `pending` for
 * moderation. Requires sign-in.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    // Strict allowlist: only rating / title / body / game are accepted. A
    // client cannot smuggle moderation or identity fields (status,
    // userId, approvedBy, ...) — every row is created as "pending" and
    // keyed to the authenticated user below.
    const parsed = await parseAndValidateJson(req, {
      rating: { type: "number", required: true, integer: true, min: 1, max: 5 },
      title: { type: "string", required: false, maxLength: MAX_TITLE, default: null },
      body: { type: "string", required: false, maxLength: MAX_BODY, default: null },
      game: { type: "string", required: false, maxLength: MAX_GAME, default: null },
    });
    if (!parsed.ok) return parsed.response;

    const rating = parsed.data.rating;
    const title = parsed.data.title || null;
    const body = parsed.data.body || null;
    const game = parsed.data.game || null;

    // Resolve the local user row (reviews are keyed by users.id for cascade).
    const row = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1)
      .then((r) => r[0]);
    if (!row) {
      return NextResponse.json(
        { success: false, error: "Account not found. Please try again shortly." },
        { status: 409 },
      );
    }

    // Upsert: one review per user — submitting again replaces it (pending again).
    const inserted = await db
      .insert(productReviews)
      .values({
        userId: row.id,
        rating,
        title,
        body,
        game,
        status: "pending",
      })
      .onConflictDoUpdate({
        target: productReviews.userId,
        set: {
          rating,
          title,
          body,
          game,
          status: "pending",
          moderatedAt: null,
          moderatedByClerkId: null,
        },
      })
      .returning({ id: productReviews.id, status: productReviews.status });

    // Marketing funnel: every submission enters the review funnel. The
    // admin-approval event (below) completes it — signup → first game →
    // review submitted → review approved.
    captureServerEvent({
      event: "review_submitted",
      distinctId: userId,
      properties: { rating, game: game ?? null, reviewId: inserted[0]?.id ?? null },
    });

    return NextResponse.json({
      success: true,
      review: inserted[0],
      message: "Thanks! Your review is pending moderation and will appear once approved.",
    });
  } catch (err) {
    console.error("[api/reviews] POST error:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/**
 * GET /api/reviews?limit=12 — public wall: approved reviews with aggregate
 * stats. Optionally ?mine=1 adds the signed-in user's own review status
 * (used by the UI to know whether to show the "leave a review" prompt).
 */
export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(50, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 12));
    const mine = new URL(req.url).searchParams.get("mine") === "1";

    const [approved, stats] = await Promise.all([
      getApprovedReviews(limit),
      getReviewStats(),
    ]);

    let mineStatus: { submitted: boolean; status: string | null; rating: number | null } | null = null;
    if (mine) {
      const { userId } = await auth();
      if (userId) {
        const mineRow = await db
          .select({ status: productReviews.status, rating: productReviews.rating })
          .from(productReviews)
          .innerJoin(users, eq(productReviews.userId, users.id))
          .where(and(eq(users.clerkId, userId)))
          .limit(1)
          .then((r) => r[0]);
        mineStatus = mineRow
          ? { submitted: true, status: mineRow.status, rating: mineRow.rating }
          : { submitted: false, status: null, rating: null };
      }
    }

    return NextResponse.json({
      success: true,
      reviews: approved,
      stats,
      mine: mineStatus,
    });
  } catch (err) {
    console.error("[api/reviews] GET error:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
