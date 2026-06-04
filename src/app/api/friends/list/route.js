import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import { computeEquippedStreakTitle } from "../../../../lib/streakTitles";

export async function GET() {
  const sql = getNeonSql();
  try {
    const { userId } = await auth();

    if (!userId) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    // 👤 Get current user (Neon returns array)
    const current = await sql`
      SELECT id
      FROM users
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;

    if (!current.length) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    const meId = Number(current[0].id);

    // 👥 Get friends — include streak info and title info
    const friends = await sql`
      SELECT 
        u.id, 
        u.clerk_id,
        u.name, 
        u.profile_picture,
        u.daily_streak_current,
        u.daily_streak_best,
        u.selected_streak_type,
        u.selected_title,
        u.selected_special_title
      FROM friend_relations fr
      JOIN users u ON u.id = fr.friend_id
      WHERE fr.user_id = ${meId}
      ORDER BY u.name ASC, u.id ASC
    `;

    // Compute streak titles for each friend
    const friendsWithStreak = friends.map((f) => {
      const streakInfo = computeEquippedStreakTitle({
        selectedStreakType: f.selected_streak_type,
        dailyStreakCurrent: f.daily_streak_current,
        dailyStreakBest: f.daily_streak_best,
      });
      return {
        ...f,
        streakTitle: streakInfo.title,
      };
    });

    return new Response(
      JSON.stringify({
        success: true,
        friends: friendsWithStreak,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[FRIENDS_LIST_ERROR]", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to load friends",
        friends: [],
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
