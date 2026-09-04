// src/app/api/user/daily-loss-limit/route.ts
//
// Responsible-play setting — the player's own daily loss limit (tokens).
//
//   GET → { limit } where limit is null (global default), 0 (disabled),
//         or a positive integer (custom threshold).
//   PUT { limit } → same three forms; strictly validated and clamped so a
//         misbehaving client can't store junk.
//
// Security: auth-required, updates only the caller's own row, integer-only.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Absolute ceiling — above this a custom limit is meaningless and would
// only ever silence warnings (soft anyway); clamp instead of reject.
const MAX_LIMIT = 10_000_000;

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const [row] = await db
    .select({ dailyLossLimit: users.dailyLossLimit })
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);

  return NextResponse.json({
    success: true,
    limit: row?.dailyLossLimit ?? null,
  });
}

export async function PUT(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  // Strict allowlist: only `limit` is accepted (null → global default,
  // 0 → warnings off, whole number → custom threshold). Unknown fields are
  // rejected rather than silently dropped.
  const parsed = await parseAndValidateJson(req, {
    limit: {
      type: "number",
      required: false,
      nullable: true,
      integer: true,
      min: 0,
      max: MAX_LIMIT,
      default: null,
    },
  });
  if (!parsed.ok) return parsed.response;

  const limit = parsed.data.limit;

  await db
    .update(users)
    .set({ dailyLossLimit: limit })
    .where(eq(users.clerkId, userId));

  return NextResponse.json({ success: true, limit });
}
