import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";

/**
 * POST /api/titles/equip-streak
 *
 * Body: { streakType: "current" | "best" | "" }
 *   - "current": equip the streak title computed from the user's current daily streak
 *   - "best":    equip the streak title computed from the user's all-time best daily streak
 *   - "" or null: unequip the streak title
 */
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { streakType } = await request.json();
    const normalizedType = String(streakType || "").trim().toLowerCase();

    if (normalizedType !== "" && normalizedType !== "current" && normalizedType !== "best") {
      return NextResponse.json(
        { success: false, error: "Invalid streakType. Use 'current', 'best', or empty string." },
        { status: 400 },
      );
    }

    const newValue = normalizedType || null;

    if (newValue) {
      // Equipping a streak title clears every other title slot —
      // the user can only ever display one title at a time.
      await db
        .update(users)
        .set({
          selectedStreakType: newValue,
          selectedTitle: null,
          selectedSpecialTitle: null,
          showPrestigeBadge: false,
        })
        .where(eq(users.clerkId, userId));
    } else {
      await db
        .update(users)
        .set({ selectedStreakType: null })
        .where(eq(users.clerkId, userId));
    }

    return NextResponse.json({
      success: true,
      selectedStreakType: newValue,
    });
  } catch (err) {
    console.error("[EQUIP_STREAK_ERROR]", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
