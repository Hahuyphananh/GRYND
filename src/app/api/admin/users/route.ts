// src/app/api/admin/users/route.ts
// GET  ?search=...  → search users by clerkId, name, or email
// GET  ?admins=1   → list all admin users (team overview)
// Must be an admin to use this endpoint.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { ilike, or, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { isAdmin } from "../../../../lib/auth/isAdmin";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(userId))) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const search = req.nextUrl.searchParams.get("search") || "";
  const adminsOnly = req.nextUrl.searchParams.get("admins") === "1";
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "20", 10), 50);

  try {
    const columns = {
      id: users.id,
      clerkId: users.clerkId,
      name: users.name,
      email: users.email,
      isAdmin: users.isAdmin,
    };

    let rows;

    if (adminsOnly) {
      // List all admin users (team overview)
      rows = await db
        .select(columns)
        .from(users)
        .where(eq(users.isAdmin, true))
        .orderBy(users.name)
        .limit(limit);
    } else if (search.trim()) {
      const term = `%${search.trim()}%`;
      rows = await db
        .select(columns)
        .from(users)
        .where(
          or(
            ilike(users.clerkId, term),
            ilike(users.name, term),
            ilike(users.email, term),
          ),
        )
        .limit(limit);
    } else {
      rows = await db
        .select(columns)
        .from(users)
        .limit(limit);
    }

    return NextResponse.json({ success: true, users: rows });
  } catch (err: any) {
    console.error("[admin/users] Search failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to search users" },
      { status: 500 },
    );
  }
}
