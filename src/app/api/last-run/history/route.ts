import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { readLastRunHistory } from "../../../../lib/last-run/queries";

export const dynamic = "force-dynamic";

/**
 * GET /api/last-run/history?page=1&limit=20
 *
 * The viewer's own completed LAST RUN matches, newest first, in viewer
 * perspective (`result` is win/loss/draw FOR THE CALLER). Only durable rows
 * exist here: a match that never completed has no row, so this can never show a
 * fabricated or in-flight result.
 *
 * Auth is Clerk's session — the Clerk id comes from the verified session, never
 * from the query string, so there is no way to request another player's
 * history.
 */
export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));

  try {
    const data = await readLastRunHistory(userId, { page, limit });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[last-run/history] read failed:", error);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
