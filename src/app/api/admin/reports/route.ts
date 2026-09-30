// src/app/api/admin/reports/route.ts
// GET → fetch all player reports for the admin dashboard
// PATCH → resolve a report (mark as reviewed/resolved/dismissed)

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "../../../../lib/auth/isAdmin";
import { getNeonSql } from "../../../../db/neon";
import { decryptFieldSafe } from "../../../../lib/security/fieldEncryption";
import { adminAuditLog } from "../../../../lib/security/adminAuditLog";
import { searchNameFor } from "../../../../lib/searchName";
import { randomCleanName } from "../../../../lib/moderation/randomName";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const statusFilter = req.nextUrl.searchParams.get("status") || "";
  // Guard against a non-numeric limit param — parseInt("abc") is NaN and
  // Math.min(NaN, 200) stays NaN, which made Postgres throw on `LIMIT NaN`.
  const rawLimit = parseInt(req.nextUrl.searchParams.get("limit") || "100", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 200)
    : 100;

  try {
    const sql = getNeonSql();

    let reports;
    if (statusFilter === "pending") {
      reports = await sql`
        SELECT pr.*, 
               ru.name AS reporter_name, 
               ru.email AS reporter_email,
               rdu.name AS reported_name,
               rdu.email AS reported_email,
               rdu.is_banned AS reported_is_banned,
               -- A flagged REVIEW must arrive with the review itself, so the
               -- queue can show what was actually reported instead of a bare
               -- id. product_reviews.id is an integer while game_id also holds
               -- non-numeric ids (pool-masters uuids), so the cast is guarded
               -- by the regex instead of being applied blindly.
               prv.title AS review_title,
               prv.body AS review_body,
               prv.rating AS review_rating,
               prv.status AS review_status
        FROM player_reports pr
        LEFT JOIN users ru ON ru.clerk_id = pr.reporter_clerk_id
        LEFT JOIN users rdu ON rdu.clerk_id = pr.reported_clerk_id
        LEFT JOIN product_reviews prv
          ON pr.game_type = 'review'
         AND prv.id = CASE WHEN pr.game_id ~ '^[0-9]+$' THEN pr.game_id::int END
        WHERE pr.status = 'pending'
        ORDER BY pr.created_at DESC
        LIMIT ${limit}
      `;
    } else {
      reports = await sql`
        SELECT pr.*, 
               ru.name AS reporter_name, 
               ru.email AS reporter_email,
               rdu.name AS reported_name,
               rdu.email AS reported_email,
               rdu.is_banned AS reported_is_banned,
               -- A flagged REVIEW must arrive with the review itself, so the
               -- queue can show what was actually reported instead of a bare
               -- id. product_reviews.id is an integer while game_id also holds
               -- non-numeric ids (pool-masters uuids), so the cast is guarded
               -- by the regex instead of being applied blindly.
               prv.title AS review_title,
               prv.body AS review_body,
               prv.rating AS review_rating,
               prv.status AS review_status
        FROM player_reports pr
        LEFT JOIN users ru ON ru.clerk_id = pr.reporter_clerk_id
        LEFT JOIN users rdu ON rdu.clerk_id = pr.reported_clerk_id
        LEFT JOIN product_reviews prv
          ON pr.game_type = 'review'
         AND prv.id = CASE WHEN pr.game_id ~ '^[0-9]+$' THEN pr.game_id::int END
        ORDER BY pr.created_at DESC
        LIMIT ${limit}
      `;
    }

    // Report `details` is encrypted at rest — decrypt for the dashboard.
    const decrypted = (reports || []).map((r: any) => ({
      ...r,
      details: decryptFieldSafe(r.details),
    }));

    return NextResponse.json({ success: true, reports: decrypted });
  } catch (err: any) {
    console.error("[admin/reports] Failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch reports" },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const { reportId, status, action } = body as {
    reportId: number;
    status?: string;
    action?: string;
  };

  if (!reportId) {
    return NextResponse.json(
      { success: false, error: "Missing required field: reportId" },
      { status: 400 },
    );
  }

  // ── Rename the reported player to a fresh, neutral handle ───────────────
  // The remedy for the most common public-facing flag: a leaderboard or review
  // entry carrying an offensive name. It reuses the same generator as the
  // one-off sweep (scripts/purge-profaned-usernames.mjs), so the two can never
  // produce a name the other would reject.
  if (action === "rename") {
    try {
      const sql = getNeonSql();

      // Scoped to the player reported on THIS report, so the endpoint can never
      // be used to rename an arbitrary account.
      const rows = (await sql`
        SELECT reported_clerk_id FROM player_reports WHERE id = ${reportId} LIMIT 1
      `) as Array<{ reported_clerk_id: string | null }>;
      const reportedClerkId = rows[0]?.reported_clerk_id;

      if (!reportedClerkId) {
        return NextResponse.json(
          { success: false, error: "Report not found" },
          { status: 404 },
        );
      }

      // Confirm the generated handle is unused. A short retry loop keeps this
      // cheap on a large users table instead of loading every existing name.
      let newName: string | null = null;
      for (let attempt = 0; attempt < 10 && !newName; attempt += 1) {
        const candidate = randomCleanName();
        const clash = (await sql`
          SELECT 1 FROM users
          WHERE lower(name) = ${candidate.toLowerCase()} AND clerk_id <> ${reportedClerkId}
          LIMIT 1
        `) as Array<{ "?column?": number }>;
        if (clash.length === 0) newName = candidate;
      }

      if (!newName) {
        return NextResponse.json(
          { success: false, error: "Could not generate a unique name" },
          { status: 500 },
        );
      }

      // search_name is the friends-search match key and must move with the
      // name (src/lib/searchName.ts) — otherwise the old handle stays findable.
      await sql`
        UPDATE users
        SET name = ${newName}, search_name = ${searchNameFor(newName)}
        WHERE clerk_id = ${reportedClerkId}
      `;

      adminAuditLog("admin_report_rename_user", {
        clerkId: userId,
        targetClerkId: reportedClerkId,
        details: { reportId, newName },
      }).catch(() => {});

      return NextResponse.json({
        success: true,
        clerkId: reportedClerkId,
        name: newName,
        message: "Player renamed to " + newName,
      });
    } catch (err: any) {
      console.error("[admin/reports] rename failed:", err);
      return NextResponse.json(
        { success: false, error: "Failed to rename player" },
        { status: 500 },
      );
    }
  }

  if (!status) {
    return NextResponse.json(
      { success: false, error: "Missing required field: status" },
      { status: 400 },
    );
  }

  const validStatuses = ["reviewed", "resolved", "dismissed"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json(
      { success: false, error: "Invalid status. Must be one of: " + validStatuses.join(", ") },
      { status: 400 },
    );
  }

  try {
    const sql = getNeonSql();

    await sql`
      UPDATE player_reports
      SET status = ${status},
          resolved_at = NOW(),
          resolved_by_clerk_id = ${userId}
      WHERE id = ${reportId}
    `;

    return NextResponse.json({ success: true, message: "Report updated successfully" });
  } catch (err: any) {
    console.error("[admin/reports] PATCH failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to update report" },
      { status: 500 },
    );
  }
}
