import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../../db";
import { productReviews, users } from "../../../../db/schema";
import { isAdmin } from "../../../../lib/auth/isAdmin";
import { adminAuditLog } from "../../../../lib/security/adminAuditLog";
import { captureServerEvent } from "../../../../lib/analytics-server";

export const runtime = "nodejs";

const VALID_STATUSES = ["pending", "approved", "rejected"];

/**
 * GET /api/admin/reviews?status=pending — moderation queue with reviewer
 * names. Admin-only (enforced here + middleware MFA gate on /api/admin).
 */
export async function GET(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    if (!(await isAdmin(userId)))
      return NextResponse.json({ success: false, error: "Forbidden. Admin access required" }, { status: 403 });

    const status = new URL(req.url).searchParams.get("status") ?? undefined;
    const conditions = status && VALID_STATUSES.includes(status) ? [eq(productReviews.status, status)] : [];

    const reviews = await db
      .select({
        id: productReviews.id,
        userId: productReviews.userId,
        rating: productReviews.rating,
        title: productReviews.title,
        body: productReviews.body,
        game: productReviews.game,
        status: productReviews.status,
        createdAt: productReviews.createdAt,
        moderatedAt: productReviews.moderatedAt,
        username: users.name,
        email: users.email,
      })
      .from(productReviews)
      .innerJoin(users, eq(productReviews.userId, users.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(productReviews.createdAt));

    const counts = await db
      .select({
        status: productReviews.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(productReviews)
      .groupBy(productReviews.status)
      .then((rows) =>
        rows.reduce<Record<string, number>>((acc, r) => {
          acc[r.status] = Number(r.count);
          return acc;
        }, {}),
      );

    return NextResponse.json({ success: true, reviews, counts });
  } catch (err) {
    console.error("[admin:reviews] GET error:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/reviews — { id, status: approved|rejected } or
 * { id, action: "delete" }. Audit-logged.
 */
export async function PATCH(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    if (!(await isAdmin(userId)))
      return NextResponse.json({ success: false, error: "Forbidden. Admin access required" }, { status: 403 });

    const { id, status, action } = await req.json();
    const reviewId = Number(id);
    if (!Number.isInteger(reviewId)) {
      return NextResponse.json({ success: false, error: "Invalid review id" }, { status: 400 });
    }

    if (action === "delete") {
      await db.delete(productReviews).where(eq(productReviews.id, reviewId));
      adminAuditLog("admin_review_deleted", { clerkId: userId, details: { reviewId } }).catch(() => {});
      return NextResponse.json({ success: true });
    }

    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ success: false, error: `Invalid status. Valid: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
    }

    // Resolve the reviewer's clerk id so the funnel event lands on the
    // right person profile.
    const target = await db
      .select({ clerkId: users.clerkId })
      .from(productReviews)
      .innerJoin(users, eq(productReviews.userId, users.id))
      .where(eq(productReviews.id, reviewId))
      .limit(1)
      .then((r) => r[0]);

    await db
      .update(productReviews)
      .set({
        status,
        moderatedAt: new Date(),
        moderatedByClerkId: userId,
      })
      .where(eq(productReviews.id, reviewId));

    if (target?.clerkId) {
      captureServerEvent({
        event: status === "approved" ? "review_approved" : "review_rejected",
        distinctId: target.clerkId,
        properties: { reviewId },
      });
    }

    adminAuditLog("admin_review_moderated", { clerkId: userId, details: { reviewId, status } }).catch(() => {});
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[admin:reviews] PATCH error:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
