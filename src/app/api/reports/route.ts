import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db";
import { playerReports } from "../../../db/schema";

const REPORT_REASONS = new Set(["toxic_player", "hacker", "inappropriate_name", "inappropriate_profile_picture", "other"]);

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

  const reportedClerkId = String(body?.reportedClerkId || "").trim();
  const gameKey = String(body?.gameKey || "").trim().slice(0, 80);
  const gameId = body?.gameId == null ? null : String(body.gameId).trim().slice(0, 120);
  const reason = String(body?.reason || "").trim();
  const details = String(body?.details || "").trim().slice(0, 1000);

  if (!reportedClerkId || !gameKey || !REPORT_REASONS.has(reason)) {
    return NextResponse.json({ success: false, error: "Reported player, game, and reason are required" }, { status: 400 });
  }
  if (reportedClerkId === userId) {
    return NextResponse.json({ success: false, error: "You cannot report yourself" }, { status: 400 });
  }

  try {
    const [report] = await db.insert(playerReports).values({
      reporterClerkId: userId,
      reportedClerkId,
      gameKey,
      gameId,
      reason: reason as any,
      details: details || null,
    }).returning({ id: playerReports.id });
    return NextResponse.json({ success: true, reportId: report.id });
  } catch (err) {
    console.error("[reports] Failed to create report:", err);
    return NextResponse.json({ success: false, error: "Failed to submit report" }, { status: 500 });
  }
}
