import { and, desc, eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { availabilityAlerts } from "../../../db/schema";

export const dynamic = "force-dynamic";

function jsonError(error: string, status: number) {
  return NextResponse.json({ success: false, error }, { status });
}

async function currentUser() {
  const { userId } = await auth();
  return userId;
}

export async function GET() {
  const userId = await currentUser();
  if (!userId) return jsonError("Unauthorized", 401);

  const alerts = await db
    .select()
    .from(availabilityAlerts)
    .where(eq(availabilityAlerts.userId, userId))
    .orderBy(desc(availabilityAlerts.createdAt));
  return NextResponse.json({ success: true, alerts });
}

export async function POST(req: NextRequest) {
  const userId = await currentUser();
  if (!userId) return jsonError("Unauthorized", 401);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid JSON body", 400);

  const minPlayerCount = Number(body.minPlayerCount ?? 1);
  const maxWaitMs = body.maxWaitMs == null ? null : Number(body.maxWaitMs);
  if (!Number.isInteger(minPlayerCount) || minPlayerCount < 1) {
    return jsonError("minPlayerCount must be a positive integer", 400);
  }
  if (maxWaitMs !== null && (!Number.isInteger(maxWaitMs) || maxWaitMs <= 0)) {
    return jsonError("maxWaitMs must be a positive integer", 400);
  }

  const [alert] = await db
    .insert(availabilityAlerts)
    .values({
      userId,
      gameKey: body.gameKey == null ? null : String(body.gameKey),
      mode: body.mode == null ? null : String(body.mode),
      region: body.region == null ? null : String(body.region),
      minPlayerCount,
      maxWaitMs,
      expiresAt: body.expiresAt ? new Date(String(body.expiresAt)) : null,
    })
    .returning();
  return NextResponse.json({ success: true, alert }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const userId = await currentUser();
  if (!userId) return jsonError("Unauthorized", 401);
  const body = await req.json().catch(() => null);
  const alertId = String(body?.alertId ?? "");
  if (!alertId) return jsonError("alertId is required", 400);

  const [alert] = await db
    .update(availabilityAlerts)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(availabilityAlerts.id, alertId), eq(availabilityAlerts.userId, userId)))
    .returning();
  if (!alert) return jsonError("Alert not found", 404);
  return NextResponse.json({ success: true, alert });
}
