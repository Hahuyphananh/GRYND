import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { yahtzeeActions } from "../../../../db/schema";
import { requireUser } from "../_lib";

export async function GET(req) {
  try {
    await requireUser();
    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get("roomId");
    if (!roomId) throw new Error("roomId required");

    const actions = await db
      .select()
      .from(yahtzeeActions)
      .where(eq(yahtzeeActions.roomId, roomId))
      .orderBy(asc(yahtzeeActions.createdAt))
      .limit(200);

    return NextResponse.json({ success: true, actions });
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: e.message || "Failed to fetch history",
    }, { status: 400 });
  }
}
